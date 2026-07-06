// mailer.js
// Sends email notifications to responders using Gmail SMTP.

const nodemailer = require('nodemailer');

// ---- Config - replace these with real values ----
const GMAIL_USER = 'shananwessam85@gmail.com';       // the Gmail account sending these emails
const GMAIL_APP_PASSWORD = 'qeov cgew lzaj fosr';  // from Google Account > Security > App Passwords

const RESPONDER_EMAILS = [
  'shananwessam85@gmail.com',
  'hady.shanan@gmail.com',
];

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

async function sendToResponders(subject, text) {
  try {
    await transporter.sendMail({
      from: GMAIL_USER,
      to: RESPONDER_EMAILS.join(','), // sends one email addressed to both
      subject,
      text,
    });
    console.log('Notification email sent:', subject);
  } catch (err) {
    console.error('Failed to send notification email:', err);
  }
}

function notifyNewRequest(data) {
  const lines = [
    'A new client request is ready for a response.',
    '',
    `Name: ${data.name || '-'}`,
    `Inquiry type: ${data.inquiryType || '-'}`,
  ];
  if (data.bookingRef) lines.push(`Booking ref: ${data.bookingRef}`);
  if (data.changeDetails) lines.push(`Change needed: ${data.changeDetails}`);
  if (data.route) lines.push(`Route: ${data.route}`);
  if (data.dates) lines.push(`Dates: ${data.dates}`);
  lines.push('', 'Whoever is available, please reply on WhatsApp.');

  return sendToResponders('🔔 New client waiting on WhatsApp', lines.join('\n'));
}

function notifyClaimed() {
  return sendToResponders(
    '✅ Request already picked up',
    'Someone has already started replying to this client on WhatsApp. No action needed unless you were already mid-reply.'
  );
}

module.exports = {
  notifyNewRequest,
  notifyClaimed,
};