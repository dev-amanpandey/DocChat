import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { authenticate } from '../middleware/authenticate.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(8).refine((password) => Buffer.byteLength(password, 'utf8') <= 72, {
    message: 'Password must be no more than 72 bytes',
  }),
}).strict();

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(1),
}).strict();

function validate(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = new Error('Invalid request body');
    error.status = 400;
    error.details = parsed.error.flatten();
    throw error;
  }
  return parsed.data;
}

function safeProfile(user) {
  return { id: user.id ?? user._id.toString(), name: user.name, email: user.email };
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = validate(registerSchema, req.body);
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: { message: 'Email already registered' } });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = new User({ name, email, passwordHash });
    try {
      await user.save();
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ error: { message: 'Email already registered' } });
      }
      throw error;
    }
    return res.status(201).json({ user: safeProfile(user) });
  } catch (error) {
    return next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = validate(loginSchema, req.body);
    const user = await User.findOne({ email }).select('+passwordHash');
    const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!passwordMatches) {
      return res.status(401).json({ error: { message: 'Invalid email or password' } });
    }

    const token = jwt.sign({}, env.JWT_SECRET, {
      subject: user.id ?? user._id.toString(),
      expiresIn: env.JWT_EXPIRES_IN,
      algorithm: 'HS256',
    });
    return res.status(200).json({ token });
  } catch (error) {
    return next(error);
  }
});

authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: { message: 'Unauthorized' } });
    return res.status(200).json({ user: safeProfile(user) });
  } catch (error) {
    return next(error);
  }
});
