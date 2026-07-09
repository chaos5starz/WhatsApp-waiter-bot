// responders.js
module.exports = [
  {
    username: process.env.RESPONDER_A_USERNAME,
    password: process.env.RESPONDER_A_PASSWORD,
    email: process.env.RESPONDER_A_EMAIL || null,
  },
  {
    username: process.env.RESPONDER_B_USERNAME,
    password: process.env.RESPONDER_B_PASSWORD,
    email: process.env.RESPONDER_B_EMAIL || null,
  },
];