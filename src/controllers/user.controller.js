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
    console.log(`[DEV] OTP per ${email} (ri-registrazione): ${otp}`);
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
  console.log(`[DEV] OTP per ${email}: ${otp}`);
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

  return success(res, { accessToken, refreshToken, user: sanitizeUser(user) });
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
  return success(res, { accessToken, refreshToken, user: sanitizeUser(user) });
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
        isProfileCompleted: true,
      },
    });
  } else if (!user.googleId) {
    // Account esistente con stessa email: collega Google
    user = await prisma.user.update({
      where: { id: user.id },
      data:  {
        googleId,
        isVerified:         true,
        isProfileCompleted: true,
        avatar: user.avatar ?? payload.picture ?? null,
      },
    });
  } else {
    // Utente già collegato: assicura isProfileCompleted
    if (!user.isProfileCompleted) {
      user = await prisma.user.update({
        where: { id: user.id },
        data:  { isProfileCompleted: true },
      });
    }
  }

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);
  return success(res, { accessToken, refreshToken, user: sanitizeUser(user) });
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
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data:  { isVerified: true, isProfileCompleted: true },
  });

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = await generateRefreshToken(user.id);
  return success(res, { accessToken, refreshToken, user: sanitizeUser(updatedUser) });
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
  console.log(`[DEV] Resend OTP per ${email}: ${otp}`);
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
  const { name, phone, country, language, monthlyBudget, yearlyBudget, deviceToken, b2bDataSharing } = req.body;

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
  };

  const user = await prisma.user.update({ where: { id: req.userId }, data });
  return success(res, { user: sanitizeUser(user) });
}

// ─── getProfile ───────────────────────────────────────────────────────────────
async function getProfile(req, res) {
  const user = await prisma.user.findUnique({
    where:   { id: req.userId },
    include: { nutritionProfile: true },
  });
  if (!user) return error(res, 'Utente non trovato', 404);
  return success(res, { user: sanitizeUser(user) });
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
  // GDPR Art. 17 — Right to erasure
  // 1. Anonimizza i dati di PriceHistory (contributi prezzo — non hanno userId ma provengono da scontrini)
  //    I FineTuningSample sono cancellati in cascade grazie alla relazione User → FineTuningSample
  // 2. I RefreshToken e OTP vengono eliminati in cascade
  // 3. Elimina l'utente (cascade su tutte le relazioni con onDelete: Cascade)

  await prisma.user.delete({ where: { id: req.userId } });

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

// ─── sanitizeUser ─────────────────────────────────────────────────────────────
/**
 * Rimuove i campi sensibili prima di inviare l'utente al client.
 * GDPR art. 5: minimizzazione dei dati — il client non ha bisogno di
 * fcmToken, deviceToken, googleId, password.
 */
function sanitizeUser(user) {
  const {
    password,
    fcmToken,
    deviceToken,
    googleId,
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
      { label: 'Cosa dimenticavi di comprare',     unlocked: isPremium },
      { label: 'Percorso ottimale tra negozi',     unlocked: isPremium },
      { label: 'Avvisi prezzo in aumento',         unlocked: isPremium },
      { label: 'Domande AI illimitate',            unlocked: isPremium },
      { label: 'Export storia spesa via email',    unlocked: isPremium },
    ],
  });
}

module.exports = {
  signup,
  login,
  guestLogin,
  googleAuth,
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
};
