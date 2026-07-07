// responders.js
// Single source of truth for the two responders (A and B): their dashboard
// login credentials AND their notification email. Both server.js (login)
// and mailer.js (notifications) import this, instead of each keeping their
// own separate list that could drift out of sync.

module.exports = [
  { username: 'A', password: 'wessam', email: 'shananwessam85@gmail.com' },
  { username: 'B', password: 'hadi',   email: null }, // no email for now, but could add one later
];