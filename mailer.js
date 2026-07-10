// mailer.js
// Sends email notifications to responders using Gmail SMTP.

const nodemailer = require('nodemailer');
const RESPONDERS = require('./responders');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

// Generic sender - takes an explicit recipient list rather than always
// emailing everyone, so different notifications can target different people.
async function sendMail(recipients, subject, text) {
  if (!recipients || recipients.length === 0) {
    console.log('Skipped email (no recipients left to notify):', subject);
    return;
  }
  try {
    await transporter.sendMail({
      from: GMAIL_USER,
      to: recipients.join(','),
      subject,
      text,
    });
    console.log('Notification email sent:', subject, '->', recipients.join(','));
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

  // A brand new handoff always goes to everyone with a real email on file -
  // nobody's picked it up yet. Filter out responders with no email set
  // (e.g. RESPONDER_B_EMAIL left blank in .env) before building the list,
  // otherwise a single missing address breaks the entire send.
  const recipients = RESPONDERS.filter((r) => r.email).map((r) => r.email);
  return sendMail(recipients, '🔔 New client waiting on WhatsApp', lines.join('\n'));
}

// respondedBy: the username ('A' or 'B') of whoever replied, if known.
//   - Known (dashboard reply): notify everyone EXCEPT that person.
//   - Unknown (manual WhatsApp reply - we can't tell A from B there):
//     notify everyone, since we don't know who to exclude.
function notifyClaimed({ name, respondedBy }) {
    const recipients = respondedBy
    ? RESPONDERS.filter((r) => r.username !== respondedBy && r.email).map((r) => r.email)
    : RESPONDERS.filter((r) => r.email).map((r) => r.email);

  const clientName = name || 'a client';
  const subject = `✅ Request for ${clientName} already picked up`;
  const whoLine = respondedBy
    ? `${respondedBy} has already started replying to ${clientName} on WhatsApp.`
    : `Someone has already started replying to ${clientName} on WhatsApp.`;

  return sendMail(recipients, subject, `${whoLine} No action needed unless you were already mid-reply.`);
}

module.exports = {
  notifyNewRequest,
  notifyClaimed,
};