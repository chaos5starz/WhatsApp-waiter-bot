require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');

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

let sessions = loadSessions();
let io = null; // set once the dashboard starts, used to push live updates

// Tracks WhatsApp message text that WE (the bot, OR the dashboard on behalf
// of a human agent) just sent, so the message_create listener can tell
// "we already logged this" apart from "a human typed this on the phone
// directly" - WhatsApp reports both as fromMe: true, there's no other way
// to distinguish them.
const pendingBotTexts = new Map();

function now() {
  return Date.now();
}

// Looks up a translated string by key + language, falling back to English
// if a language is somehow missing (shouldn't happen, but avoids a crash
// or blank message over a missing entry). Supports {placeholder} filling,
// e.g. t('askName', 'ar', { company: 'Alforkan Tours' }).
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

// Walks flows.categories following `path` (an array of node ids) and
// returns the node at the end of that path, or null if the path is
// invalid. An empty path has no "current node" - that's the root menu.
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

// Returns the list of selectable options at the given path - the top-level
// categories if path is empty, or a sub-menu's options if the node at that
// path has one. Returns null if the path leads to a leaf (a category with
// fields, not further choices) or is invalid.
function getOptionsAtPath(path) {
  if (path.length === 0) return flows.categories;
  const node = findNode(path);
  return node && node.subMenu ? node.subMenu.options : null;
}

// Builds a translated, numbered menu string from a list of options.
function renderMenu(options, lang) {
  return options.map((o, i) => `${i + 1}️⃣ ${t(o.label, lang)}`).join('\n');
}

// Builds a human-readable trail of category labels for a given path, e.g.
// "Umrah trips — Visa only — 1 month". Used both for the confirmation
// message shown to the customer (in their language) and for the internal
// dashboard/email record (always forced to English - see the CONFIRM
// handler below for why).
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

// Logs a message to history AND pushes it live to any dashboard viewing this chat.
function logAndBroadcast(chatId, entryFields) {
  const entry = appendMessage(chatId, entryFields);
  if (io) io.to(`chat:${chatId}`).emit('new_message', { chatId, entry });
  return entry;
}

// Records that a fromMe message with this exact text is about to be sent
// through the bot's WhatsApp session (either an automated bot reply via
// botSend, or a dashboard agent reply via server.js) and has ALREADY been
// logged by whoever is sending it. Must be called BEFORE client.sendMessage()
// - message_create can fire before the sendMessage() promise resolves, so
// registering "after" would race and miss it.
function registerPendingText(chatId, text) {
  if (!pendingBotTexts.has(chatId)) pendingBotTexts.set(chatId, []);
  pendingBotTexts.get(chatId).push(text);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('Scan this QR code with WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp bot is ready and connected.');
  io = startDashboard({
    client,
    sessions,
    saveSessions,
    notifyClaimed,
    registerPendingText,
    resetChatWithFarewell,
    port: DASHBOARD_PORT,
  });
});

client.on('auth_failure', (msg) => {
  console.error('Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
  console.error('Client was disconnected:', reason);
});

// Sends a bot message AND logs/broadcasts it, so the dashboard's chat view
// shows bot replies too, not just customer and agent messages.
async function botSend(chatId, text) {
  registerPendingText(chatId, text); // recorded BEFORE sending, on purpose
  await client.sendMessage(chatId, text);
  logAndBroadcast(chatId, { sender: 'bot', type: 'text', text });
}

// Resets a chat back to IDLE and sends the customer a friendly closing
// message instead of a raw "bot reset" system message. Shared by both the
// /done command (typed directly in WhatsApp) and the dashboard's /done
// shortcut, so the reset logic and wording only need to exist in one place.
// Uses whichever language the chat had selected, falling back to English
// if the chat never got that far (e.g. reset before language was picked).
async function resetChatWithFarewell(chatId) {
  const lang = (sessions[chatId] && sessions[chatId].data && sessions[chatId].data.language) || 'en';
  const farewellText = t('farewell', lang, { company: COMPANY_NAME });
  sessions[chatId] = { state: 'IDLE', data: {}, lastActivity: now(), claimedNotified: false };
  saveSessions(sessions);
  clearMessages(chatId);
  registerPendingText(chatId, farewellText);
  await client.sendMessage(chatId, farewellText);
  if (io) io.emit('pending_updated');
}

async function handleCustomerMessage(chatId, text) {
  const session = getSession(chatId);

  if (session.state === 'HANDED_OFF') {
    return;
  }

  const lang = session.data.language || 'en';

  switch (session.state) {
    // Language hasn't been picked yet, so this message is shown in both
    // languages at once - it's the one place in the whole flow where we
    // can't yet know which language to reply in.
    case 'IDLE': {
      setState(chatId, 'ASK_LANGUAGE');
      await botSend(
        chatId,
        `Welcome to ${COMPANY_NAME}! ✈️\nPlease choose your language / يرجى اختيار اللغة:\n\n1️⃣ English\n2️⃣ العربية`
      );
      break;
    }

    case 'ASK_LANGUAGE': {
      const reply = text.trim();
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

    // Generic menu/sub-menu navigation - handles the top-level menu AND
    // every sub-menu (Tourism, Umrah, Visa duration) the same way, driven
    // entirely by categoryPath and flows.js. No category-specific code here.
    case 'SELECT_CATEGORY': {
      const currentPath = sessions[chatId].data.categoryPath || [];
      const options = getOptionsAtPath(currentPath);

      if (!options) {
        // Shouldn't happen in normal use - safety net in case of a
        // corrupted/edited session. Restart at the name step.
        setState(chatId, 'ASK_NAME');
        await botSend(chatId, t('askName', lang, { company: COMPANY_NAME }));
        break;
      }

      const idx = parseInt(text.trim(), 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
        await botSend(chatId, `${t('invalidChoice', lang)}\n\n${renderMenu(options, lang)}`);
        break;
      }

      const chosen = options[idx];
      const newPath = [...currentPath, chosen.id];
      setData(chatId, 'categoryPath', newPath);

      if (chosen.subMenu) {
        // Still navigating - show the next sub-menu, stay in this state.
        await botSend(
          chatId,
          `${t(chosen.subMenu.prompt, lang)}\n\n${renderMenu(chosen.subMenu.options, lang)}`
        );
      } else {
        // Reached a leaf category - start collecting its fields.
        setData(chatId, 'fields', {});
        setData(chatId, 'fieldIndex', 0);
        setState(chatId, 'COLLECT_FIELD');
        await botSend(chatId, t(chosen.fields[0].prompt, lang));
      }
      break;
    }

    // Generic field collector - asks each field in the current leaf
    // category's `fields` list in order, one per customer message.
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

        // English labels only, regardless of the customer's chosen
        // language - this is what A/B see on the dashboard and what goes
        // into the notification email, and both should stay in one
        // consistent language rather than switching per customer.
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
        sessions[chatId] = {
          state: 'ASK_NAME',
          data: { language: lang },
          lastActivity: now(),
          claimedNotified: false,
        };
        saveSessions(sessions);
        await botSend(chatId, t('confirmRestart', lang));
      } else {
        await botSend(chatId, t('confirmPrompt', lang));
      }
      break;
    }

    default: {
      setState(chatId, 'IDLE');
      break;
    }
  }
}

client.on('message_create', async (message) => {
  try {
    const chat = await message.getChat();
    if (chat.isGroup) return;

    const chatId = message.from === 'status@broadcast' ? null : (message.fromMe ? message.to : message.from);
    if (!chatId) return;

    const text = (message.body || '').trim();

    if (message.fromMe) {
      // If this text matches something the bot OR the dashboard just
      // queued to send, it's already been logged by whoever sent it -
      // don't log it again as a "manual reply typed on the phone".
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

      if (lower === '/done')
      {
        // Delete the "/done" command itself from the real chat so the
        // customer never sees it - only the friendly farewell that follows.
        try {
          await message.delete(true);
        } catch (delErr) {
          console.error('Could not delete /done message (may be outside WhatsApp\'s delete window):', delErr);
        }
        await resetChatWithFarewell(chatId);
        return;
      }

      if (lower.startsWith('/as '))
      {
        const simulatedText = text.slice(4);
        logAndBroadcast(chatId, { sender: 'customer', type: 'text', text: simulatedText });
        await handleCustomerMessage(chatId, simulatedText);
        return;
      }

      // A normal manual reply sent directly from WhatsApp (not the dashboard).
      // NOTE: WhatsApp can't tell us which of A or B sent this - both would
      // be replying from the same linked number - so we can't exclude
      // either one here the way the dashboard can. We notify both.
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

    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          const ext = media.mimetype.split('/')[1] || 'bin';
          const filename = `${Date.now()}-customer.${ext}`;
          fs.writeFileSync(path.join(MEDIA_DIR, filename), Buffer.from(media.data, 'base64'));
          logAndBroadcast(chatId, {
            sender: 'customer',
            type: media.mimetype.startsWith('image/') ? 'image' : 'document',
            text: message.body || '',
            mediaFile: filename,
          });
        }
      } catch (mediaErr) {
        console.error('Failed to download customer media:', mediaErr);
      }
    } else if (text) {
      logAndBroadcast(chatId, { sender: 'customer', type: 'text', text });
    }

    if (text) {
      await handleCustomerMessage(chatId, text);
    }
  } catch (err) {
    console.error('Error handling message:', err);
  }
});

client.initialize();

// Handle Ctrl+C (and other termination signals) gracefully - close the
// Puppeteer browser properly before exiting, so it doesn't leave a stale
// lock file behind that causes the next `node index.js` to hang forever.
async function shutdown() {
  console.log('\nShutting down gracefully...');

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;

  try {
    await client.destroy();
  } catch (err) {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.error('Error while shutting down:', err);
    process.exit(1);
    return;
  }

  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log('WhatsApp client closed cleanly.');
  process.exit(0);
}

process.on('SIGINT', shutdown);  // Ctrl+C
process.on('SIGTERM', shutdown); // e.g. if a process manager stops it later