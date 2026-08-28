'use strict';
/**
 * Client for the Agent Readiness scanner.
 *
 * By default this talks to the metered Mitosis Labs endpoint, which proxies the
 * public checker at isitagentready.com and counts the call against a free
 * monthly allowance (or a license key, if you have one). That metering is how
 * this action is funded.
 *
 * Two rules keep that from being obnoxious:
 *
 *   1. It must never break your CI. A timeout, a 5xx, or an unreachable metering
 *      service falls straight through to the public checker and the run carries
 *      on, with a warning.
 *   2. It must never be a trap. Running out of quota is a hard stop with a clear
 *      message — but the message says how to keep going for free, and
 *      `scanner-url: https://isitagentready.com/api/scan` bypasses metering
 *      entirely. This is open source; pretending otherwise would be silly.
 *
 * The response contract, either way:
 *   level, levelName            current readiness level (0-5)
 *   checks[category][checkId]   { status: pass|fail|neutral, message, evidence }
 *   nextLevel.requirements[]    { check, description, prompt, shortPrompt, specUrls, skillUrl }
 *   meta                        metering info, present only on the metered endpoint
 */
const { log, warn } = require('./util');

/**
 * The metered endpoint. Counts the scan, then proxies to the public checker.
 * Overridable so the metering service can be self-hosted, and so the tests can
 * point both endpoints at a local server.
 */
const METERED_SCANNER = process.env.AGENT_READY_METERED_SCANNER
  || 'https://mitosislabs.ai/api/agent-ready/scan';
/** The public checker, used directly as the fallback and by anyone who prefers it. */
const PUBLIC_SCANNER = process.env.AGENT_READY_PUBLIC_SCANNER
  || 'https://isitagentready.com/api/scan';

const DEFAULT_SCANNER = METERED_SCANNER;

const LEVEL_NAMES = {
  0: 'Not Ready',
  1: 'Basic Web Presence',
  2: 'Bot-Aware',
  3: 'Agent-Readable',
  4: 'Agent-Integrated',
  5: 'Agent-Commerce',
};

/** Thrown when the monthly allowance is spent. Carries what the report needs. */
class QuotaExceededError extends Error {
  constructor(details) {
    super(details.message || 'Agent Readiness scan quota exhausted.');
    this.name = 'QuotaExceededError';
    this.quota = details;
  }
}

async function request(url, payload, { timeoutMs, licenseKey }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'agent-ready-action',
    };
    if (licenseKey) headers.authorization = `Bearer ${licenseKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* leave null */ }
    return { status: res.status, ok: res.ok, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Score a URL.
 *
 * `context` carries the run metadata the metered endpoint records: repository,
 * run id, action version, sandbox. None of it is required, and none of it is
 * sent when you point `scannerUrl` at the public checker.
 */
async function scan(url, options = {}) {
  const {
    scannerUrl = DEFAULT_SCANNER,
    licenseKey = '',
    timeoutMs = 180000,
    context = {},
    retries = 2,
  } = options;

  const metered = scannerUrl === METERED_SCANNER;
  const payload = metered
    ? {
        url,
        licenseKey: licenseKey || undefined,
        repository: context.repository || undefined,
        runId: context.runId || undefined,
        actionVersion: context.actionVersion || undefined,
        sandbox: context.sandbox || undefined,
      }
    : { url };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // The key authenticates against our metering service and nothing else.
      // Opting out with `scanner-url` must never hand a customer's credential
      // to a third-party endpoint.
      const res = await request(scannerUrl, payload, {
        timeoutMs,
        licenseKey: metered ? licenseKey : '',
      });

      if (res.status === 402) {
        // The paywall. Never routed around, never retried.
        throw new QuotaExceededError(res.body || { message: res.text.slice(0, 300) });
      }

      if (res.ok && res.body && typeof res.body.level === 'number') {
        return res.body;
      }

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const detail = (res.body && (res.body.message || res.body.error)) || res.text.slice(0, 300);
        lastError = new Error(`Scanner rejected the request (HTTP ${res.status}): ${detail}`);
        // Retrying a 4xx just delays the same answer. Stop and let the metered
        // path fall back, or surface the error if we are already on the public
        // checker.
        break;
      }

      lastError = new Error(`Scanner returned HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    } catch (e) {
      if (e instanceof QuotaExceededError) throw e;
      lastError = e;
    }

    if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }

  // Metering is a convenience for us, not a dependency for you.
  if (metered) {
    warn(`Metered scanner unavailable (${lastError && lastError.message}); using the public checker instead.`);
    return scan(url, { ...options, scannerUrl: PUBLIC_SCANNER, retries: 1 });
  }

  throw lastError || new Error(`Could not scan ${url}`);
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

function failingChecks(result) {
  return flattenChecks(result).filter((c) => c.status === 'fail').map((c) => c.id);
}

/** Remediation guidance keyed by check id, from the scanner's own requirements. */
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

module.exports = {
  scan,
  flattenChecks,
  tally,
  failingChecks,
  requirementsById,
  levelName,
  QuotaExceededError,
  LEVEL_NAMES,
  DEFAULT_SCANNER,
  METERED_SCANNER,
  PUBLIC_SCANNER,
};
