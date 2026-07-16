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

// 15MB comfortably covers boarding passes, ID scans, and phone-camera
// photos (usually 3-8MB) while blocking anything unreasonably large that
// could fill up disk on a low-cost VPS.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: MAX_UPLOAD_BYTES } });

// Resolves `filename` against MEDIA_DIR and rejects anything that would
// escape it (e.g. "../../.env" or an absolute path). path.basename() strips
// directory components first; the resolve+startsWith check is a second
// layer in case of edge cases basename() alone doesn't catch on some OSes.
// Returns null if the filename is unsafe, otherwise the safe absolute path.
function safeMediaPath(filename) {
  const base = path.basename(filename);
  const resolvedMediaDir = path.resolve(MEDIA_DIR);
  const resolved = path.resolve(resolvedMediaDir, base);
  if (!resolved.startsWith(resolvedMediaDir + path.sep)) {
    return null;
  }
  return resolved;
}

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

    // Guard against sending into a chat that's no longer handed off - it
    // may have auto-reset after 24h of inactivity, been resolved from
    // another tab/device, or (rarest) already started a brand new inquiry.
    // Without this check, a responder who still has an old thread open
    // could send a reply that goes nowhere useful, or worse, interrupts a
    // customer's fresh conversation. Checked before ANY send path below,
    // including the /done shortcut.
    const currentSession = sessions[chatId];
    if (!currentSession || currentSession.state !== 'HANDED_OFF') {
      if (req.file) {
        fs.unlink(req.file.path, () => {}); // clean up the temp upload; ignore errors
      }
      return res.status(409).json({
        error: 'This chat is no longer active (it may have been resolved or reset). Please refresh.',
      });
    }

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

        // Keep a permanent copy in data/media so the dashboard can show it
        // later. originalname is the filename the BROWSER reported at
        // upload time - fully attacker-controlled - so it's stripped down
        // to just its basename before being used to build a path, to
        // prevent a crafted name like "../../server.js" from writing
        // outside MEDIA_DIR.
        const safeOriginalName = path.basename(req.file.originalname);
        const permanentName = `${Date.now()}-${safeOriginalName}`;
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
  // Reuses resetChatWithFarewell() (the same function the /done command and
  // its dashboard shortcut use) so this button sends the exact same
  // friendly closing message instead of resetting silently. This also
  // means the wording only ever needs to be edited in one place.
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
  // No index.html exists in public/ - without this, hitting the bare
  // domain (or the Cloudflare tunnel root URL) returns Express's default
  // "Cannot GET /" instead of sending people to the login page.
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

  // Catches errors thrown by middleware (like multer's file-size limit)
  // that happen before a route handler's own try/catch can run. Must be
  // defined with 4 arguments (err, req, res, next) - that's how Express
  // identifies it as an error handler rather than a normal middleware.
  // Placed after all routes so it only catches what nothing else handled.
  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 15MB).' });
    }
    console.error('Unhandled dashboard error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  // Without this handler, a port conflict (e.g. a previous run of this bot
  // still running in another terminal) throws as an UNCAUGHT exception and
  // kills the entire process. Just catching it and calling process.exit()
  // isn't enough on its own, though: by this point in startup, the
  // WhatsApp client (and its Puppeteer-launched Chromium) is already fully
  // running - process.exit() only kills the Node process, not Chromium as
  // a detached child, which then sits there holding a lock on
  // .wwebjs_auth/session and makes EVERY subsequent run fail with
  // "The browser is already running for ... Use a different userDataDir
  // or stop the running browser first." - even after the port conflict
  // itself is gone. So this closes the WhatsApp client (and its Chromium)
  // properly first, THEN exits.
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n❌ Port ${port} is already in use - most likely a previous run of this bot ` +
        `is still running in another terminal, or didn't shut down cleanly.\n` +
        `   Close that terminal/process, or run "npm run start:clean" (also frees ` +
        `this port and any leftover Chromium automatically), then try again.\n`
      );
    } else {
      console.error('Dashboard server error:', err);
    }
    try {
      await client.destroy();
    } catch (destroyErr) {
      console.error('Error while closing the WhatsApp client during shutdown:', destroyErr);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });

  return io;
}

module.exports = { startDashboard };