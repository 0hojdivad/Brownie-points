# 🍫 Brownie Points

Track favours between friends. Who owes who — always know.

## Stack
- **Backend**: Node.js + Express
- **Database**: SQLite (via better-sqlite3)
- **Frontend**: Vanilla HTML/CSS/JS (served statically from `/public`)

---

## Local development

```bash
# Install dependencies
npm install

# Start the server (with auto-reload)
npm run dev

# Open in browser
open http://localhost:3000
```

---

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select your repo
4. Railway auto-detects Node.js and runs `npm start`
5. Go to **Settings → Networking → Generate Domain** to get your public URL

**Environment variables** (optional):
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `DB_PATH` | `./data.db` | Path to SQLite database file |

> ⚠️ Railway's free tier uses ephemeral storage — the SQLite file resets on redeploy.
> For persistent storage on Railway, add a **Railway Volume** and set `DB_PATH=/data/data.db`.

---

## Deploy to Render

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Set:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
5. Click Deploy

**For persistent SQLite on Render:**
- Add a **Disk** (under Advanced) mounted at `/data`
- Set env var `DB_PATH=/data/data.db`

---

## API Reference

All endpoints (except `POST /api/users`) require the `X-User-Id` header.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/users` | Register a new user |
| `GET` | `/api/me` | Get current user profile |
| `GET` | `/api/dashboard` | Dashboard summary + leaderboard |
| `GET` | `/api/friends` | List all accepted friends with balances |
| `GET` | `/api/friends/pending` | Incoming friend requests |
| `POST` | `/api/friends/request` | Send a friend request by invite code |
| `PATCH` | `/api/friends/:id` | Accept or decline a request |
| `GET` | `/api/friends/:id/favours` | Favour history with a friend |
| `POST` | `/api/friends/:id/favours` | Log a new favour |

---

## Notes

- Users are identified by a UUID stored in `localStorage` — no passwords needed
- Each user gets a unique `BP-XXXX` invite code for adding friends
- To use across devices, copy your User ID from the Profile tab and paste it on the other device
