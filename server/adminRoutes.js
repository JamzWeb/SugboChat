import express from 'express';
import { requireAdmin } from './auth.js';
import { getAll, runQuery } from './db.js';
import { disconnectUserSession } from './sockets.js';

const router = express.Router();
router.use(requireAdmin);

// Fetch moderation reports
router.get('/reports', async (req, res) => {
  try {
    const reports = await getAll(
      `SELECT r.*, u1.nickname as reporter_name, u2.nickname as reported_name, u2.email as reported_email, u2.is_banned
       FROM reports r
       JOIN users u1 ON r.reporter_id = u1.id
       JOIN users u2 ON r.reported_id = u2.id
       ORDER BY r.created_at DESC LIMIT 50`
    );
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ban an account
router.post('/ban', async (req, res) => {
  const { userId, reason } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await runQuery('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?', [
      reason || 'Violated community guidelines',
      userId,
    ]);
    disconnectUserSession(userId, 'Your account has been permanently suspended by an administrator.');
    res.json({ success: true, message: 'User banned and kicked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update report resolution
router.post('/resolve-report', async (req, res) => {
  const { reportId } = req.body;
  try {
    await runQuery('UPDATE reports SET status = "resolved" WHERE id = ?', [reportId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
