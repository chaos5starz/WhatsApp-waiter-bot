// responders.js
// Reads an arbitrary number of responders from .env, following the pattern
// RESPONDER_<N>_USERNAME / RESPONDER_<N>_PASSWORD / RESPONDER_<N>_EMAIL,
// starting at N=1 and stopping at the first N with no username set.
//
// This means adding a new responder (C, D, E, ...) is purely a .env edit -
// no code changes here, in server.js, mailer.js, or anywhere else, since
// everything downstream already treats RESPONDERS as a plain list (.find,
// .filter, .map) rather than assuming exactly two entries.
//
// The <N> is just "the Nth responder slot in .env" - it has nothing to do
// with the person's actual login username, which is whatever
// RESPONDER_<N>_USERNAME is set to (e.g. "A", "wessam", "responder3" -
// any string works).

const responders = [];
let n = 1;
while (process.env[`RESPONDER_${n}_USERNAME`]) {
  responders.push({
    username: process.env[`RESPONDER_${n}_USERNAME`],
    password: process.env[`RESPONDER_${n}_PASSWORD`],
    email: process.env[`RESPONDER_${n}_EMAIL`] || null,
    displayName: process.env[`RESPONDER_${n}_DISPLAY_NAME`] || process.env[`RESPONDER_${n}_USERNAME`],
    avatar: process.env[`RESPONDER_${n}_AVATAR`] || null,
  });
  n += 1;
}

if (responders.length === 0) {
  console.warn(
    'No responders configured in .env (expected RESPONDER_1_USERNAME, etc.) - ' +
    'the dashboard login will reject everyone until at least one is added.'
  );
}

module.exports = responders;