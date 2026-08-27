'use strict';
/**
 * Client for the public Agent Readiness scanner (isitagentready.com), the same
 * engine behind Cloudflare's Agent Readiness score in URL Scanner / Radar.
 *
 *   POST https://isitagentready.com/api/scan  {"url": "..."}
 *
 * The response is the contract this action is built on:
 *   level, levelName            current readiness level (0-5)
 *   checks[category][checkId]   { status: pass|fail|neutral, message, evidence }
 *   nextLevel.requirements[]    { check, description, prompt, shortPrompt, specUrls, skillUrl }
 *
 * `nextLevel.requirements` is machine-readable remediation guidance straight from
 * the scanner, so anything we cannot fix automatically is still reported verbatim
 * rather than paraphrased.
 */
const { fetchJson } = require('./util');

const DEFAULT_SCANNER = 'https://isitagentready.com/api/scan';

const LEVEL_NAMES = {
  0: 'Not Ready',
  1: 'Basic Web Presence',
  2: 'Bot-Aware',
  3: 'Agent-Readable',
  4: 'Agent-Integrated',
  5: 'Agent-Commerce',
};

async function scan(url, { scannerUrl = DEFAULT_SCANNER, timeoutMs = 180000 } = {}) {
  const result = await fetchJson(
    scannerUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'agent-ready-action' },
      body: JSON.stringify({ url }),
    },
    { timeoutMs, retries: 2 },
  );
  if (typeof result.level !== 'number') {
    throw new Error(`Scanner returned no level for ${url}: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result;
}

/** Flatten checks into [{category, id, status, message}] in a stable order. */
function flattenChecks(result) {
  const out = [];
  for (const [category, checks] of Object.entries(result.checks || {})) {
    for (const [id, c] of Object.entries(checks || {})) {
      out.push({
        category,
        id,
        status: c.status,
        message: c.message || '',
        details: c.details || null,
      });
    }
  }
  return out;
}

function tally(result) {
  const all = flattenChecks(result);
  return {
    passed: all.filter((c) => c.status === 'pass').length,
    failed: all.filter((c) => c.status === 'fail').length,
    neutral: all.filter((c) => c.status === 'neutral').length,
    total: all.length,
  };
}

/** Check ids that are currently failing. */
function failingChecks(result) {
  return flattenChecks(result).filter((c) => c.status === 'fail').map((c) => c.id);
}

/**
 * Remediation guidance keyed by check id, taken from the scanner's own
 * nextLevel.requirements when present.
 */
function requirementsById(result) {
  const map = new Map();
  for (const req of (result.nextLevel && result.nextLevel.requirements) || []) {
    map.set(req.check, req);
  }
  return map;
}

function levelName(level, fallback) {
  return fallback || LEVEL_NAMES[level] || `Level ${level}`;
}

module.exports = { scan, flattenChecks, tally, failingChecks, requirementsById, levelName, LEVEL_NAMES, DEFAULT_SCANNER };
