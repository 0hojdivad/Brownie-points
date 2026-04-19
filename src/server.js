const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

// ─── Database setup ───────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id),
    friend_id   TEXT NOT NULL REFERENCES users(id),
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS favours (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user   TEXT NOT NULL REFERENCES users(id),
    to_user     TEXT NOT NULL REFERENCES users(id),
    description TEXT NOT NULL,
    points      INTEGER NOT NULL DEFAULT 1,
    direction   INTEGER NOT NULL,
    logged_by   TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple auth middleware — user_id passed via header X-User-Id
function requireUser(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing X-User-Id header' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  req.user = user;
  next();
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'BP-' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Register / get user
app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = crypto.randomUUID();
  let code;
  for (let i = 0; i < 10; i++) {
    code = genCode();
    if (!db.prepare('SELECT 1 FROM users WHERE invite_code = ?').get(code)) break;
  }
  db.prepare('INSERT INTO users (id, name, invite_code) VALUES (?, ?, ?)').run(id, name, code);
  res.json({ id, name, invite_code: code });
});

// Get current user profile
app.get('/api/me', requireUser, (req, res) => {
  res.json(req.user);
});

// Look up user by invite code (for connecting)
app.get('/api/users/by-code/:code', requireUser, (req, res) => {
  const user = db.prepare('SELECT id, name, invite_code FROM users WHERE invite_code = ?').get(req.params.code.toUpperCase());
  if (!user) return res.status(404).json({ error: 'Code not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'That is your own code' });
  res.json(user);
});

// Send friend request
app.post('/api/friends/request', requireUser, (req, res) => {
  const { invite_code } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE invite_code = ?').get(invite_code?.toUpperCase());
  if (!target) return res.status(404).json({ error: 'Invite code not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });

  const existing = db.prepare(
    'SELECT * FROM friendships WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)'
  ).get(req.user.id, target.id, target.id, req.user.id);
  if (existing) return res.status(400).json({ error: 'Already connected or pending' });

  db.prepare('INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, ?)').run(req.user.id, target.id, 'pending');
  res.json({ message: 'Request sent', target: { id: target.id, name: target.name } });
});

// Get pending requests (sent TO me)
app.get('/api/friends/pending', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, u.id as user_id, u.name, u.invite_code
    FROM friendships f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `).all(req.user.id);
  res.json(rows);
});

// Accept / decline friend request
app.patch('/api/friends/:id', requireUser, (req, res) => {
  const { action } = req.body; // 'accept' | 'decline'
  const friendship = db.prepare('SELECT * FROM friendships WHERE id = ? AND friend_id = ?').get(req.params.id, req.user.id);
  if (!friendship) return res.status(404).json({ error: 'Request not found' });

  if (action === 'accept') {
    db.prepare("UPDATE friendships SET status='accepted' WHERE id=?").run(friendship.id);
    // Create reverse friendship too
    db.prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?,?,'accepted')").run(req.user.id, friendship.user_id);
    res.json({ message: 'Friend added' });
  } else {
    db.prepare('DELETE FROM friendships WHERE id=?').run(friendship.id);
    res.json({ message: 'Request declined' });
  }
});

// Get all friends with balances
app.get('/api/friends', requireUser, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.name, u.invite_code,
      COALESCE(SUM(CASE WHEN fv.logged_by = ? THEN fv.points * fv.direction ELSE 0 END), 0) AS balance,
      COUNT(fv.id) as favour_count
    FROM friendships fs
    JOIN users u ON u.id = fs.friend_id
    LEFT JOIN favours fv ON (
      (fv.from_user = ? AND fv.to_user = u.id) OR
      (fv.from_user = u.id AND fv.to_user = ?)
    )
    WHERE fs.user_id = ? AND fs.status = 'accepted'
    GROUP BY u.id
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(friends);
});

// Get favour log for a specific friend
app.get('/api/friends/:friendId/favours', requireUser, (req, res) => {
  const { friendId } = req.params;
  const favours = db.prepare(`
    SELECT fv.*, u.name as logged_by_name
    FROM favours fv
    JOIN users u ON u.id = fv.logged_by
    WHERE (fv.from_user=? AND fv.to_user=?) OR (fv.from_user=? AND fv.to_user=?)
    ORDER BY fv.created_at DESC
  `).all(req.user.id, friendId, friendId, req.user.id);
  res.json(favours);
});

// Log a favour
app.post('/api/friends/:friendId/favours', requireUser, (req, res) => {
  const { friendId } = req.params;
  const { description, points, direction } = req.body;

  if (!description) return res.status(400).json({ error: 'Description required' });
  if (![1, -1].includes(direction)) return res.status(400).json({ error: 'Direction must be 1 or -1' });

  const friendship = db.prepare(
    "SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'"
  ).get(req.user.id, friendId);
  if (!friendship) return res.status(403).json({ error: 'Not friends' });

  const from = direction === -1 ? req.user.id : friendId;
  const to   = direction === -1 ? friendId : req.user.id;

  const result = db.prepare(
    'INSERT INTO favours (from_user, to_user, description, points, direction, logged_by) VALUES (?,?,?,?,?,?)'
  ).run(from, to, description, points || 1, direction, req.user.id);

  res.json({ id: result.lastInsertRowid, message: 'Favour logged' });
});

// Dashboard summary
app.get('/api/dashboard', requireUser, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.name,
      COALESCE(SUM(fv.points * fv.direction), 0) AS balance,
      COUNT(fv.id) as favour_count
    FROM friendships fs
    JOIN users u ON u.id = fs.friend_id
    LEFT JOIN favours fv ON (
      (fv.from_user = ? AND fv.to_user = u.id) OR
      (fv.from_user = u.id AND fv.to_user = ?)
    ) AND fv.logged_by = ?
    WHERE fs.user_id = ? AND fs.status = 'accepted'
    GROUP BY u.id
    ORDER BY balance DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);

  const totalBalance = friends.reduce((s, f) => s + f.balance, 0);
  const oweYou = friends.filter(f => f.balance > 0).reduce((s, f) => s + f.balance, 0);
  const youOwe = friends.filter(f => f.balance < 0).reduce((s, f) => s + Math.abs(f.balance), 0);

  res.json({ totalBalance, oweYou, youOwe, friends });
});

// Fallback to index.html
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => console.log(`Brownie Points running on port ${PORT}`));
