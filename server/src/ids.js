/**
 * tiny-empire/server/src/ids.js
 *
 * Token and user-ID generation.
 * Compatibility: mirrors harbors-edge/server/src/ids.js token format
 * (random hex strings with a single-char prefix).
 */
const crypto = require('crypto');

let counter = 0;

function nextId(prefix = 'p') {
  counter += 1;
  return `${prefix}${counter}`;
}

function randomId(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

function nextUserId()       { return randomId('u'); }
function nextSessionToken() { return randomId('t'); }

module.exports = { nextId, nextUserId, nextSessionToken };
