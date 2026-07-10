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

const RESET_AFTER_HOURS = 24;
const COMPANY_NAME = 'Alforkan Tours';
const DASHBOARD_PORT = 3000;

// The message sent to the customer whenever a chat is reset via /done
// (whether typed directly in WhatsApp or triggered from the dashboard).
// Change the wording here and it updates in both places automatically.
const FAREWELL_MESSAGE = `Thank you for contacting ${COMPANY_NAME}! If you need anything else, feel free to reach out anytime. Have a great day! 😊`;

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
async function resetChatWithFarewell(chatId) {
  sessions[chatId] = { state: 'IDLE', data: {}, lastActivity: now(), claimedNotified: false };
  saveSessions(sessions);
  clearMessages(chatId);
  registerPendingText(chatId, FAREWELL_MESSAGE);
  await client.sendMessage(chatId, FAREWELL_MESSAGE);
  if (io) io.emit('pending_updated');
}

async function handleCustomerMessage(chatId, text) {
  const session = getSession(chatId);

  if (session.state === 'HANDED_OFF') {
    return;
  }

  switch (session.state) {
    case 'IDLE': {
      setState(chatId, 'ASK_NAME');
      await botSend(
        chatId,
        `Welcome to ${COMPANY_NAME}! ✈️\nI'll grab a few details before connecting you with our team.\n\nWhat's your name?`
      );
      break;
    }

    case 'ASK_NAME': {
      setData(chatId, 'name', text);
      setState(chatId, 'ASK_TYPE');
      await botSend(
        chatId,
        `Thanks, ${text}! What can we help you with?\n1️⃣ Schedule change on an existing booking\n2️⃣ Flight price / new booking inquiry\n\nReply with 1 or 2.`
      );
      break;
    }

    case 'ASK_TYPE': {
      const lower = text.toLowerCase();
      if (lower.includes('1') || lower.includes('schedule') || lower.includes('change')) {
        setData(chatId, 'inquiryType', 'Schedule change');
        setState(chatId, 'ASK_BOOKING_REF');
        await botSend(chatId, 'Got it. What is your booking reference (PNR) or flight number?');
      } else if (lower.includes('2') || lower.includes('price') || lower.includes('book')) {
        setData(chatId, 'inquiryType', 'Flight price / new booking');
        setState(chatId, 'ASK_ROUTE');
        await botSend(chatId, 'Sure! What are your origin and destination? (e.g. Cairo to Dubai)');
      } else {
        await botSend(chatId, 'Sorry, I didn\'t catch that. Please reply with 1 for Schedule change or 2 for Flight price inquiry.');
      }
      break;
    }

    case 'ASK_BOOKING_REF': {
      setData(chatId, 'bookingRef', text);
      setState(chatId, 'ASK_CHANGE_DETAILS');
      await botSend(chatId, 'Thanks. What change would you like to make? (e.g. new date, cancellation, etc.)');
      break;
    }

    case 'ASK_CHANGE_DETAILS': {
      setData(chatId, 'changeDetails', text);
      setState(chatId, 'CONFIRM');
      const s = sessions[chatId].data;
      await botSend(
        chatId,
        `Please confirm:\n\n` +
        `👤 Name: ${s.name}\n` +
        `📋 Request: ${s.inquiryType}\n` +
        `🎫 Booking ref: ${s.bookingRef}\n` +
        `✏️ Change needed: ${s.changeDetails}\n\n` +
        `Reply YES to confirm, or NO to start over.`
      );
      break;
    }

    case 'ASK_ROUTE': {
      setData(chatId, 'route', text);
      setState(chatId, 'ASK_DATES');
      await botSend(chatId, 'And what are your preferred travel dates?');
      break;
    }

    case 'ASK_DATES': {
      setData(chatId, 'dates', text);
      setState(chatId, 'CONFIRM');
      const s = sessions[chatId].data;
      await botSend(
        chatId,
        `Please confirm:\n\n` +
        `👤 Name: ${s.name}\n` +
        `📋 Request: ${s.inquiryType}\n` +
        `🛫 Route: ${s.route}\n` +
        `📅 Dates: ${s.dates}\n\n` +
        `Reply YES to confirm, or NO to start over.`
      );
      break;
    }

    case 'CONFIRM': {
      const lower = text.toLowerCase();
      if (lower.includes('yes') || lower === 'y') {
        const completedInquiry = {
          chatId,
          ...sessions[chatId].data,
          confirmedAt: new Date().toISOString(),
        };
        appendCompletedOrder(completedInquiry);
        setState(chatId, 'HANDED_OFF');
        sessions[chatId].claimedNotified = false;
        saveSessions(sessions);
        await botSend(
          chatId,
          'Thank you! ✅ Your request has been received — a team member will follow up with you shortly.'
        );
        await notifyNewRequest(sessions[chatId].data);
        if (io) io.emit('pending_updated');
      } else if (lower.includes('no') || lower === 'n') {
        sessions[chatId] = { state: 'ASK_NAME', data: {}, lastActivity: now(), claimedNotified: false };
        saveSessions(sessions);
        await botSend(chatId, 'No problem, let\'s start over. What\'s your name?');
      } else {
        await botSend(chatId, 'Please reply YES to confirm or NO to start over.');
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