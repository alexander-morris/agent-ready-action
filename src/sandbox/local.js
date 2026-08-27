'use strict';
/** Runs the fixers directly on the GitHub runner (the fallback sandbox). */
const core = require('../core');

async function runLocal(opts) {
  const result = await core.run(opts);
  result.sandbox = 'runner';
  return result;
}

module.exports = { runLocal };
