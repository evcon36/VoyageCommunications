const express = require('express');
const {
  register, login, twofaSend, twofaVerify, me, updateProfile, uploadAvatar, linkTelegram,
  deleteAccount, restoreAccount, deletionPreview,
} = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/2fa/send', twofaSend);
router.post('/2fa/verify', twofaVerify);
router.get('/me', authMiddleware, me);
router.patch('/profile', authMiddleware, updateProfile);
router.post('/avatar', authMiddleware, uploadAvatar);
router.post('/link-telegram', authMiddleware, linkTelegram);
router.get('/account/deletion-preview', authMiddleware, deletionPreview);
router.post('/account/delete', authMiddleware, deleteAccount);
router.post('/account/restore', authMiddleware, restoreAccount);

module.exports = router;
