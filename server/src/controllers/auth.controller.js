const bcrypt = require('bcrypt');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { signToken } = require('../lib/jwt');

const authSchema = z.object({
  username: z
    .string()
    .min(3, 'Никнейм должен содержать минимум 3 символа')
    .max(20, 'Никнейм должен содержать максимум 20 символов')
    .regex(/^[a-zA-Zа-яА-Я0-9_]+$/, 'Допустимы только буквы, цифры и _'),
  password: z
    .string()
    .min(6, 'Пароль должен содержать минимум 6 символов')
    .max(100, 'Пароль слишком длинный'),
});

async function register(req, res) {
  try {
    const parsed = authSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        message: 'Ошибка валидации',
        errors: parsed.error.flatten(),
      });
    }

    const { username, password } = parsed.data;

    const existingUser = await prisma.user.findUnique({
      where: { username },
    });

    if (existingUser) {
      return res.status(409).json({
        message: 'Такой никнейм уже существует',
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
      },
    });

    return res.status(201).json({
      message: 'Аккаунт успешно создан',
      user: {
        id: user.id,
        username: user.username,
      },
    });
  } catch (error) {
    console.error('REGISTER ERROR:', error);
    return res.status(500).json({
      message: 'Ошибка сервера при регистрации',
    });
  }
}

async function login(req, res) {
  try {
    const parsed = authSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        message: 'Ошибка валидации',
        errors: parsed.error.flatten(),
      });
    }

    const { username, password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { username },
    });

    if (!user) {
      return res.status(401).json({
        message: 'Неверный логин или пароль',
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      return res.status(401).json({
        message: 'Неверный логин или пароль',
      });
    }

    const token = signToken(user);

    return res.status(200).json({
      message: 'Вход выполнен успешно',
      token,
      user: {
        id: user.id,
        username: user.username,
      },
    });
  } catch (error) {
    console.error('LOGIN ERROR:', error);
    return res.status(500).json({
      message: 'Ошибка сервера при входе',
    });
  }
}

async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        message: 'Пользователь не найден',
      });
    }

    return res.status(200).json({
      user,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Ошибка сервера',
    });
  }
}

module.exports = {
  register,
  login,
  me,
};