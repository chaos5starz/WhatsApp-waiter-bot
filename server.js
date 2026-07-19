// server.js
// The private dashboard A and B use. Runs an Express web server + Socket.io
// (for live updates) inside the same process as the WhatsApp bot, so it can
// send messages using the bot's existing Baileys connection.
//
// This file exports a single function, startDashboard(...), which index.js
// calls once, handing it the Baileys `sock`, the shared `sessions` object,
// and the store functions. Keeping it as one function avoids needing global
// variables shared awkwardly between files.

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { getMessages, appendMessage, clearMessages, MEDIA_DIR } = require('./store');
const RESPONDERS = require('./responders');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Add it to your .env file before starting the server.');
}

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads_tmp');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } });

function safeMediaPath(filename) {
  const base = path.basename(filename);
  const resolvedMediaDir = path.resolve(MEDIA_DIR);
  const resolved = path.resolve(resolvedMediaDir, base);
  if (!resolved.startsWith(resolvedMediaDir + path.sep)) {
    return null;
  }
  return resolved;
}

function startDashboard({ sock, sessions, saveSessions, notifyClaimed, registerPendingText, resetChatWithFarewell, port }) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  });

  app.use(express.json());
  app.use(sessionMiddleware);

  // ---- Auth ----
  function requireLogin(req, res, next) {
    if (req.session && req.session.loggedIn) return next();
    return res.status(401).json({ error: 'Not logged in' });
  }

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const match = RESPONDERS.find((r) => r.username === username && r.password === password);
    if (match) {
      req.session.loggedIn = true;
      req.session.username = username;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ---- Pending chats list ----
  app.get('/api/pending', requireLogin, (req, res) => {
    const pending = Object.entries(sessions)
      .filter(([, s]) => s.state === 'HANDED_OFF')
      .map(([chatId, s]) => ({ chatId, data: s.data }));
    res.json(pending);
  });

  // ---- Message history for one chat ----
  app.get('/api/chat/:chatId/messages', requireLogin, (req, res) => {
    res.json(getMessages(req.params.chatId));
  });

  // ---- Send a text and/or file message to a customer ----
  app.post('/api/chat/:chatId/send', requireLogin, upload.single('file'), async (req, res) => {
    const chatId = req.params.chatId;
    const text = (req.body.text || '').trim();

    const currentSession = sessions[chatId];
    if (!currentSession || currentSession.state !== 'HANDED_OFF') {
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(409).json({
        error: 'This chat is no longer active (it may have been resolved or reset). Please refresh.',
      });
    }

    if (text.toLowerCase() === '/done' && !req.file) {
      await resetChatWithFarewell(chatId);
      return res.json({ ok: true });
    }

    try {
      if (req.file) {
        // Register BEFORE sendMessage - messages.upsert can fire before the
        // sendMessage() promise resolves, so this must happen first or the
        // handler in index.js won't recognize it in time and will log it a
        // second time as a "manual WhatsApp reply".
        registerPendingText(chatId, text);

        // Baileys takes media as a raw buffer + explicit mimetype/fileName -
        // no separate "MessageMedia" class to build like whatsapp-web.js had.
        // Decide image vs. document the same way the dashboard already
        // categorizes stored messages below, so what gets sent matches what
        // gets logged.
        const fileBuffer = fs.readFileSync(req.file.path);
        const isImage = req.file.mimetype.startsWith('image/');

        if (isImage) {
          await sock.sendMessage(chatId, {
            image: fileBuffer,
            mimetype: req.file.mimetype,
            caption: text || undefined,
          });
        } else {
          await sock.sendMessage(chatId, {
            document: fileBuffer,
            mimetype: req.file.mimetype,
            fileName: req.file.originalname,
            caption: text || undefined,
          });
        }

        const safeOriginalName = path.basename(req.file.originalname);
        const permanentName = `${Date.now()}-${safeOriginalName}`;
        fs.copyFileSync(req.file.path, path.join(MEDIA_DIR, permanentName));
        fs.unlinkSync(req.file.path);

        const entry = appendMessage(chatId, {
          sender: 'agent',
          type: isImage ? 'image' : 'document',
          text,
          mediaFile: permanentName,
        });
        io.to(`chat:${chatId}`).emit('new_message', { chatId, entry });
      } else if (text) {
        registerPendingText(chatId, text);
        await sock.sendMessage(chatId, { text });
        const entry = appendMessage(chatId, { sender: 'agent', type: 'text', text });
        io.to(`chat:${chatId}`).emit('new_message', { chatId, entry });
      } else {
        return res.status(400).json({ error: 'Nothing to send' });
      }

      const s = sessions[chatId];
      if (s && s.state === 'HANDED_OFF' && !s.claimedNotified) {
        s.claimedNotified = true;
        saveSessions(sessions);
        await notifyClaimed({ name: s.data.name, respondedBy: req.session.username });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Dashboard send error:', err);
      res.status(500).json({ error: 'Failed to send' });
    }
  });

  // ---- Mark a chat resolved (equivalent to the /done WhatsApp command) ----
  app.post('/api/chat/:chatId/resolve', requireLogin, async (req, res) => {
    const chatId = req.params.chatId;
    await resetChatWithFarewell(chatId);
    res.json({ ok: true });
  });

  // ---- Serve uploaded/received media files (auth-protected) ----
  app.get('/media/:filename', requireLogin, (req, res) => {
    const filePath = safeMediaPath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(filePath);
  });

  // ---- Root redirect ----
  app.get('/', (req, res) => res.redirect('/login.html'));

  // ---- Serve the frontend files ----
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Socket.io: let dashboard clients "join" a specific chat's room ----
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.on('connection', (socket) => {
    if (!socket.request.session || !socket.request.session.loggedIn) {
      socket.disconnect();
      return;
    }
    socket.on('join_chat', (chatId) => {
      socket.join(`chat:${chatId}`);
    });
  });

  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 15MB).' });
    }
    console.error('Unhandled dashboard error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  // No Puppeteer/Chromium involved anymore, so a port conflict no longer
  // risks leaving an orphaned browser holding a session lock - closing the
  // Baileys socket cleanly is enough before exiting.
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n❌ Port ${port} is already in use - most likely a previous run of this bot ` +
        `is still running in another terminal, or didn't shut down cleanly.\n` +
        `   Close that terminal/process, then try again.\n`
      );
    } else {
      console.error('Dashboard server error:', err);
    }
    try {
      if (sock) sock.end(undefined);
    } catch (destroyErr) {
      console.error('Error while closing the WhatsApp connection during shutdown:', destroyErr);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });

  return io;
}

module.exports = { startDashboard };