# SPINOVA Backend — Phase 1 (Auth + Wallet)

This is the real backend from the Master Plan: Phase 1. It replaces fake
client-side login and balance with a real server, a real database, and
real password hashing.

## What's in this phase

- Register / login / logout with a real database (mobile number + password)
- Passwords hashed with bcrypt (never stored in plain text)
- JWT access tokens (15 min) + rotating refresh tokens (7 days, httpOnly cookie)
- Rate limiting on login/register (Redis-backed)
- A real wallet: balance lives in Postgres, never in the browser
- Every balance change recorded as a transaction (audit trail)
- Row-locking so two simultaneous bets can't both succeed off the same balance

## One-time setup

### 1. Install Docker Desktop
This runs Postgres (the database) and Redis (used for rate limiting) for you,
without installing anything else manually. Download from docker.com,
install it like any other app, then open it once so it's running.

### 2. Install Node.js
If you don't already have it: download the LTS version from nodejs.org.

### 3. Start the databases
In this folder, run:
```
docker-compose up -d
```
This starts Postgres and Redis in the background. You can leave them running.

### 4. Install backend dependencies
```
npm install
```

### 5. Set up your environment file
```
cp .env.example .env
```
Then open `.env` and replace `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`
with random strings. Easiest way — run this twice and paste each result in:
```
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
Everything else in `.env.example` already matches docker-compose, so you
can leave the rest as-is for local dev.

### 6. Create the database tables
```
npm run migrate
```
You should see "All migrations completed."

### 7. Start the backend
```
npm run dev
```
You should see "SPINOVA backend running on http://localhost:4000"

## Testing it works

With the server running, in a separate terminal:

```bash
# Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"mobile":"01712345678","password":"test123","confirmPassword":"test123","name":"Test User"}'

# Login
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"mobile":"01712345678","password":"test123"}'
```

Copy the `accessToken` from the login response, then:

```bash
# Check balance (replace YOUR_TOKEN)
curl http://localhost:4000/api/wallet/balance \
  -H "Authorization: Bearer YOUR_TOKEN"
```

You should get `{"balance":0}` — a real number from the database, not a
fake `1000` from React state.

## What's NOT done yet (later phases)

- Frontend isn't connected to this yet (next step)
- No real money/payment processor (Phase 5 — Toripay)
- No multiplayer game servers yet (Phase 2 — WinGo/Crash/K3)
- No slots backend yet (Phase 4)

## Folder guide

```
src/
  app.js              entry point, wires everything together
  db/pool.js          Postgres connection + transaction helper
  db/redis.js         Redis connection (rate limiting)
  db/migrate.js       runs the SQL migration files
  middleware/auth.js       checks the JWT on protected routes
  middleware/rateLimiter.js  login/register/global rate limits
  middleware/sanitize.js     server-side input validation (mirrors frontend)
  services/jwtService.js     creates/verifies tokens
  services/walletService.js  the only place balance changes happen
  routes/auth.js       register, login, refresh, logout, /me
  routes/wallet.js     balance, deposit, withdraw, transaction history
migrations/001_init.sql   database schema
```
