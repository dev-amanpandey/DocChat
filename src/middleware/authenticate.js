import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function authenticate(req, res, next) {
  const authorization = req.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return res.status(401).json({ error: { message: 'Unauthorized' } });

  try {
    const payload = jwt.verify(match[1], env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || typeof payload.sub !== 'string' || !payload.sub) {
      return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
    req.userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: { message: 'Unauthorized' } });
  }
}
