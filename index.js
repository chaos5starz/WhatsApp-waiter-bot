require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
} = require('baileys');
const pino = require('pino');

const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const {
  loadSessions,
  saveSessions,
  appendCompletedOrder,
  appendMessage,
  clearMessages,
  MEDIA_DIR,
} = require('./store');
const { notifyNewRequest, notifyClaimed } = require('./mailer');
const { startDashboard } = require('./server');
const translations = require('./translations');
const flows = require('./flows');

const RESET_AFTER_HOURS = 24;
const COMPANY_NAME = 'Alforkan Tours';
const DASHBOARD_PORT = 3000;
const AUTH_FOLDER = './baileys_auth'; // replaces .wwebjs_auth - just JSON files now, no browser profile
const MAX_RECONNECT_DELAY_MS = 60000; // cap backoff at 1 minute between reconnect attempts

let sessions = loadSessions();
let io = null; // set once the dashboard starts, used to push live updates
let sock = null; // current Baileys socket - reassigned on every reconnect
let reconnectAttempts = 0; // reset to 0 whenever connection === 'open'

// Tracks WhatsApp message text that WE (the bot, OR the dashboard on behalf
// of a human agent) just sent, so the message handler can tell "we already
// logged this" apart from "a human typed this on the phone directly" -
// Baileys reports both as fromMe: true, same ambiguity as before.
const pendingBotTexts = new Map();

// Kept as a defensive backstop even though messages.upsert's `type` field
// already separates live messages ('notify') from history-sync replay
// ('append'/'prepend') at the event level - see the messages.upsert
// listener below. Belt and suspenders in case a future Baileys version
// changes that behavior.
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

function now() {
  return Date.now();
}

// Converts Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to
// Western 0-9, so numeric menu replies work regardless of which digit
// style the customer's keyboard sends - WhatsApp delivers whatever
// characters the client typed, and parseInt() only understands Western
// digits. Only applied where we parse a numeric menu choice (ASK_LANGUAGE,
// SELECT_CATEGORY) - never applied to free-text field answers, since a
// customer's dates/names/etc. should be stored exactly as they typed them.
function normalizeDigits(str) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const easternArabicIndic = '۰۱۲۳۴۵۶۷۸۹';
  return str.replace(/[٠-٩۰-۹]/g, (d) => {
    let idx = arabicIndic.indexOf(d);
    if (idx !== -1) return String(idx);
    idx = easternArabicIndic.indexOf(d);
    if (idx !== -1) return String(idx);
    return d;
  });
}

function t(key, lang, vars) {
  const entry = translations[key];
  if (!entry) {
    console.error(`Missing translation key: ${key}`);
    return key;
  }
  let str = entry[lang] || entry.en;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      str = str.split(`{${k}}`).join(vars[k]);
    });
  }
  return str;
}

function findNode(path) {
  let options = flows.categories;
  let node = null;
  for (const id of path) {
    node = options ? options.find((o) => o.id === id) : null;
    if (!node) return null;
    options = node.subMenu ? node.subMenu.options : null;
  }
  return node;
}

function getOptionsAtPath(path) {
  if (path.length === 0) return flows.categories;
  const node = findNode(path);
  return node && node.subMenu ? node.subMenu.options : null;
}

function renderMenu(options, lang) {
  return options.map((o, i) => `${i + 1}️⃣ ${t(o.label, lang)}`).join('\n');
}

function pathLabel(path, lang) {
  let options = flows.categories;
  const labels = [];
  for (const id of path) {
    const node = options ? options.find((o) => o.id === id) : null;
    if (!node) break;
    labels.push(t(node.label, lang));
    options = node.subMenu ? node.subMenu.options : null;
  }
  return labels.join(' — ');
}

function getSession(chatId) {
  let s = sessions[chatId];
  const staleMs = RESET_AFTER_HOURS * 60 * 60 * 1000;
  if (!s || now() - (s.lastActivity || 0) > staleMs) {
    s = { state: 'IDLE', data: {}, lastActivity: now(), claimedNotified: false };
    sessions[chatId] = s;
    clearMessages(chatId);
  }
  return s;
}

function setState(chatId, state) {
  sessions[chatId].state = state;
  sessions[chatId].lastActivity = now();
  saveSessions(sessions);
}

function setData(chatId, key, value) {
  sessions[chatId].data[key] = value;
  sessions[chatId].lastActivity = now();
  saveSessions(sessions);
}

function logAndBroadcast(chatId, entryFields) {
  const entry = appendMessage(chatId, entryFields);
  if (io) io.to(`chat:${chatId}`).emit('new_message', { chatId, entry });
  return entry;
}

// Must be called BEFORE sock.sendMessage() - messages.upsert can fire
// before the sendMessage() promise resolves, so registering "after" would
// race and miss it. Same pattern as the whatsapp-web.js version.
function registerPendingText(chatId, text) {
  if (!pendingBotTexts.has(chatId)) pendingBotTexts.set(chatId, []);
  pendingBotTexts.get(chatId).push(text);
}

// Baileys sometimes wraps real message content inside an ephemeral or
// view-once envelope. Unwrap those so text/media extraction below always
// sees the actual message type, not the wrapper.
function unwrapMessage(message) {
  if (!message) return message;
  if (message.ephemeralMessage) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage) return unwrapMessage(message.documentWithCaptionMessage.message);
  return message;
}

async function botSend(chatId, text) {
  registerPendingText(chatId, text);
  await sock.sendMessage(chatId, { text });
  logAndBroadcast(chatId, { sender: 'bot', type: 'text', text });
}

async function resetChatWithFarewell(chatId) {
  const lang = (sessions[chatId] && sessions[chatId].data && sessions[chatId].data.language) || 'en';
  const farewellText = t('farewell', lang, { company: COMPANY_NAME });
  sessions[chatId] = { state: 'IDLE', data: {}, lastActivity: now(), claimedNotified: false };
  saveSessions(sessions);
  clearMessages(chatId);
  registerPendingText(chatId, farewellText);
  await sock.sendMessage(chatId, { text: farewellText });
  if (io) io.emit('pending_updated');
}

const RESET_AFTER_MS = RESET_AFTER_HOURS * 60 * 60 * 1000;

async function sweepStaleSessions() {
  const staleChatIds = Object.keys(sessions).filter((chatId) => {
    const s = sessions[chatId];
    return s && s.state !== 'IDLE' && now() - (s.lastActivity || 0) > RESET_AFTER_MS;
  });
  for (const chatId of staleChatIds) {
    try {
      console.log(`Auto-resetting stale chat ${chatId} after ${RESET_AFTER_HOURS}h of inactivity.`);
      await resetChatWithFarewell(chatId);
    } catch (err) {
      console.error(`Failed to auto-reset stale chat ${chatId}:`, err);
    }
  }
}

// ---- Pure state-machine logic, no WhatsApp-library calls except
// botSend(), which is transport-agnostic. ----
async function handleCustomerMessage(chatId, text) {
  const session = getSession(chatId);

  if (session.state === 'HANDED_OFF') {
    return;
  }

  const lang = session.data.language || 'en';

  switch (session.state) {
    case 'IDLE': {
      setState(chatId, 'ASK_LANGUAGE');
      await botSend(
        chatId,
        `Welcome to ${COMPANY_NAME}! ✈️\nPlease choose your language / يرجى اختيار اللغة:\n\n1️⃣ English\n2️⃣ العربية`
      );
      break;
    }

    case 'ASK_LANGUAGE': {
      const reply = normalizeDigits(text.trim());
      let chosen = null;
      if (reply === '1' || /english/i.test(reply)) chosen = 'en';
      else if (reply === '2' || /عرب/.test(reply)) chosen = 'ar';

      if (!chosen) {
        await botSend(
          chatId,
          `Sorry, I didn't understand. Please reply 1 for English or 2 for العربية.\n\nعذرًا، لم أفهم ردك. يرجى الرد بـ 1 للغة الإنجليزية أو 2 للغة العربية.`
        );
        break;
      }

      setData(chatId, 'language', chosen);
      setState(chatId, 'ASK_NAME');
      await botSend(chatId, t('askName', chosen, { company: COMPANY_NAME }));
      break;
    }

    case 'ASK_NAME': {
      setData(chatId, 'name', text);
      setData(chatId, 'categoryPath', []);
      setState(chatId, 'SELECT_CATEGORY');
      await botSend(
        chatId,
        `${t('menuIntro', lang, { name: text })}\n\n${renderMenu(flows.categories, lang)}`
      );
      break;
    }

    case 'SELECT_CATEGORY': {
      const currentPath = sessions[chatId].data.categoryPath || [];
      const options = getOptionsAtPath(currentPath);

      if (!options) {
        setState(chatId, 'ASK_NAME');
        await botSend(chatId, t('askName', lang, { company: COMPANY_NAME }));
        break;
      }

      const idx = parseInt(normalizeDigits(text.trim()), 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
        await botSend(chatId, `${t('invalidChoice', lang)}\n\n${renderMenu(options, lang)}`);
        break;
      }

      const chosen = options[idx];
      const newPath = [...currentPath, chosen.id];
      setData(chatId, 'categoryPath', newPath);

      if (chosen.subMenu) {
        await botSend(
          chatId,
          `${t(chosen.subMenu.prompt, lang)}\n\n${renderMenu(chosen.subMenu.options, lang)}`
        );
      } else {
        setData(chatId, 'fields', {});
        setData(chatId, 'fieldIndex', 0);
        setState(chatId, 'COLLECT_FIELD');
        await botSend(chatId, t(chosen.fields[0].prompt, lang));
      }
      break;
    }

    case 'COLLECT_FIELD': {
      const currentPath = sessions[chatId].data.categoryPath || [];
      const node = findNode(currentPath);

      if (!node || !node.fields) {
        setState(chatId, 'ASK_NAME');
        await botSend(chatId, t('askName', lang, { company: COMPANY_NAME }));
        break;
      }

      const fieldIndex = sessions[chatId].data.fieldIndex || 0;
      const field = node.fields[fieldIndex];
      const updatedFields = { ...sessions[chatId].data.fields, [field.key]: text };
      setData(chatId, 'fields', updatedFields);

      const nextIndex = fieldIndex + 1;
      if (nextIndex < node.fields.length) {
        setData(chatId, 'fieldIndex', nextIndex);
        await botSend(chatId, t(node.fields[nextIndex].prompt, lang));
      } else {
        setState(chatId, 'CONFIRM');
        const summaryLines = node.fields
          .map((f) => `${t(f.label, lang)}: ${updatedFields[f.key]}`)
          .join('\n');
        await botSend(
          chatId,
          `${t('confirmIntro', lang)}\n\n` +
          `👤 ${t('nameLabel', lang)}: ${sessions[chatId].data.name}\n` +
          `📋 ${pathLabel(currentPath, lang)}\n` +
          `${summaryLines}\n\n` +
          `${t('confirmPrompt', lang)}`
        );
      }
      break;
    }

    case 'CONFIRM': {
      const trimmed = text.trim();
      const lower = trimmed.toLowerCase();
      const isYes = lower === 'yes' || lower === 'y' || trimmed === 'نعم' || trimmed === 'ن';
      const isNo = lower === 'no' || lower === 'n' || trimmed === 'لا';

      if (isYes) {
        const currentPath = sessions[chatId].data.categoryPath || [];
        const node = findNode(currentPath);
        const fields = sessions[chatId].data.fields || {};

        const inquiryTypeEn = pathLabel(currentPath, 'en');
        const summaryLinesEn = (node.fields || []).map((f) => ({
          label: t(f.label, 'en'),
          value: fields[f.key],
        }));

        const completedInquiry = {
          chatId,
          name: sessions[chatId].data.name,
          language: lang,
          category: inquiryTypeEn,
          ...fields,
          confirmedAt: new Date().toISOString(),
        };
        appendCompletedOrder(completedInquiry);

        setData(chatId, 'inquiryType', inquiryTypeEn);
        setData(chatId, 'summaryLines', summaryLinesEn);

        setState(chatId, 'HANDED_OFF');
        sessions[chatId].claimedNotified = false;
        saveSessions(sessions);

        await botSend(chatId, t('confirmAccepted', lang));
        await notifyNewRequest(sessions[chatId].data);
        if (io) io.emit('pending_updated');
      } else if (isNo) {
        // Keep name + language, only reset the category selection - drops
        // the customer straight back at the top-level menu instead of
        // re-asking their name (which we already have).
        const keptName = sessions[chatId].data.name;
        sessions[chatId] = {
          state: 'SELECT_CATEGORY',
          data: { language: lang, name: keptName, categoryPath: [] },
          lastActivity: now(),
          claimedNotified: false,
        };
        saveSessions(sessions);
        await botSend(
          chatId,
          `${t('confirmRestart', lang, { name: keptName })}\n\n${renderMenu(flows.categories, lang)}`
        );
      } else {
        await botSend(chatId, t('confirmPrompt', lang));
      }
      break;
    }

    default: {
      console.warn(`Unrecognized session state "${session.state}" for chat ${chatId} - resetting to IDLE.`);
      setState(chatId, 'IDLE');
      break;
    }
  }
}

// ---- Handles one incoming Baileys message. Replaces the old
// client.on('message_create', ...) handler. ----
async function handleIncomingMessage(msg) {
  const chatId = msg.key.remoteJid;
  const fromMe = msg.key.fromMe;

  try {
    if (!chatId || chatId === 'status@broadcast') return;
    if (chatId.endsWith('@g.us')) return; // ignore group chats
    if (!msg.message) return; // reactions, protocol/system messages, etc. carry no content

    const msgTimestamp = Number(msg.messageTimestamp);
    if (msgTimestamp && msgTimestamp < BOOT_TIMESTAMP) return; // defensive backstop, see BOOT_TIMESTAMP comment above

    const content = unwrapMessage(msg.message);
    const text = (
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      ''
    ).trim();

    if (fromMe) {
      const pending = pendingBotTexts.get(chatId);
      if (pending) {
        const idx = pending.indexOf(text);
        if (idx !== -1) {
          pending.splice(idx, 1);
          if (pending.length === 0) pendingBotTexts.delete(chatId);
          return;
        }
      }

      const lower = text.toLowerCase();

      if (lower === '/done') {
        try {
          // "Delete for everyone" - only works on our own recent messages,
          // same limitation as message.delete(true) had before.
          await sock.sendMessage(chatId, { delete: msg.key });
        } catch (delErr) {
          console.error("Could not delete /done message (may be outside WhatsApp's delete window):", delErr);
        }
        await resetChatWithFarewell(chatId);
        return;
      }

      if (lower.startsWith('/as ')) {
        const simulatedText = text.slice(4);
        logAndBroadcast(chatId, { sender: 'customer', type: 'text', text: simulatedText });
        await handleCustomerMessage(chatId, simulatedText);
        return;
      }

      const session = sessions[chatId];
      if (session && session.state === 'HANDED_OFF') {
        logAndBroadcast(chatId, { sender: 'agent', type: 'text', text });
        if (!session.claimedNotified) {
          session.claimedNotified = true;
          saveSessions(sessions);
          await notifyClaimed({ name: session.data.name, respondedBy: null });
        }
      }
      return;
    }

    // ---- Real incoming customer message ----

    const hasMedia = !!(
      content.imageMessage || content.videoMessage || content.documentMessage ||
      content.audioMessage || content.stickerMessage
    );

    if (hasMedia) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const mimetype =
          content.imageMessage?.mimetype || content.videoMessage?.mimetype ||
          content.documentMessage?.mimetype || content.audioMessage?.mimetype ||
          content.stickerMessage?.mimetype || 'application/octet-stream';

        const rawSubtype = mimetype.split(';')[0].split('/')[1] || 'bin';
        const ext = rawSubtype.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
        const filename = `${Date.now()}-customer.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);

        let mediaType = 'document';
        if (content.imageMessage) mediaType = 'image';
        else if (content.audioMessage) mediaType = 'voice'; // covers both PTT voice notes and regular audio files

        logAndBroadcast(chatId, {
          sender: 'customer',
          type: mediaType,
          text,
          mediaFile: filename,
        });
      } catch (mediaErr) {
        console.error(`Failed to download customer media (chat: ${chatId}):`, mediaErr);
        logAndBroadcast(chatId, {
          sender: 'customer',
          type: 'text',
          text: `📎 [Media message received — could not be downloaded, ask the customer to resend or call them]`,
        });
      }

      const mediaSession = getSession(chatId);
      if (mediaSession.state !== 'HANDED_OFF') {
        const mediaLang = mediaSession.data.language || 'en';
        await botSend(chatId, t('mediaNotSupported', mediaLang));
      }
    } else if (text) {
      logAndBroadcast(chatId, { sender: 'customer', type: 'text', text });
    }

    if (text) {
      await handleCustomerMessage(chatId, text);
    }
  } catch (err) {
    console.error(`Error handling message (chat: ${chatId}, fromMe: ${fromMe}):`, err);
  }
}

console.log('Connecting to WhatsApp...');

const startupStallWarning = setTimeout(() => {
  console.warn(
    '\n⚠️  Still not connected after 60s. Check your internet connection, or delete the ' +
    'baileys_auth folder and restart to re-scan a fresh QR code if the session may be stale.\n'
  );
}, 60000);

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'error' }), // keep Baileys' own internal logging quiet - we log what matters ourselves
    browser: Browsers.ubuntu('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp (Linked Devices):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      clearTimeout(startupStallWarning);
      reconnectAttempts = 0; // fresh backoff sequence next time we disconnect
      console.log('WhatsApp bot is ready and connected.');
      if (!io) {
        io = startDashboard({
          sock,
          sessions,
          saveSessions,
          notifyClaimed,
          registerPendingText,
          resetChatWithFarewell,
          port: DASHBOARD_PORT,
        });
        const STALE_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
        setInterval(sweepStaleSessions, STALE_SESSION_SWEEP_INTERVAL_MS);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.error('WhatsApp connection closed.', lastDisconnect?.error?.message || '');
      if (loggedOut) {
        console.error(
          '\n❌ Logged out from WhatsApp. Delete the baileys_auth folder and restart to link again.\n'
        );
      } else {
        // Exponential backoff instead of an instant retry - a genuine
        // outage (no internet, DNS failure, etc.) previously caused a
        // tight reconnect loop firing multiple times per second, which
        // wastes resources and risks looking automated/abusive to
        // WhatsApp once the connection actually comes back. Starts fast
        // (1s) in case it's just a momentary blip, then backs off up to
        // MAX_RECONNECT_DELAY_MS for a longer outage. Resets to 0 the
        // moment 'open' fires again above.
        reconnectAttempts += 1;
        const delayMs = Math.min(1000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
        console.log(`Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})...`);
        setTimeout(connectToWhatsApp, delayMs);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only 'notify' is a live, just-happened message. 'append'/'prepend' are
    // history-sync replay on (re)connect - the direct equivalent of the old
    // BOOT_TIMESTAMP problem, but solved at the event level instead of by
    // filtering timestamps ourselves.
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });
}

connectToWhatsApp().catch((err) => {
  console.error('Failed to start WhatsApp connection:', err);
  process.exit(1);
});

// No Puppeteer/Chromium to clean up - shutdown is now just closing the
// socket and saving state, which sock.end() plus the socket's own
// creds.update listener already handle.
async function shutdown() {
  console.log('\nShutting down gracefully...');
  try {
    if (sock) sock.end(undefined);
  } catch (err) {
    console.error('Error while shutting down:', err);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);