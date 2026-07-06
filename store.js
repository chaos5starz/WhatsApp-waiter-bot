// store.js
// File-based persistence: session state, completed order log, and full
// message history per chat (needed for the dashboard's chat view).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ORDERS_LOG_FILE = path.join(DATA_DIR, 'orders_log.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
  if (!fs.existsSync(ORDERS_LOG_FILE)) fs.writeFileSync(ORDERS_LOG_FILE, '[]');
  if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, '{}');
}

function loadSessions() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read sessions.json, starting fresh:', err);
    return {};
  }
}

function saveSessions(sessions) {
  ensureDataFiles();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function appendCompletedOrder(order) {
  ensureDataFiles();
  const log = JSON.parse(fs.readFileSync(ORDERS_LOG_FILE, 'utf8'));
  log.push(order);
  fs.writeFileSync(ORDERS_LOG_FILE, JSON.stringify(log, null, 2));
}

// ---- Message history (per chat, for the dashboard chat view) ----

function loadAllMessages() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read messages.json, starting fresh:', err);
    return {};
  }
}

function saveAllMessages(all) {
  ensureDataFiles();
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(all, null, 2));
}

function getMessages(chatId) {
  const all = loadAllMessages();
  return all[chatId] || [];
}

// sender: 'customer' | 'bot' | 'agent'
// type: 'text' | 'image' | 'document'
function appendMessage(chatId, { sender, type, text, mediaFile }) {
  const all = loadAllMessages();
  if (!all[chatId]) all[chatId] = [];
  const entry = {
    sender,
    type: type || 'text',
    text: text || '',
    mediaFile: mediaFile || null, // filename inside data/media, if any
    timestamp: Date.now(),
  };
  all[chatId].push(entry);
  saveAllMessages(all);
  return entry;
}

module.exports = {
  loadSessions,
  saveSessions,
  appendCompletedOrder,
  getMessages,
  appendMessage,
  MEDIA_DIR,
};
