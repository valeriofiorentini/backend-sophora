const router       = require('express').Router();
const c            = require('../controllers/user.controller');
const { auth }     = require('../middleware/auth');
const adminOnly    = require('../middleware/adminOnly');
const asyncHandler = require('../middleware/asyncHandler');
const { upload }   = require('../config/s3');
const {
  loginLimit,
  signupLimit,
  forgotPasswordLimit,
  verifyOtpLimit,
  changePasswordLimit,
  guestLoginLimit,
} = require('../middleware/authRateLimit');
const { validate } = require('../middleware/validate');
const {
  signupSchema,
  loginSchema,
  editProfileSchema,
  fcmTokenSchema,
  locationSchema,
} = require('../validation/schemas');

// ─── Pubbliche (con rate limit per IP) ───────────────────────────────────────
router.post('/signup',               signupLimit,         validate(signupSchema), asyncHandler(c.signup));
router.post('/login',                loginLimit,          validate(loginSchema),  asyncHandler(c.login));
router.post('/guest-login',          guestLoginLimit,     asyncHandler(c.guestLogin));
router.post('/google-auth',          loginLimit,          asyncHandler(c.googleAuth));
router.post('/verify-otp',           verifyOtpLimit,      asyncHandler(c.verifyOtpHandler));
router.post('/resend-otp',           verifyOtpLimit,      asyncHandler(c.resendOtp));
router.post('/forgot-password',      forgotPasswordLimit, asyncHandler(c.forgotPassword));
router.post('/change-password',      changePasswordLimit, asyncHandler(c.changePasswordByOtp));
router.post('/change-password-otp',  changePasswordLimit, asyncHandler(c.changePasswordByOtp));

// FIX: refresh token via POST body (non GET URL — evita log exposure)
router.post('/refresh', asyncHandler(c.refreshTokenHandler));

// ─── Protette (JWT richiesto) ─────────────────────────────────────────────────
router.use(auth);

router.get('/me',                                               asyncHandler(c.getProfile));
router.get('/plan-usage',                                       asyncHandler(c.getPlanUsage));
router.patch('/edit-profile', upload.single('avatar'), validate(editProfileSchema), asyncHandler(c.editProfile));
router.patch('/changePasswordByOldPassword', changePasswordLimit, asyncHandler(c.changePasswordByOldPassword));
router.delete('/delete-account',                               asyncHandler(c.deleteAccount));
router.post('/logout',                                         asyncHandler(c.logout));

// FCM token (+ posizione opzionale per le offerte vicine)
router.post('/fcm-token', validate(fcmTokenSchema), asyncHandler(async (req, res) => {
  const { fcmToken, latitude, longitude } = req.body;
  const prisma = require('../config/database');
  const data = { fcmToken };
  if (latitude != null && longitude != null) {
    data.latitude  = latitude;
    data.longitude = longitude;
  }
  await prisma.user.update({ where: { id: req.userId }, data });
  return res.json({ success: true });
}));

// Aggiorna solo la posizione dell'utente (chiamata dalla dashboard quando ottiene il GPS)
router.post('/location', validate(locationSchema), asyncHandler(async (req, res) => {
  const { latitude, longitude } = req.body;
  const prisma = require('../config/database');
  await prisma.user.update({
    where: { id: req.userId },
    data:  { latitude, longitude },
  });
  return res.json({ success: true });
}));

// Trigger manuale notifiche offerte (test) — solo admin
router.post('/notify-promos', adminOnly, asyncHandler(async (req, res) => {
  const { notifyNearbyPromos } = require('../services/promoNotify.service');
  const result = await notifyNearbyPromos();
  return res.json({ success: true, data: result });
}));

// ─── Solo Admin ───────────────────────────────────────────────────────────────
// Richiede header X-Admin-Key o flag isAdmin nel JWT
router.get('/getAllUsers', adminOnly, asyncHandler(c.getAllUsers));

module.exports = router;
