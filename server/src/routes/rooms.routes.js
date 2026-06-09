const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const authMiddleware = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/token', authMiddleware, async (req, res) => {
  try {
    const { roomId } = req.body;

    if (!roomId) {
      return res.status(400).json({ message: 'roomId обязателен' });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).json({ message: 'LiveKit не настроен' });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: req.user.username,
      ttl: '4h',
    });

    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return res.json({
      token,
      wsUrl: process.env.LIVEKIT_WS_URL,
    });
  } catch (error) {
    console.error('TOKEN ERROR:', error);
    return res.status(500).json({ message: 'Ошибка генерации токена' });
  }
});

module.exports = router;
