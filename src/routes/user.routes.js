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

// ─── Pubbliche (con rate limit per IP) ───────────────────────────────────────
router.post('/signup',               signupLimit,         asyncHandler(c.signup));
router.post('/login',                loginLimit,          asyncHandler(c.login));
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
router.patch('/edit-profile', upload.single('avatar'),         asyncHandler(c.editProfile));
router.patch('/changePasswordByOldPassword', changePasswordLimit, asyncHandler(c.changePasswordByOldPassword));
router.delete('/delete-account',                               asyncHandler(c.deleteAccount));
router.post('/logout',                                         asyncHandler(c.logout));

// FCM token
router.post('/fcm-token', asyncHandler(async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken || typeof fcmToken !== 'string') {
    return res.status(400).json({ success: false, message: 'fcmToken non valido' });
  }
  const prisma = require('../config/database');
  await prisma.user.update({
    where: { id: req.userId },
    data:  { fcmToken: fcmToken.slice(0, 500) },
  });
  return res.json({ success: true });
}));

// ─── Solo Admin ───────────────────────────────────────────────────────────────
// Richiede header X-Admin-Key o flag isAdmin nel JWT
router.get('/getAllUsers', adminOnly, asyncHandler(c.getAllUsers));

module.exports = router;
