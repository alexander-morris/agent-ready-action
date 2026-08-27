'use strict';
/**
 * A tiny, zero-dependency static server that behaves like the edge hosts we
 * generate config for. It runs inside the sandbox so the patched site can be
 * re-scored on a real public URL before the PR is opened — that is what turns
 * "we wrote some files" into "level 1 -> level 4, verified".
 *
 * It honours:
 *   - a `_headers` file (Cloudflare Pages / Netlify syntax)
 *   - `Accept: text/markdown` content negotiation against `.md` twins
 *   - extensionless routes, directory indexes, and correct well-known types
 *
 * Usage: node serve.js <dir> <port>
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** Parse a `_headers` file into [{pattern, headers:{}}]. */
function parseHeaders(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, '_headers'), 'utf8'); } catch { return []; }
  const rules = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const m = line.trim().match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
      if (m) current.headers[m[1]] = m[2];
    }
  }
  return rules;
}

function matches(pattern, pathname) {
  if (pattern === '/*' || pattern === '/*.*') return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

/** Resolve a URL path to a file on disk, trying the usual static-host fallbacks. */
function resolveFile(dir, pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  if (clean.includes('..')) return null;
  const base = path.join(dir, clean);
  const candidates = [
    base,
    base + '.html',
    path.join(base, 'index.html'),
    base + '.md',
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

function typeFor(file, pathname) {
  if (pathname === '/.well-known/api-catalog') return 'application/linkset+json';
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function createServer(dir) {
  const headerRules = parseHeaders(dir);

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const accept = req.headers.accept || '';
    const wantsMarkdown = /text\/markdown/i.test(accept);

    const extra = {};
    for (const rule of headerRules) {
      if (matches(rule.pattern, pathname)) Object.assign(extra, rule.headers);
    }

    // Markdown content negotiation, exactly as the generated edge config does it.
    if (wantsMarkdown && !pathname.endsWith('.md')) {
      const base = pathname === '/' ? '/index' : pathname.replace(/\/$/, '');
      const md = resolveFile(dir, base + '.md');
      if (md) {
        const body = fs.readFileSync(md);
        res.writeHead(200, {
          ...extra,
          'content-type': 'text/markdown; charset=utf-8',
          vary: 'Accept',
          'content-length': body.length,
        });
        return res.end(body);
      }
    }

    const file = resolveFile(dir, pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    let body;
    try { body = fs.readFileSync(file); } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('Read error');
    }
    res.writeHead(200, {
      ...extra,
      'content-type': typeFor(file, pathname),
      'content-length': body.length,
    });
    res.end(body);
  });
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || '.');
  const port = Number(process.argv[3] || 8080);
  createServer(dir).listen(port, '0.0.0.0', () => {
    console.log(`agent-ready preview server: ${dir} on :${port}`);
  });
}

module.exports = { createServer, parseHeaders, resolveFile };
