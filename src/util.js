'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Progress goes to stderr when a caller is emitting machine-readable stdout.
function log(...a) {
  if (process.env.AGENT_READY_LOG_STDERR === '1') console.error(...a);
  else console.log(...a);
}
function warn(...a) { console.log('::warning::' + a.join(' ')); }
function group(name, fn) {
  console.log(`::group::${name}`);
  try { return fn(); } finally { console.log('::endgroup::'); }
}

/** Split a comma/whitespace separated input into a clean array. */
function list(v) {
  return String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function bool(v, dflt = false) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/** Normalise a URL to an origin with no trailing slash. */
function originOf(u) {
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}`;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function writeFileEnsured(file, contents) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, contents);
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Run a command, returning {code, stdout, stderr}. Never throws on non-zero. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return {
    code: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
  };
}

/** Run a command and throw with useful context on failure. */
function runOrThrow(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || (r.error && r.error.message) || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code})\n${detail}`);
  }
  return r;
}

function have(cmd) {
  return run(process.platform === 'win32' ? 'where' : 'which', [cmd]).code === 0;
}

/** fetch with a timeout and one retry on transient failure. */
async function fetchJson(url, init = {}, { timeoutMs = 120000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!res.ok) {
        const msg = (body && (body.error || body.message)) || text.slice(0, 300);
        throw new Error(`HTTP ${res.status} from ${url}: ${msg}`);
      }
      if (body == null) throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(2000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Write a GitHub Actions output (multiline-safe). */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const v = value == null ? '' : String(value);
  if (!file) { log(`[output] ${name}=${v.split('\n')[0]}`); return; }
  const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${name}<<${delim}\n${v}\n${delim}\n`);
}

function appendSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, md + '\n');
}

/** Recursively list files under dir, skipping heavy/irrelevant directories. */
function walk(dir, { ignore = [], limit = 20000 } = {}) {
  const skip = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.cache',
    'vendor', 'target', '.venv', 'venv', '__pycache__', '.terraform', ...ignore]);
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.well-known') {
        if (skip.has(e.name) || e.name !== '.well-known') continue;
      }
      if (skip.has(e.name)) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/** Stable JSON with a trailing newline — keeps diffs clean across runs. */
function json(obj) { return JSON.stringify(obj, null, 2) + '\n'; }

module.exports = {
  log, warn, group, list, bool, originOf, ensureDir, writeFileEnsured, readIfExists,
  run, runOrThrow, have, fetchJson, sleep, setOutput, appendSummary, walk, json,
};
