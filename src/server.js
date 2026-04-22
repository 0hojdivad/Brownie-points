const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-' + crypto.randomBytes(16).toString('hex');
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@browniepoints.app';

const resend = new Resend(RESEND_API_KEY);

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT,
    invite_code TEXT UNIQUE NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS magic_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    token      TEXT UNIQUE NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    friend_id  TEXT NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
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

  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    emoji      TEXT NOT NULL DEFAULT '👥',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL DEFAULT 'pending',
    joined_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(group_id, user_id)
  );
`);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 10; i++) {
    const code = 'BP-' + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    if (!db.prepare('SELECT 1 FROM users WHERE invite_code = ?').get(code)) return code;
  }
  throw new Error('Could not generate unique invite code');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/send-link', async (req, res) => {
  const { email, name, invite_code } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    const id = crypto.randomUUID();
    const code = genInviteCode();
    const displayName = name?.trim() || email.split('@')[0];
    db.prepare('INSERT INTO users (id, email, name, invite_code) VALUES (?, ?, ?, ?)').run(id, email.toLowerCase(), displayName, code);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  } else if (name?.trim() && !user.name) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO magic_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

  const params = new URLSearchParams({ token });
  if (invite_code) params.set('invite', invite_code);
  const magicLink = `${APP_URL}/api/auth/verify?${params}`;

  if (!RESEND_API_KEY) {
    console.log('\n🔗 Magic link (dev mode):', magicLink, '\n');
    return res.json({ message: 'Dev mode: magic link printed to server logs', dev_link: magicLink });
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: '🍫 Your Brownie Points sign-in link',
      html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:2rem;background:#FFF9F0;border-radius:16px;">
        <p style="font-size:32px;margin:0 0 8px;">🍫</p>
        <h2 style="font-size:22px;font-weight:700;margin:0 0 8px;color:#1A0A00;">Sign in to Brownie Points</h2>
        <p style="color:#7A5C3A;margin:0 0 24px;font-size:15px;line-height:1.5;">Click below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
        <a href="${magicLink}" style="display:inline-block;background:#FF6B35;color:#fff;padding:14px 32px;border-radius:50px;text-decoration:none;font-size:16px;font-weight:700;">Sign in ✨</a>
        <p style="color:#B09070;font-size:12px;margin-top:24px;">If you didn't request this, ignore this email.</p>
      </div>`
    });
    res.json({ message: 'Magic link sent — check your email' });
  } catch (e) {
    console.error('Resend error:', e);
    res.status(500).json({ error: 'Failed to send email. Check your RESEND_API_KEY.' });
  }
});

// GET — show click-through page so email scanners don't consume the token
app.get('/api/auth/verify', (req, res) => {
  const { token, invite } = req.query;
  if (!token) return res.redirect('/?auth_error=missing_token');

  const row = db.prepare(
    "SELECT 1 FROM magic_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')"
  ).get(token);

  if (!row) return res.redirect('/?auth_error=invalid_or_expired');

  const inviteField = invite ? `<input type="hidden" name="invite" value="${invite}"/>` : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sign in to Brownie Points</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;800&display=swap" rel="stylesheet"/>
<style>
  body{font-family:'Poppins',sans-serif;background:#3D1A00;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem;}
  .box{background:#FFFCF5;border-radius:20px;padding:2.5rem 2rem;text-align:center;max-width:340px;width:100%;border:3px solid #F5C400;box-shadow:0 6px 0 rgba(0,0,0,0.2);}
  .logo{font-size:52px;margin-bottom:0.5rem;}
  h1{font-size:20px;font-weight:800;color:#3D1A00;margin-bottom:8px;}
  p{font-size:14px;color:#7A4E2D;font-weight:600;margin-bottom:1.75rem;line-height:1.5;}
  button{width:100%;padding:14px;background:#F5C400;color:#3D1A00;border:none;border-radius:50px;font-size:15px;font-weight:800;cursor:pointer;font-family:'Poppins',sans-serif;box-shadow:0 3px 0 #D4A800;}
  .note{font-size:11px;color:#C8956C;margin-top:1rem;font-weight:600;}
</style>
</head>
<body>
<div class="box">
  <div class="logo">🍫</div>
  <h1>Sign in to Brownie Points</h1>
  <p>Click the button below to complete your sign-in.</p>
  <form method="POST" action="/api/auth/verify">
    <input type="hidden" name="token" value="${token}"/>
    ${inviteField}
    <button type="submit">Sign me in ✨</button>
  </form>
  <div class="note">This link expires in 15 minutes and can only be used once.</div>
</div>
</body>
</html>`);
});

// POST — consume the token and redirect with JWT
app.post('/api/auth/verify', express.urlencoded({ extended: false }), (req, res) => {
  const { token, invite } = req.body;
  if (!token) return res.redirect('/?auth_error=missing_token');

  const row = db.prepare(
    "SELECT mt.*, mt.user_id FROM magic_tokens mt WHERE mt.token = ? AND mt.used = 0 AND mt.expires_at > datetime('now')"
  ).get(token);

  if (!row) return res.redirect('/?auth_error=invalid_or_expired');
  db.prepare('UPDATE magic_tokens SET used = 1 WHERE id = ?').run(row.id);

  const jwtToken = jwt.sign({ sub: row.user_id }, JWT_SECRET, { expiresIn: '30d' });
  let redirect = '/?auth=' + encodeURIComponent(jwtToken);
  if (invite) redirect += '&invite=' + encodeURIComponent(invite);
  res.redirect(redirect);
});

// ─── Users ────────────────────────────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.patch('/api/me', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), req.user.id);
  res.json({ ...req.user, name: name.trim() });
});

app.get('/api/users/by-code/:code', (req, res) => {
  const user = db.prepare('SELECT id, name, invite_code FROM users WHERE invite_code = ?').get(req.params.code.toUpperCase());
  if (!user) return res.status(404).json({ error: 'Code not found' });
  res.json(user);
});

// Send an invite email to a friend
app.post('/api/friends/invite-email', requireAuth, async (req, res) => {
  const { to_email, to_name } = req.body;
  if (!to_email || !to_email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const inviteUrl = APP_URL + '/?invite=' + req.user.invite_code;
  const senderName = req.user.name || req.user.email.split('@')[0];
  const recipientName = (to_name && to_name.trim()) ? to_name.trim() : to_email.split('@')[0];

  if (!RESEND_API_KEY) {
    console.log('\n Invite email (dev mode) to ' + to_email + ': ' + inviteUrl + '\n');
    return res.json({ message: 'Dev mode: invite link printed to server logs', dev_link: inviteUrl });
  }

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: to_email,
      subject: senderName + ' is inviting you to Brownie Points',
      html: '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:2rem;background:#3D1A00;border-radius:16px;">'
        + '<p style="font-size:40px;margin:0 0 8px;">🤝</p>'
        + '<h2 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#F5C400;">You've been invited!</h2>'
        + '<p style="color:rgba(245,196,0,0.75);margin:0 0 8px;font-size:15px;line-height:1.5;"><strong style="color:#F5C400;">' + senderName + '</strong> wants to track favours with you on Brownie Points.</p>'
        + '<p style="color:rgba(245,196,0,0.6);margin:0 0 24px;font-size:14px;line-height:1.5;">Hi ' + recipientName + '! Click below to join and connect with ' + senderName + ' automatically.</p>'
        + '<a href="' + inviteUrl + '" style="display:inline-block;background:#F5C400;color:#3D1A00;padding:14px 32px;border-radius:50px;text-decoration:none;font-size:15px;font-weight:800;">Accept invite 🤝</a>'
        + '<p style="color:rgba(245,196,0,0.35);font-size:12px;margin-top:24px;">Brownie Points helps friends track favours. If you weren't expecting this, you can safely ignore it.</p>'
        + '</div>'
    });
    res.json({ message: 'Invite sent to ' + to_email });
  } catch (e) {
    console.error('Resend invite error:', e);
    res.status(500).json({ error: 'Failed to send invite email' });
  }
});

// ─── Friends ──────────────────────────────────────────────────────────────────

app.post('/api/friends/request', requireAuth, (req, res) => {
  const { invite_code } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE invite_code = ?').get(invite_code?.toUpperCase());
  if (!target) return res.status(404).json({ error: 'Invite code not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
  const existing = db.prepare('SELECT * FROM friendships WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)').get(req.user.id, target.id, target.id, req.user.id);
  if (existing) return res.status(400).json({ error: 'Already connected or pending' });
  db.prepare('INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, ?)').run(req.user.id, target.id, 'pending');
  res.json({ message: 'Request sent', target: { id: target.id, name: target.name } });
});

app.get('/api/friends/pending', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT f.id, u.id as user_id, u.name, u.invite_code FROM friendships f JOIN users u ON u.id = f.user_id WHERE f.friend_id = ? AND f.status = 'pending'`).all(req.user.id);
  res.json(rows);
});

app.patch('/api/friends/:id', requireAuth, (req, res) => {
  const { action } = req.body;
  const friendship = db.prepare('SELECT * FROM friendships WHERE id = ? AND friend_id = ?').get(req.params.id, req.user.id);
  if (!friendship) return res.status(404).json({ error: 'Request not found' });
  if (action === 'accept') {
    db.prepare("UPDATE friendships SET status='accepted' WHERE id=?").run(friendship.id);
    db.prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?,?,'accepted')").run(req.user.id, friendship.user_id);
    res.json({ message: 'Friend added' });
  } else {
    db.prepare('DELETE FROM friendships WHERE id=?').run(friendship.id);
    res.json({ message: 'Request declined' });
  }
});

app.get('/api/friends', requireAuth, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.name, u.invite_code,
      COALESCE(SUM(CASE WHEN fv.logged_by = ? THEN fv.points * fv.direction ELSE 0 END), 0) AS balance,
      COUNT(fv.id) as favour_count
    FROM friendships fs JOIN users u ON u.id = fs.friend_id
    LEFT JOIN favours fv ON ((fv.from_user=? AND fv.to_user=u.id) OR (fv.from_user=u.id AND fv.to_user=?))
    WHERE fs.user_id = ? AND fs.status = 'accepted'
    GROUP BY u.id
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(friends);
});

app.get('/api/friends/:friendId/favours', requireAuth, (req, res) => {
  const favours = db.prepare(`
    SELECT fv.*, u.name as logged_by_name FROM favours fv JOIN users u ON u.id = fv.logged_by
    WHERE (fv.from_user=? AND fv.to_user=?) OR (fv.from_user=? AND fv.to_user=?)
    ORDER BY fv.created_at DESC
  `).all(req.user.id, req.params.friendId, req.params.friendId, req.user.id);
  res.json(favours);
});

app.post('/api/friends/:friendId/favours', requireAuth, (req, res) => {
  const { friendId } = req.params;
  const { description, points, direction } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });
  if (![1, -1].includes(direction)) return res.status(400).json({ error: 'Direction must be 1 or -1' });
  const friendship = db.prepare("SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'").get(req.user.id, friendId);
  if (!friendship) return res.status(403).json({ error: 'Not friends' });
  const from = direction === -1 ? req.user.id : friendId;
  const to   = direction === -1 ? friendId : req.user.id;
  const result = db.prepare('INSERT INTO favours (from_user,to_user,description,points,direction,logged_by) VALUES (?,?,?,?,?,?)').run(from, to, description, points || 1, direction, req.user.id);
  res.json({ id: result.lastInsertRowid, message: 'Favour logged' });
});

// ─── Groups ───────────────────────────────────────────────────────────────────

// Create a group manually
app.post('/api/groups', requireAuth, (req, res) => {
  const { name, emoji, member_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Group name required' });

  const result = db.prepare('INSERT INTO groups (name, emoji, created_by) VALUES (?, ?, ?)').run(name.trim(), emoji || '👥', req.user.id);
  const groupId = result.lastInsertRowid;

  // Creator is auto-joined
  db.prepare("INSERT INTO group_members (group_id, user_id, status) VALUES (?, ?, 'accepted')").run(groupId, req.user.id);

  // Invite specified members (must be friends)
  if (Array.isArray(member_ids)) {
    for (const uid of member_ids) {
      const isFriend = db.prepare("SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'").get(req.user.id, uid);
      if (isFriend) {
        db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, status) VALUES (?, ?, 'pending')").run(groupId, uid);
      }
    }
  }

  res.json({ id: groupId, name: name.trim(), emoji: emoji || '👥' });
});

// Get all groups for current user (accepted)
app.get('/api/groups', requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.emoji, g.created_by,
      COUNT(DISTINCT gm2.user_id) as member_count
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'accepted'
    LEFT JOIN group_members gm2 ON gm2.group_id = g.id AND gm2.status = 'accepted'
    GROUP BY g.id
  `).all(req.user.id);
  res.json(groups);
});

// Get group detail with member balances
app.get('/api/groups/:id', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const membership = db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND status='accepted'").get(req.params.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const members = db.prepare(`
    SELECT u.id, u.name,
      COALESCE(SUM(CASE WHEN fv.logged_by=? THEN fv.points * fv.direction ELSE 0 END), 0) AS balance,
      COUNT(fv.id) as favour_count
    FROM group_members gm JOIN users u ON u.id = gm.user_id
    LEFT JOIN favours fv ON ((fv.from_user=? AND fv.to_user=u.id) OR (fv.from_user=u.id AND fv.to_user=?))
    WHERE gm.group_id = ? AND gm.status = 'accepted' AND u.id != ?
    GROUP BY u.id
  `).all(req.user.id, req.user.id, req.user.id, req.params.id, req.user.id);

  const totalBalance = members.reduce((s, m) => s + m.balance, 0);
  res.json({ ...group, members, totalBalance });
});

// Pending group invites for current user
app.get('/api/groups/pending', requireAuth, (req, res) => {
  const invites = db.prepare(`
    SELECT g.id, g.name, g.emoji, u.name as invited_by_name
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    JOIN users u ON u.id = g.created_by
    WHERE gm.user_id = ? AND gm.status = 'pending'
  `).all(req.user.id);
  res.json(invites);
});

// Accept / decline group invite
app.patch('/api/groups/:id/membership', requireAuth, (req, res) => {
  const { action } = req.body;
  const membership = db.prepare('SELECT * FROM group_members WHERE group_id=? AND user_id=? AND status=?').get(req.params.id, req.user.id, 'pending');
  if (!membership) return res.status(404).json({ error: 'Invite not found' });
  if (action === 'accept') {
    db.prepare("UPDATE group_members SET status='accepted' WHERE group_id=? AND user_id=?").run(req.params.id, req.user.id);
    res.json({ message: 'Joined group' });
  } else {
    db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(req.params.id, req.user.id);
    res.json({ message: 'Invite declined' });
  }
});

// Invite a friend to a group
app.post('/api/groups/:id/invite', requireAuth, (req, res) => {
  const { user_id } = req.body;
  const group = db.prepare('SELECT * FROM groups WHERE id=?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const isMember = db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND status='accepted'").get(req.params.id, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  const isFriend = db.prepare("SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'").get(req.user.id, user_id);
  if (!isFriend) return res.status(400).json({ error: 'Can only invite friends' });
  db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, status) VALUES (?, ?, 'pending')").run(req.params.id, user_id);
  res.json({ message: 'Invited' });
});

// Suggest groups based on common friends
app.get('/api/groups/suggestions', requireAuth, (req, res) => {
  // Find all friends-of-friends clusters not already in a group together
  const myFriends = db.prepare("SELECT friend_id FROM friendships WHERE user_id=? AND status='accepted'").all(req.user.id).map(r => r.friend_id);
  if (myFriends.length < 2) return res.json([]);

  // Find pairs of my friends who are also friends with each other
  const suggestions = [];
  const seen = new Set();

  for (let i = 0; i < myFriends.length; i++) {
    for (let j = i + 1; j < myFriends.length; j++) {
      const a = myFriends[i], b = myFriends[j];
      const areFriends = db.prepare("SELECT 1 FROM friendships WHERE user_id=? AND friend_id=? AND status='accepted'").get(a, b);
      if (areFriends) {
        const key = [a, b].sort().join('-');
        if (!seen.has(key)) {
          seen.add(key);
          const uA = db.prepare('SELECT id, name FROM users WHERE id=?').get(a);
          const uB = db.prepare('SELECT id, name FROM users WHERE id=?').get(b);
          suggestions.push({ members: [uA, uB], suggested_name: `${uA.name} & ${uB.name}` });
        }
      }
    }
  }

  res.json(suggestions.slice(0, 5));
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get('/api/dashboard', requireAuth, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.name,
      COALESCE(SUM(fv.points * fv.direction), 0) AS balance,
      COUNT(fv.id) as favour_count
    FROM friendships fs JOIN users u ON u.id = fs.friend_id
    LEFT JOIN favours fv ON ((fv.from_user=? AND fv.to_user=u.id) OR (fv.from_user=u.id AND fv.to_user=?)) AND fv.logged_by=?
    WHERE fs.user_id=? AND fs.status='accepted'
    GROUP BY u.id ORDER BY balance DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id);

  const groups = db.prepare(`
    SELECT g.id, g.name, g.emoji,
      COUNT(DISTINCT gm2.user_id) as member_count
    FROM groups g
    JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=? AND gm.status='accepted'
    LEFT JOIN group_members gm2 ON gm2.group_id=g.id AND gm2.status='accepted'
    GROUP BY g.id
  `).all(req.user.id);

  res.json({
    totalBalance: friends.reduce((s, f) => s + f.balance, 0),
    oweYou: friends.filter(f => f.balance > 0).reduce((s, f) => s + f.balance, 0),
    youOwe: friends.filter(f => f.balance < 0).reduce((s, f) => s + Math.abs(f.balance), 0),
    friends,
    groups
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.listen(PORT, () => console.log(`🍫 Brownie Points on port ${PORT}`));
