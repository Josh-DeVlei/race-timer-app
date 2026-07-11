const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 5 * 1024 * 1024 });

app.use(express.static(path.join(__dirname)));

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return def; }
}
function saveJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data));
}

let users = loadJSON('users.json', []);
let runs  = loadJSON('runs.json', []);

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPw(pw) {
  return crypto.createHash('sha256').update('rt2024:' + pw).digest('hex');
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email || '', isAdmin: !!u.isAdmin, savedVehicles: u.savedVehicles || [] };
}

// Seed admin account
if (!users.find(u => u.username === 'admin')) {
  users.push({ id: 'admin', username: 'admin', password: hashPw('admin'), email: '', isAdmin: true, savedVehicles: [] });
  saveJSON('users.json', users);
}

// ── Email ─────────────────────────────────────────────────────────────────────
let mailer = null;
if (process.env.SMTP_HOST) {
  try {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log('Email configured via', process.env.SMTP_HOST);
  } catch (e) { console.warn('nodemailer not available:', e.message); }
}

async function sendMail(to, subject, text) {
  if (!mailer) return false;
  try {
    await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return true;
  } catch (e) { console.error('Mail error:', e.message); return false; }
}

// ── Reset tokens { email → { token, userId, expires } } ──────────────────────
const resetTokens = new Map();

// ── Chat history ──────────────────────────────────────────────────────────────
const messages = [];
const MAX_MSGS = 100;
let onlineCount = 0;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
wss.on('close', () => clearInterval(heartbeatInterval));

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.userId = null;
  ws.on('pong', () => { ws.isAlive = true; });

  onlineCount++;
  broadcast({ type: 'online', count: onlineCount });
  ws.send(JSON.stringify({ type: 'history', messages }));

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw);

      // ── Register ──────────────────────────────────────────────────────────
      if (msg.type === 'register') {
        const { username, password, email } = msg;
        if (!username || !password || !email)
          return ws.send(JSON.stringify({ type: 'auth_error', message: 'All fields are required' }));
        if (username.length < 3)
          return ws.send(JSON.stringify({ type: 'auth_error', message: 'Username must be at least 3 characters' }));
        if (password.length < 4)
          return ws.send(JSON.stringify({ type: 'auth_error', message: 'Password must be at least 4 characters' }));
        if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
          return ws.send(JSON.stringify({ type: 'auth_error', message: 'Username already taken' }));
        if (users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()))
          return ws.send(JSON.stringify({ type: 'auth_error', message: 'Email already registered' }));
        const user = { id: uid(), username, password: hashPw(password), email, isAdmin: false, savedVehicles: [] };
        users.push(user);
        saveJSON('users.json', users);
        ws.userId = user.id;
        ws.send(JSON.stringify({ type: 'auth_ok', user: safeUser(user) }));
      }

      // ── Login ─────────────────────────────────────────────────────────────
      if (msg.type === 'login') {
        const { username, password } = msg;
        const user = users.find(u =>
          u.username.toLowerCase() === (username || '').toLowerCase() && u.password === hashPw(password)
        );
        if (!user)
          return ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid username or password' }));
        ws.userId = user.id;
        ws.send(JSON.stringify({ type: 'auth_ok', user: safeUser(user) }));
      }

      // ── Restore session ───────────────────────────────────────────────────
      if (msg.type === 'restore_session') {
        const user = users.find(u => u.id === msg.userId);
        if (!user) return ws.send(JSON.stringify({ type: 'session_invalid' }));
        ws.userId = user.id;
        ws.send(JSON.stringify({ type: 'auth_ok', user: safeUser(user) }));
      }

      // ── Get all runs (public) ─────────────────────────────────────────────
      if (msg.type === 'get_runs') {
        ws.send(JSON.stringify({ type: 'runs', runs }));
      }

      // ── Save run ──────────────────────────────────────────────────────────
      if (msg.type === 'save_run' && ws.userId) {
        const user = users.find(u => u.id === ws.userId);
        if (!user) return;
        const run = { ...msg.run, id: uid(), userId: ws.userId, username: user.username };
        runs.push(run);
        if (runs.length > 10000) runs = runs.slice(-10000);
        saveJSON('runs.json', runs);
        broadcast({ type: 'run_added', run });
      }

      // ── Delete run ────────────────────────────────────────────────────────
      if (msg.type === 'delete_run' && ws.userId) {
        const run = runs.find(r => r.id === msg.runId);
        if (!run) return;
        const me = users.find(u => u.id === ws.userId);
        if (!me?.isAdmin && run.userId !== ws.userId) return;
        runs = runs.filter(r => r.id !== msg.runId);
        saveJSON('runs.json', runs);
        broadcast({ type: 'run_deleted', runId: msg.runId });
      }

      // ── Clear all runs (admin) ────────────────────────────────────────────
      if (msg.type === 'clear_runs' && ws.userId) {
        const me = users.find(u => u.id === ws.userId);
        if (!me?.isAdmin) return;
        runs = [];
        saveJSON('runs.json', runs);
        broadcast({ type: 'runs', runs: [] });
      }

      // ── Get all users (admin) ─────────────────────────────────────────────
      if (msg.type === 'get_users' && ws.userId) {
        const me = users.find(u => u.id === ws.userId);
        if (!me?.isAdmin) return;
        ws.send(JSON.stringify({ type: 'users', users: users.map(safeUser) }));
      }

      // ── Delete user (admin) ───────────────────────────────────────────────
      if (msg.type === 'delete_user' && ws.userId) {
        const me = users.find(u => u.id === ws.userId);
        if (!me?.isAdmin) return;
        if (msg.userId === 'admin') return;
        users = users.filter(u => u.id !== msg.userId);
        runs  = runs.filter(r => r.userId !== msg.userId);
        saveJSON('users.json', users);
        saveJSON('runs.json', runs);
        broadcast({ type: 'user_deleted', userId: msg.userId });
        broadcast({ type: 'runs', runs });
      }

      // ── Save vehicle ──────────────────────────────────────────────────────
      if (msg.type === 'save_vehicle' && ws.userId) {
        const user = users.find(u => u.id === ws.userId);
        if (!user) return;
        const { make, model, year, variant } = msg.vehicle || {};
        if (!make) return;
        if (!user.savedVehicles) user.savedVehicles = [];
        const idx = user.savedVehicles.findIndex(v => v.make === make && v.model === model && v.year === year && v.variant === variant);
        if (idx >= 0) user.savedVehicles.splice(idx, 1);
        user.savedVehicles.push({ make, model, year, variant });
        if (user.savedVehicles.length > 20) user.savedVehicles = user.savedVehicles.slice(-20);
        saveJSON('users.json', users);
        ws.send(JSON.stringify({ type: 'user_updated', user: safeUser(user) }));
      }

      // ── Update all vehicles (remove / reorder) ────────────────────────────
      if (msg.type === 'update_vehicles' && ws.userId) {
        const user = users.find(u => u.id === ws.userId);
        if (!user) return;
        user.savedVehicles = (msg.vehicles || []).slice(0, 20);
        saveJSON('users.json', users);
        ws.send(JSON.stringify({ type: 'user_updated', user: safeUser(user) }));
      }

      // ── Forgot password ───────────────────────────────────────────────────
      if (msg.type === 'forgot_password') {
        const email = (msg.email || '').toLowerCase().trim();
        const user = users.find(u => u.email && u.email.toLowerCase() === email);
        if (!user) {
          // Don't reveal whether email exists
          return ws.send(JSON.stringify({ type: 'forgot_sent', emailSent: false }));
        }
        const token = Math.floor(100000 + Math.random() * 900000).toString();
        resetTokens.set(email, { token, userId: user.id, expires: Date.now() + 15 * 60 * 1000 });
        const sent = await sendMail(
          user.email,
          'Race Timer — Password Reset Code',
          `Hi ${user.username},\n\nYour password reset code is: ${token}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, ignore this email.`
        );
        console.log(`Reset token for ${email}: ${token} (email sent: ${sent})`);
        ws.send(JSON.stringify({ type: 'forgot_sent', emailSent: sent }));
      }

      // ── Reset password ────────────────────────────────────────────────────
      if (msg.type === 'reset_password') {
        const email = (msg.email || '').toLowerCase().trim();
        const entry = resetTokens.get(email);
        if (!entry || entry.token !== msg.token || Date.now() > entry.expires)
          return ws.send(JSON.stringify({ type: 'reset_error', message: 'Invalid or expired code' }));
        const user = users.find(u => u.id === entry.userId);
        if (!user)
          return ws.send(JSON.stringify({ type: 'reset_error', message: 'Account not found' }));
        if (!msg.newPassword || msg.newPassword.length < 4)
          return ws.send(JSON.stringify({ type: 'reset_error', message: 'Password must be at least 4 characters' }));
        user.password = hashPw(msg.newPassword);
        saveJSON('users.json', users);
        resetTokens.delete(email);
        ws.send(JSON.stringify({ type: 'reset_ok' }));
      }

      // ── Chat ──────────────────────────────────────────────────────────────
      if (msg.type === 'chat' && msg.username && (msg.text || msg.image)) {
        const entry = {
          id: Date.now(),
          username: msg.username,
          text: String(msg.text || '').substring(0, 300),
          image: msg.image || null,
          time: new Date().toISOString()
        };
        messages.push(entry);
        if (messages.length > MAX_MSGS) messages.shift();
        broadcast({ type: 'message', message: entry });
      }

      if (msg.type === 'delete_msg' && msg.id) {
        const idx = messages.findIndex(m => String(m.id) === String(msg.id));
        if (idx >= 0) {
          messages.splice(idx, 1);
          broadcast({ type: 'msg_deleted', id: msg.id });
        }
      }

    } catch (e) { console.error('WS message error:', e.message); }
  });

  ws.on('close', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcast({ type: 'online', count: onlineCount });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Race Timer server v1.6 on port ${PORT}`));
