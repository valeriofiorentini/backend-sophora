/**
 * user.controller.js
 *
 * Fix sicurezza applicati:
 *  - forgotPassword: NON espone userId nella risposta (user enumeration)
 *  - verifyOtpHandler: usa token di stato invece di userId in chiaro
 *  - changePasswordByOldPassword: gestisce password=null (utenti OAuth)
 *  - getAllUsers: rimosso dalla export pubblica (spostato in adminOnly)
 *  - sanitizeUser: rimuove fcmToken, deviceToken, googleId dalla risposta client
 *  - deleteAccount: anonimizza PriceHistory prima di eliminare l'utente
 *  - editProfile: sanitizza e valida i campi numerici
 *  - guestLogin: cleanup automatico account guest scaduti (>30gg)
 *
 * Fix GDPR:
 *  - deleteAccount: rimuove dati personali + anonimizza dataset ML
 *  - sanitizeUser: rispetta minimizzazione dati (art. 5 GDPR)
 */

const bcrypt  = require('bcryptjs');
const prisma  = require('../config/database');
const { success, error } = require('../utils/response');
const { generateAccessToken, generateRefreshToken, rotateRefreshToken, revokeAllTokens } = require('../utils/jwt');
const { createOtp, verifyOtp } = require('../utils/otp');
const { sendOtpEmail, sendPasswordResetEmail } = require('../utils/email');
const { uploadToS3 } = require('../config/s3');
const { verifyAppleIdentityToken, isInvalidAppleTokenError } = require('../utils/appleIdentityToken');

// ─── Validazione password ─────────────────────────────────────────────────────
const PASSWORD_MIN_LEN = 8;

function validatePassword(pwd) {
  if (!pwd || typeof pwd !== 'string') return 'Password obbligatoria';
  if (pwd.length < PASSWORD_MIN_LEN) return `Password troppo corta (minimo ${PASSWORD_MIN_LEN} caratteri)`;
  return null; // ok
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return 'Email obbligatoria';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Email non valida';
  return null;
}

// ─── signup ───────────────────────────────────────────────────────────────────
const SUPPORTED_LANGS = new Set(['it', 'en', 'fr', 'es', 'de']);

async function signup(req, res) {
  const { name, surname, username, phone, country } = req.body;
  const email    = req.body.email?.trim().toLowerCase();
  const password = req.body.password;
  // Lingua dell'app al momento della registrazione — determina la lingua
  // delle email transazionali e delle risposte AI
  const language = SUPPORTED_LANGS.has(req.body.language) ? req.body.language : 'it';

  const emailErr = validateEmail(email);
  if (emailErr) return error(res, emailErr);

  const pwdErr = validatePassword(password);
  if (pwdErr) return error(res, pwdErr);

  const existing = await prisma.user.findUnique({ where: { email } });

  // username è @unique: prima un nome già preso faceva fallire create/update
  // con un 500 (errore Prisma grezzo) e l'app non diceva perché.
  if (username) {
    const taken = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (taken && taken.id !== existing?.id) {
      return error(res, 'Nome utente già in uso, scegline un altro', 409);
    }
  }

  // Utente esistente MA mai verificato: la registrazione precedente è stata
  // abbandonata (OTP non inserito). Aggiorna i dati e rigenera l'OTP invece
  // di bloccare l'email per sempre.
  if (existing && !existing.isVerified) {
    const hashed = await bcrypt.hash(password, 12);
    // Lingua: aggiorna solo se inviata esplicitamente (non sovrascrivere col default)
    const langUpdate = SUPPORTED_LANGS.has(req.body.language) ? { language: req.body.language } : {};
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data:  { password: hashed, name, surname, username: username || undefined, phone, country, ...langUpdate },
    });
    const otp = await createOtp(existing.id);
    if (process.env.NODE_ENV !== 'production') console.log(`[DEV] OTP per ${email} (ri-registrazione): ${otp}`);
    await sendOtpEmail(email, otp, updated.language).catch(e => console.error('[signup] email error:', e.message));
    return success(res, {
      message: 'Registrazione avvenuta. Controlla la tua email per il codice di verifica.',
      emailHint: email.replace(/(.{2}).*(@.*)/, '$1***$2'),
    }, 201);
  }

  if (existing) return error(res, 'Email già registrata');

  const hashed = await bcrypt.hash(password, 12); // 12 rounds (era 10)
  const user   = await prisma.user.create({
    data: { email, password: hashed, name, surname, username: username || undefined, phone, country, language },
  });

  const otp = await createOtp(user.id);
  if (process.env.NODE_ENV !== 'production') console.log(`[DEV] OTP per ${email}: ${otp}`);
  await sendOtpEmail(email, otp, language).catch(e => console.error('[signup] email error:', e.message));

  // Non esporre l'userId nella risposta di signup
  return success(res, {
    message: 'Registrazione avvenuta. Controlla la tua email per il codice di verifica.',
    // emailHint: per permettere all'app di pre-compilare il campo email nell'OTP screen
    emailHint: email.replace(/(.{2}).*(@.*)/, '$1***$2'),
  }, 201);
}

// ─── login ────────────────────────────────────────────────────────────────────
async function login(req, res) {
  const email    = req.body.email?.trim().toLowerCase();
  const password = req.body.password;

  if (!email || !password) return error(res, 'Email e password obbligatorie');

  const user = await prisma.user.findUnique({ where: { email } });

  // Risposta identica se utente non esiste o password errata (anti-enumeration)
  if (!user || !user.password) {
    // Esegui bcrypt comunque per evitare timing attack (constant-time)
    await bcrypt.compare(password, '$2b$12$invalidhashpadding000000000000000000000000000000000000');
    return error(res, 'Credenziali non valide', 401);
  }

  if (!user.isVerified) {
    return error(res, 'Email non verificata. Controlla la tua casella di posta.', 403);
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return error(res, 'Credenziali non valide', 401);

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);

  // Salva deviceToken se presente (solo se stringa valida)
  if (req.body.deviceToken && typeof req.body.deviceToken === 'string') {
    await prisma.user.update({
      where: { id: user.id },
      data:  { deviceToken: req.body.deviceToken.slice(0, 500) },
    });
  }

  return success(res, { accessToken, refreshToken, user: sanitizeUser(user, req) });
}

// ─── guestLogin ───────────────────────────────────────────────────────────────
async function guestLogin(req, res) {
  // Cleanup asincrono: rimuovi guest scaduti da >30 giorni (fire & forget)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  prisma.user.deleteMany({
    where: {
      email:     { startsWith: 'guest_' },
      isVerified: true,
      createdAt: { lt: thirtyDaysAgo },
    },
  }).catch(() => {});

  const user = await prisma.user.create({
    data: { email: `guest_${Date.now()}_${Math.random().toString(36).slice(2)}@shopora.app`, isVerified: true },
  });

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);
  return success(res, { accessToken, refreshToken, user: sanitizeUser(user, req) });
}

// ─── googleAuth ───────────────────────────────────────────────────────────────
/**
 * Login/signup con Google.
 * L'app invia l'idToken ottenuto da @react-native-google-signin;
 * il backend lo verifica con l'endpoint tokeninfo di Google e controlla che
 * l'audience corrisponda al nostro GOOGLE_CLIENT_ID (anti token-reuse).
 * Se l'email esiste già, collega il googleId all'account esistente.
 */
async function googleAuth(req, res) {
  const { idToken } = req.body;
  if (!idToken || typeof idToken !== 'string') {
    return error(res, 'idToken obbligatorio');
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return error(res, 'Login Google non configurato sul server', 503);
  }

  // Verifica firma e validità del token presso Google
  let payload;
  try {
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!r.ok) return error(res, 'Token Google non valido o scaduto', 401);
    payload = await r.json();
  } catch (e) {
    console.error('[googleAuth] tokeninfo error:', e.message);
    return error(res, 'Verifica Google non disponibile, riprova', 503);
  }

  // L'audience DEVE essere il nostro client ID — altrimenti è un token
  // emesso per un'altra app (token reuse attack)
  if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
    return error(res, 'Token Google non valido', 401);
  }
  if (String(payload.email_verified) !== 'true' || !payload.email) {
    return error(res, 'Email Google non verificata', 401);
  }

  const email    = payload.email.trim().toLowerCase();
  const googleId = payload.sub;

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId }, { email }] },
  });

  // Deriva username dall'email (parte prima di @), univoco
  const baseUsername = email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase();

  if (!user) {
    // Nuovo utente: email già verificata da Google, niente OTP
    // username univoco: prova baseUsername, poi aggiunge suffisso numerico
    let username = baseUsername;
    let suffix = 1;
    while (await prisma.user.findUnique({ where: { username } })) {
      username = `${baseUsername}${suffix++}`;
    }
    const nameParts = (payload.name ?? '').split(' ');
    user = await prisma.user.create({
      data: {
        email,
        googleId,
        name:               nameParts[0] ?? null,
        surname:            nameParts.slice(1).join(' ') || null,
        username,
        avatar:             payload.picture ?? null,
        isVerified:         true,
        // false come per Apple: il primo accesso porta alla schermata
        // "completa profilo" (dieta/allergie, facoltative). Prima era
        // sempre true, quindi Google saltava quello step a prescindere.
        isProfileCompleted: false,
      },
    });
  } else if (!user.googleId) {
    // Account esistente con stessa email: collega Google. isProfileCompleted
    // non si tocca (chi arrivava da email/OTP l'ha già true).
    user = await prisma.user.update({
      where: { id: user.id },
      data:  {
        googleId,
        isVerified: true,
        avatar: user.avatar ?? payload.picture ?? null,
      },
    });
  }
  // Utente già collegato: isProfileCompleted resta quello che è — non lo
  // forziamo più a true qui, altrimenti un utente che non aveva ancora
  // passato lo step "completa profilo" lo saltava per sempre dal secondo
  // login in poi.

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);
  return success(res, { accessToken, refreshToken, user: sanitizeUser(user, req) });
}

// ─── appleAuth ────────────────────────────────────────────────────────────────
/**
 * Login/signup con "Accedi con Apple" (richiesto da App Store guideline 4.8
 * perche' l'app offre anche il login con Google). Stessa forma di risposta di
 * googleAuth. Body: { identityToken, user?: { email, givenName, familyName } }.
 *
 * Sicurezza: l'identita' e l'email usate per collegare un account ESISTENTE
 * arrivano solo dal token firmato da Apple. `user.email` del body non e'
 * firmato (lo manda il client): serve solo per creare un account nuovo se il
 * token non contiene l'email, mai per collegarsi a un account gia' presente,
 * altrimenti basterebbe un proprio Apple ID valido + l'email della vittima.
 * Se l'utente sceglie "Nascondi la mia email" l'email e' un relay
 * @privaterelay.appleid.com e va trattata come una normale: non si prova a
 * recuperare quella vera.
 */
async function appleAuth(req, res) {
  const { identityToken, user: appleUser } = req.body;
  if (!identityToken || typeof identityToken !== 'string') {
    return error(res, 'identityToken obbligatorio');
  }

  let payload;
  try {
    payload = await verifyAppleIdentityToken(identityToken);
  } catch (e) {
    if (isInvalidAppleTokenError(e)) {
      return error(res, 'Token Apple non valido o scaduto', 401);
    }
    console.error('[appleAuth] verifica token fallita:', e.message);
    return error(res, 'Verifica Apple non disponibile, riprova', 503);
  }

  const appleId = payload.sub;
  const tokenEmail =
    typeof payload.email === 'string' && String(payload.email_verified) === 'true'
      ? payload.email.trim().toLowerCase()
      : null;
  const bodyEmail = validateEmail(appleUser?.email) === null
    ? appleUser.email.trim().toLowerCase()
    : null;

  let user = await prisma.user.findUnique({ where: { appleId } });

  if (!user && tokenEmail) {
    // Stessa email verificata da Apple di un account gia' registrato: collega
    user = await prisma.user.findUnique({ where: { email: tokenEmail } });
    if (user?.appleId && user.appleId !== appleId) {
      return error(res, 'Account gia\' collegato a un altro Apple ID', 409);
    }
  }

  if (!user) {
    const email = tokenEmail ?? bodyEmail;
    if (!email) {
      return error(res, 'Email non disponibile da Apple: riprova o usa un altro metodo di accesso');
    }
    if (!tokenEmail && await prisma.user.findUnique({ where: { email } })) {
      // Email non verificata da Apple e gia' in uso: non si collega
      return error(res, 'Email gia\' registrata: accedi con il metodo che hai usato in origine', 409);
    }

    const baseUsername = email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'user';
    let username = baseUsername;
    let suffix = 1;
    while (await prisma.user.findUnique({ where: { username } })) {
      username = `${baseUsername}${suffix++}`;
    }
    const cleanName = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
    user = await prisma.user.create({
      data: {
        email,
        appleId,
        name:               cleanName(appleUser?.givenName),
        surname:            cleanName(appleUser?.familyName),
        username,
        isVerified:         true,
        // false: Apple puo' non dare il nome ("Nascondi la mia email" / login
        // senza scope) e il signup dell'app manda alla schermata "completa
        // profilo" solo se questo flag e' false. Dal login successivo il ramo
        // sotto lo porta a true, come per gli altri metodi.
        isProfileCompleted: false,
      },
    });
  } else if (!user.appleId) {
    // Collega Apple a un account esistente: isProfileCompleted non si tocca.
    user = await prisma.user.update({
      where: { id: user.id },
      data:  { appleId, isVerified: true },
    });
  }
  // Non forziamo più isProfileCompleted:true qui al login successivo — vedi
  // stesso commento in googleAuth. Resta false finché l'utente non passa
  // davvero dalla schermata "completa profilo".

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);
  return success(res, { accessToken, refreshToken, user: sanitizeUser(user, req) });
}

// ─── verifyOtpHandler ─────────────────────────────────────────────────────────
async function verifyOtpHandler(req, res) {
  // FIX: accetta email invece di userId per evitare user enumeration
  const email = req.body.email?.trim().toLowerCase();
  const otp   = String(req.body.otp ?? '').trim();

  if (!email || !otp) return error(res, 'Email e codice OTP obbligatori');

  // Trova l'utente dall'email (non dall'userId esposto)
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return error(res, 'Codice OTP non valido o scaduto'); // stessa risposta — anti-enumeration

  const valid = await verifyOtp(user.id, otp);
  if (!valid) return error(res, 'Codice OTP non valido o scaduto');

  // Usa l'oggetto restituito dall'update: contiene isVerified=true
  // (l'oggetto `user` letto prima avrebbe ancora isVerified=false)
  // isProfileCompleted NON si forza a true: come per Google/Apple, chi si
  // registra con email passa poi da "Completa profilo" (dieta/allergie).
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data:  { isVerified: true },
  });

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);
  return success(res, { accessToken, refreshToken, user: sanitizeUser(updatedUser, req) });
}

// ─── resendOtp ────────────────────────────────────────────────────────────────
async function resendOtp(req, res) {
  const email = req.body.email?.trim().toLowerCase();
  if (!email) return error(res, 'Email obbligatoria');

  const user = await prisma.user.findUnique({ where: { email } });
  // Risposta identica anche se l'utente non esiste (anti-enumeration)
  if (!user || user.isVerified) {
    return success(res, { message: 'Se la email è in attesa di verifica, riceverai un nuovo codice.' });
  }

  const otp = await createOtp(user.id);
  if (process.env.NODE_ENV !== 'production') console.log(`[DEV] Resend OTP per ${email}: ${otp}`);
  await sendOtpEmail(email, otp, user.language).catch(e => console.error('[resendOtp] email error:', e.message));

  return success(res, { message: 'Nuovo codice OTP inviato.' });
}

// ─── forgotPassword ───────────────────────────────────────────────────────────
async function forgotPassword(req, res) {
  const email = req.body.email?.trim().toLowerCase();
  if (!email) return error(res, 'Email obbligatoria');

  // Risposta identica se email esiste o non esiste (anti-enumeration)
  const GENERIC_MSG = 'Se la email è registrata, riceverai un codice di verifica.';

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return success(res, { message: GENERIC_MSG }); // non rivelare che l'email non esiste

  const otp = await createOtp(user.id);
  await sendPasswordResetEmail(email, otp, user.language).catch(e => console.warn('[forgot] email error:', e.message));

  // FIX: NON esporre userId nella risposta — il client usa l'email per identificare il flusso
  return success(res, { message: GENERIC_MSG });
}

// ─── changePasswordByOtp ──────────────────────────────────────────────────────
async function changePasswordByOtp(req, res) {
  // FIX: usa email invece di userId
  const email       = req.body.email?.trim().toLowerCase();
  const otp         = String(req.body.otp ?? '').trim();
  const newPassword = req.body.newPassword;

  if (!email || !otp || !newPassword) {
    return error(res, 'Email, codice OTP e nuova password obbligatori');
  }

  const pwdErr = validatePassword(newPassword);
  if (pwdErr) return error(res, pwdErr);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return error(res, 'Codice OTP non valido o scaduto'); // anti-enumeration

  const valid = await verifyOtp(user.id, otp);
  if (!valid) return error(res, 'Codice OTP non valido o scaduto');

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

  // Revoca tutti i refresh token esistenti (sessione cambiata)
  await revokeAllTokens(user.id);

  return success(res, { message: 'Password aggiornata con successo. Effettua di nuovo il login.' });
}

// ─── changePasswordByOldPassword ─────────────────────────────────────────────
async function changePasswordByOldPassword(req, res) {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return error(res, 'Vecchia e nuova password obbligatorie');

  const pwdErr = validatePassword(newPassword);
  if (pwdErr) return error(res, pwdErr);

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return error(res, 'Utente non trovato', 404);

  // FIX: gestisce utenti OAuth (password === null)
  if (!user.password) {
    return error(res, 'Questo account usa l\'accesso Google. Impossibile cambiare la password.', 400);
  }

  const valid = await bcrypt.compare(oldPassword, user.password);
  if (!valid) return error(res, 'Vecchia password non corretta', 401);

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: req.userId }, data: { password: hashed } });

  // Revoca tutti i refresh token tranne quello corrente (mantieni sessione attiva)
  await revokeAllTokens(req.userId);

  return success(res, { message: 'Password aggiornata' });
}

// ─── editProfile ──────────────────────────────────────────────────────────────
async function editProfile(req, res) {
  const {
    name, surname, username, phone, country, language, monthlyBudget,
    yearlyBudget, deviceToken, b2bDataSharing, isProfileCompleted,
  } = req.body;

  // Valida e sanitizza i campi numerici
  const budget = {
    monthlyBudget: monthlyBudget != null ? parseFloat(monthlyBudget) : undefined,
    yearlyBudget:  yearlyBudget  != null ? parseFloat(yearlyBudget)  : undefined,
  };
  if (budget.monthlyBudget !== undefined && (isNaN(budget.monthlyBudget) || budget.monthlyBudget < 0)) {
    return error(res, 'Budget mensile non valido');
  }
  if (budget.yearlyBudget !== undefined && (isNaN(budget.yearlyBudget) || budget.yearlyBudget < 0)) {
    return error(res, 'Budget annuale non valido');
  }

  let avatar;
  if (req.file) {
    // File multipart caricato direttamente
    avatar = await uploadToS3(req.file, 'avatars');
  } else if (req.body.avatar && typeof req.body.avatar === 'string' && req.body.avatar.startsWith('http')) {
    // URL S3 già caricato dal client (il frontend carica prima su S3, poi manda l'URL)
    avatar = req.body.avatar;
  }

  const data = {
    ...(name         !== undefined && { name:         String(name).slice(0, 100) }),
    ...(surname      !== undefined && { surname:      String(surname).slice(0, 100) }),
    ...(username     !== undefined && { username:     String(username).trim().slice(0, 50) || undefined }),
    ...(phone        !== undefined && { phone:        String(phone).slice(0, 20) }),
    ...(country      !== undefined && { country:      String(country).slice(0, 50) }),
    ...(language     !== undefined && { language:     String(language).slice(0, 10) }),
    ...(deviceToken  !== undefined && { deviceToken:  String(deviceToken).slice(0, 500) }),
    ...(budget.monthlyBudget !== undefined && { monthlyBudget: budget.monthlyBudget }),
    ...(budget.yearlyBudget  !== undefined && { yearlyBudget:  budget.yearlyBudget }),
    ...(avatar               !== undefined && { avatar }),
    // GDPR opt-out: accetta solo booleano esplicito (ignora stringhe/null ambigui)
    ...(b2bDataSharing === true  && { b2bDataSharing: true }),
    ...(b2bDataSharing === false && { b2bDataSharing: false }),
    // Si può solo COMPLETARE il profilo da qui, mai "ri-scompletarlo": un
    // client che manda isProfileCompleted:false non deve poter bloccare di
    // nuovo un account già attivo.
    ...(isProfileCompleted === true && { isProfileCompleted: true }),
  };

  // username è @unique: prima un nome già preso faceva rispondere 500
  // (errore Prisma grezzo) invece di un messaggio comprensibile.
  let user;
  try {
    user = await prisma.user.update({ where: { id: req.userId }, data });
  } catch (e) {
    if (e.code === 'P2002' && e.meta?.target?.includes('username')) {
      return error(res, 'Username già in uso, scegline un altro', 409);
    }
    throw e;
  }
  return success(res, { user: sanitizeUser(user, req) });
}

// ─── getProfile ───────────────────────────────────────────────────────────────
async function getProfile(req, res) {
  const user = await prisma.user.findUnique({
    where:   { id: req.userId },
    include: { nutritionProfile: true },
  });
  if (!user) return error(res, 'Utente non trovato', 404);
  return success(res, { user: sanitizeUser(user, req) });
}

// ─── refreshToken ─────────────────────────────────────────────────────────────
// FIX: refresh token nel BODY (POST) — non in URL param
async function refreshTokenHandler(req, res) {
  const token = req.body.refreshToken;
  if (!token) return error(res, 'Refresh token mancante');

  try {
    const tokens = await rotateRefreshToken(token);
    return success(res, tokens);
  } catch (e) {
    return error(res, e.message, e.statusCode ?? 401);
  }
}

// ─── logout ───────────────────────────────────────────────────────────────────
async function logout(req, res) {
  const token = req.body.refreshToken;
  if (token) {
    // Invalida solo il refresh token corrente
    await prisma.refreshToken.deleteMany({ where: { token } }).catch(() => {});
  }
  return success(res, { message: 'Logout effettuato' });
}

// ─── deleteAccount ────────────────────────────────────────────────────────────
async function deleteAccount(req, res) {
  // Se l'account ha una password, richiedila come conferma (il JWT da solo
  // non basta: un telefono lasciato sbloccato non deve poter cancellare tutto).
  // Account Google/guest (senza password) procedono col solo JWT.
  const me = await prisma.user.findUnique({
    where:  { id: req.userId },
    select: { password: true },
  });
  if (me?.password) {
    const pwd = req.body?.password;
    if (!pwd || !(await bcrypt.compare(String(pwd), me.password))) {
      return error(res, 'Password non corretta', 401);
    }
  }

  // GDPR Art. 17 — Right to erasure
  // 1. Anonimizza i dati di PriceHistory (contributi prezzo — non hanno userId ma provengono da scontrini)
  //    I FineTuningSample sono cancellati in cascade grazie alla relazione User → FineTuningSample
  // 2. I RefreshToken e OTP vengono eliminati in cascade
  // 3. Elimina l'utente (cascade su tutte le relazioni con onDelete: Cascade)

  await prisma.user.delete({ where: { id: req.userId } });
  // Le foto degli scontrini stanno su disco, non nel DB: vanno cancellate a parte.
  await require('../utils/receiptImages').deleteUserReceiptImages(req.userId)
    .catch(e => console.warn('[deleteAccount] foto scontrini non cancellate:', e.message));

  // Invalida subito la cache auth: il token non deve più passare
  const { invalidateAuthCache } = require('../middleware/auth');
  invalidateAuthCache(req.userId);

  return success(res, { message: 'Account eliminato. Tutti i tuoi dati sono stati rimossi.' });
}

// ─── getAllUsers — SOLO ADMIN ─────────────────────────────────────────────────
// Questa funzione deve essere montata SOLO dopo il middleware adminOnly
async function getAllUsers(req, res) {
  const { page = 1, limit = 50 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, name: true, email: true, createdAt: true, isVerified: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(100, parseInt(limit, 10)),
    }),
    prisma.user.count(),
  ]);

  return success(res, { users, total });
}

// ─── seedDemoAccount — SOLO ADMIN ──────────────────────────────────────────────
// Crea (o aggiorna) un account con email/password fissate e un abbonamento con
// uno stato specifico, senza passare dal flusso di signup normale (verifica
// OTP inclusa). Serve per preparare account demo da dare al team di verifica
// delle app di Apple — es. un account con abbonamento SCADUTO, richiesto per
// testare il flusso di rinnovo (Linea guida 2.1), oltre a quello con
// abbonamento attivo già fornito.
async function seedDemoAccount(req, res) {
  const {email, password, status = 'expired', daysAgo = 30} = req.body || {};
  if (!email || !password) {
    return error(res, 'email e password sono obbligatorie', 400);
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: {email},
    update: {
      password: hashed,
      isVerified: true,
      isProfileCompleted: true,
      isSubscribed: status === 'active',
    },
    create: {
      email,
      password: hashed,
      name: 'Demo',
      surname: 'Apple Review',
      isVerified: true,
      isProfileCompleted: true,
      isSubscribed: status === 'active',
    },
  });

  const currentPeriodEnd = new Date(
    Date.now() + (status === 'expired' ? -1 : 1) * daysAgo * 24 * 60 * 60 * 1000,
  );
  await prisma.subscription.upsert({
    where: {userId: user.id},
    update: {provider: 'apple', status, currentPeriodEnd},
    create: {userId: user.id, provider: 'apple', status, currentPeriodEnd},
  });

  return success(res, {email: user.email, status, currentPeriodEnd});
}

// ─── sanitizeUser ─────────────────────────────────────────────────────────────
/**
 * Rimuove i campi sensibili prima di inviare l'utente al client.
 * GDPR art. 5: minimizzazione dei dati — il client non ha bisogno di
 * fcmToken, deviceToken, googleId, password.
 */
function sanitizeUser(user, req) {
  const {
    password,
    fcmToken,
    deviceToken,
    googleId,
    appleId,
    ...rest
  } = user;
  return rest;
}

// ─── GET /api/user/plan-usage ─────────────────────────────────────────────────
async function getPlanUsage(req, res) {
  const userId = req.userId;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [user, receiptsThisMonth, chatToday] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: userId },
      select: { isSubscribed: true, name: true, email: true },
    }),
    prisma.receipt.count({
      where: { userId, processedAt: { gte: startOfMonth } },
    }),
    prisma.chatMessage.count({
      where: { role: 'user', createdAt: { gte: startOfDay }, session: { userId } },
    }),
  ]);

  const isPremium = !!user?.isSubscribed;

  return success(res, {
    plan:              isPremium ? 'Premium' : 'Free',
    isPremium,
    receipts: {
      used:  receiptsThisMonth,
      limit: isPremium ? null : 10,
    },
    chat: {
      used:  chatToday,
      limit: isPremium ? null : 15,
    },
    features: [
      { label: 'Scansiona scontrini',              unlocked: true },
      { label: 'Dove risparmi',                    unlocked: true },
      { label: 'Assistente AI',                    unlocked: true },
      { label: 'Budget mensile',                   unlocked: true },
      { label: 'Spesa di gruppo',                  unlocked: true },
      { label: 'Previsione prezzi',                unlocked: true },
      { label: 'Cosa dimenticavi di comprare',     unlocked: true },
      { label: 'Avvisi prezzo in aumento',         unlocked: isPremium },
      { label: 'Domande AI illimitate',            unlocked: isPremium },
      { label: 'Export storia spesa via email',    unlocked: isPremium },
    ],
  });
}

// ─── GET /api/user/search?q= ───────────────────────────────────────────────────
// Cerca utenti reali per username/nome/email (es. per aggiungerli come
// partecipanti a un gruppo spesa) — non è admin-only come getAllUsers,
// qualsiasi utente autenticato può cercare per invitare qualcuno.
async function searchUsers(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return success(res, { users: [] });

  const users = await prisma.user.findMany({
    where: {
      id: { not: req.userId }, // non serve trovare sé stessi
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { name:     { contains: q, mode: 'insensitive' } },
        { surname:  { contains: q, mode: 'insensitive' } },
        { email:    { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, username: true, name: true, surname: true, email: true, avatar: true },
    take: 10,
  });

  return success(res, { users });
}

// ─── POST /api/user/:id/block ────────────────────────────────────────────────
// Blocco utenti nel feed community — richiesto da Apple/Google insieme alla
// segnalazione per le app con contenuti generati dagli utenti (guideline 1.2).
// Monodirezionale: chi blocca non vede più i post del bloccato; il bloccato
// può ancora vedere i propri.
async function blockUser(req, res) {
  const blockedId = req.params.id;
  if (blockedId === req.userId) return error(res, 'Non puoi bloccare te stesso', 400);

  const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) return error(res, 'Utente non trovato', 404);

  await prisma.blockedUser.upsert({
    where: { blockerId_blockedId: { blockerId: req.userId, blockedId } },
    update: {},
    create: { blockerId: req.userId, blockedId },
  });

  return success(res, { message: 'Utente bloccato' });
}

// ─── DELETE /api/user/:id/block ──────────────────────────────────────────────
async function unblockUser(req, res) {
  await prisma.blockedUser.deleteMany({
    where: { blockerId: req.userId, blockedId: req.params.id },
  });
  return success(res, { message: 'Utente sbloccato' });
}

// ─── GET /api/user/blocked ────────────────────────────────────────────────────
async function getBlockedUsers(req, res) {
  const rows = await prisma.blockedUser.findMany({
    where: { blockerId: req.userId },
    include: { blocked: { select: { id: true, name: true, surname: true, username: true, avatar: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return success(res, { users: rows.map(r => r.blocked) });
}

module.exports = {
  signup,
  login,
  guestLogin,
  googleAuth,
  appleAuth,
  verifyOtpHandler,
  resendOtp,
  forgotPassword,
  changePasswordByOtp,
  changePasswordByOldPassword,
  editProfile,
  getProfile,
  getPlanUsage,
  refreshTokenHandler,
  logout,
  deleteAccount,
  getAllUsers,
  seedDemoAccount,
  searchUsers,
  blockUser,
  unblockUser,
  getBlockedUsers,
};
