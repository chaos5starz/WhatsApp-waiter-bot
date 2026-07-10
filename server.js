// server.js
// The private dashboard A and B use. Runs an Express web server + Socket.io
// (for live updates) inside the same process as the WhatsApp bot, so it can
// send messages using the bot's existing WhatsApp session.
//
// This file exports a single function, startDashboard(...), which index.js
// calls once, handing it the WhatsApp `client`, the shared `sessions` object,
// and the store functions. Keeping it as one function avoids needing global
// variables shared awkwardly between files.

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { getMessages, appendMessage, clearMessages, MEDIA_DIR } = require('./store');
const RESPONDERS = require('./responders');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Add it to your .env file before starting the server.');
}

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads_tmp');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR });

function startDashboard({ client, sessions, saveSessions, notifyClaimed, registerPendingText, resetChatWithFarewell, port }) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // Created ONCE and reused for both Express and Socket.io below, so both
  // read/write the same in-memory session store. A separate session()
  // instance per socket connection would have its own empty store and
  // never see sessions created by HTTP login.
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

    // Special case: typing /done in the dashboard composer triggers the
    // same "reset + friendly farewell" flow as typing /done directly in
    // WhatsApp - it must NOT be forwarded to the customer as literal text.
    if (text.toLowerCase() === '/done' && !req.file) {
      await resetChatWithFarewell(chatId);
      return res.json({ ok: true });
    }

    try {
      if (req.file) {
        // Register BEFORE sendMessage - message_create can fire before the
        // sendMessage() promise resolves, so this must happen first or the
        // message_create listener in index.js won't recognize it in time
        // and will log it a second time as a "manual WhatsApp reply".
        registerPendingText(chatId, text);

        // Build MessageMedia manually from the file's bytes + multer's own
        // detected mimetype/filename, instead of MessageMedia.fromFilePath(),
        // which guesses the mimetype from the file's EXTENSION on disk.
        // Multer's default storage saves uploads under a random hash
        // filename with no extension, so fromFilePath() couldn't detect a
        // type at all - it sent media with mimetype: null, which is why
        // WhatsApp showed every file as an unopenable "Untitled" doc.
        const fileBuffer = fs.readFileSync(req.file.path);
        const media = new MessageMedia(
          req.file.mimetype,
          fileBuffer.toString('base64'),
          req.file.originalname
        );
        await client.sendMessage(chatId, media, { caption: text || undefined });

        // Keep a permanent copy in data/media so the dashboard can show it later.
        const permanentName = `${Date.now()}-${req.file.originalname}`;
        fs.copyFileSync(req.file.path, path.join(MEDIA_DIR, permanentName));
        fs.unlinkSync(req.file.path); // remove the temp upload copy

        const entry = appendMessage(chatId, {
          sender: 'agent',
          type: req.file.mimetype.startsWith('image/') ? 'image' : 'document',
          text,
          mediaFile: permanentName,
        });
        io.to(`chat:${chatId}`).emit('new_message', { chatId, entry });
      } else if (text) {
        registerPendingText(chatId, text);
        await client.sendMessage(chatId, text);
        const entry = appendMessage(chatId, { sender: 'agent', type: 'text', text });
        io.to(`chat:${chatId}`).emit('new_message', { chatId, entry });
      } else {
        return res.status(400).json({ error: 'Nothing to send' });
      }

      // First reply after handoff? Let the OTHER responder know it's
      // claimed - we know who's replying because they're logged in
      // (req.session.username), so we can exclude them from the email,
      // unlike a manual WhatsApp reply where we can't tell A from B.
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
  app.post('/api/chat/:chatId/resolve', requireLogin, (req, res) => {
    const chatId = req.params.chatId;
    sessions[chatId] = { state: 'IDLE', data: {}, lastActivity: Date.now(), claimedNotified: false };
    saveSessions(sessions);
    clearMessages(chatId); // fresh transcript for this chat's next inquiry
    io.emit('pending_updated');
    res.json({ ok: true });
  });

  // ---- Serve uploaded/received media files (auth-protected) ----
  app.get('/media/:filename', requireLogin, (req, res) => {
    const filePath = path.join(MEDIA_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(filePath);
  });

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

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });

  return io;
}

module.exports = { startDashboard };