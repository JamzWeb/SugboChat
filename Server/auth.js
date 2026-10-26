import { OAuth2Client } from 'google-auth-library';
import dotenv from 'dotenv';
import { getRow, runQuery } from './db.js';

dotenv.config();

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export async function verifyGoogleToken(idToken) {
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) return null;

    const email = payload.email.toLowerCase();
    const googleId = payload.sub;
    const isAdmin = adminEmails.includes(email);

    // Fetch or create user
    let user = await getRow('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      const initialRole = isAdmin ? 'admin' : 'user';
      const randomTag = Math.floor(1000 + Math.random() * 9000);
      const initialNickname = `SugboUser#${randomTag}`;

      await runQuery(
        'INSERT INTO users (id, email, nickname, role) VALUES (?, ?, ?, ?)',
        [googleId, email, initialNickname, initialRole]
      );

      user = await getRow('SELECT * FROM users WHERE id = ?', [googleId]);
    } else if (isAdmin && user.role !== 'admin') {
      // Sync admin status if email was added to env later
      await runQuery('UPDATE users SET role = "admin" WHERE id = ?', [user.id]);
      user.role = 'admin';
    }

    return user;
  } catch (error) {
    console.error('Google token verification error:', error.message);
    return null;
  }
}

// Express Middleware for API route protection
export async function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const token = authHeader.split(' ')[1];
  const user = await verifyGoogleToken(token);

  if (!user || user.is_banned) {
    return res.status(403).json({ error: 'Unauthorized or banned' });
  }

  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }

  req.user = user;
  next();
}
