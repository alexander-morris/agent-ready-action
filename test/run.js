'use strict';
/**
 * Offline tests. No network, no Tenki — everything here runs from a temp
 * fixture so `npm test` works in CI without secrets.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const site = require('../src/site');
const robots = require('../src/fixers/robots');
const sitemap = require('../src/fixers/sitemap');
const markdown = require('../src/fixers/markdown');
const linkHeaders = require('../src/fixers/link-headers');
const wellKnown = require('../src/fixers/well-known');
const { convert } = require('../src/fixers/html-to-markdown');
const { applyFixers, buildContext } = require('../src/core');
const { createServer } = require('../src/serve');
const report = require('../src/report');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log(`  ok  ${name}`); },
        (e) => { failures.push([name, e]); console.log(`  FAIL ${name}: ${e.message}`); });
    }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.log(`  FAIL ${name}: ${e.message}`);
  }
  return Promise.resolve();
}

/** A throwaway repo that looks like an Astro site on Cloudflare Pages. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ready-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', description: 'Demo site.' }));
  fs.writeFileSync(path.join(dir, 'astro.config.mjs'), 'export default {};');
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "demo"');
  fs.mkdirSync(path.join(dir, 'public', 'about'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'index.html'),
    '<!doctype html><html><head><title>Demo</title></head><body><h1>Demo</h1><p>Hello.</p><a href="/about">About</a></body></html>');
  fs.writeFileSync(path.join(dir, 'public', 'about', 'index.html'),
    '<!doctype html><html><head><title>About</title></head><body><h1>About</h1><p>About us.</p></body></html>');
  return dir;
}

function ctxFor(root, extra = {}) {
  const detected = site.detect(root, '');
  return {
    origin: 'https://demo.test',
    url: 'https://demo.test',
    site: detected,
    routes: ['/', '/about'],
    routeSource: 'test',
    identity: { name: 'Demo', description: 'Demo site.' },
    inputs: { aiPolicy: 'balanced', ...extra },
    read: (rel) => { try { return fs.readFileSync(path.join(detected.siteDir, rel), 'utf8'); } catch { return null; } },
    readRoot: (rel) => { try { return fs.readFileSync(path.join(detected.root, rel), 'utf8'); } catch { return null; } },
  };
}

async function main() {
  console.log('site detection');
  await test('detects Astro + Cloudflare Pages and picks public/', () => {
    const root = fixture();
    const d = site.detect(root, '');
    assert.strictEqual(d.framework, 'astro');
    assert.strictEqual(d.host, 'cloudflare-pages');
    assert.strictEqual(d.siteDirRel, 'public');
  });

  await test('an explicit site-dir input wins', () => {
    const root = fixture();
    const d = site.detect(root, 'public');
    assert.strictEqual(d.siteDirRel, 'public');
  });

  await test('routes from html normalise directory indexes', async () => {
    const root = fixture();
    const d = site.detect(root, '');
    const { routes } = await site.discoverRoutes(d, 'https://demo.test', { fetchLive: false });
    assert.deepStrictEqual(routes, ['/', '/about']);
  });

  console.log('\nrobots.txt');
  await test('writes wildcard rules, AI groups, content signals and a sitemap line', () => {
    const root = fixture();
    const out = robots.apply(ctxFor(root));
    const txt = out.files[0].contents;
    assert.match(txt, /^User-agent: \*$/m);
    assert.match(txt, /Content-Signal: search=yes, ai-input=yes, ai-train=no/);
    assert.match(txt, /^User-agent: GPTBot$/m);
    assert.match(txt, /^User-agent: ClaudeBot$/m);
    assert.match(txt, /^Sitemap: https:\/\/demo\.test\/sitemap\.xml$/m);
  });

  await test('preserves an existing robots.txt instead of replacing it', () => {
    const root = fixture();
    const existing = '# hand written\nUser-agent: *\nDisallow: /admin\n';
    fs.writeFileSync(path.join(root, 'public', 'robots.txt'), existing);
    const out = robots.apply(ctxFor(root));
    const txt = out.files[0].contents;
    assert.ok(txt.startsWith(existing.trimEnd()), 'original content must survive verbatim');
    assert.match(txt, /Disallow: \/admin/);
    assert.match(txt, /Content-Signal:/);
  });

  await test('the closed policy disallows AI crawlers', () => {
    const root = fixture();
    const out = robots.apply(ctxFor(root, { aiPolicy: 'closed' }));
    const txt = out.files[0].contents;
    assert.match(txt, /ai-train=no/);
    assert.match(txt, /User-agent: GPTBot\nDisallow: \//);
  });

  await test('is a no-op when everything is already declared', () => {
    const root = fixture();
    const first = robots.apply(ctxFor(root));
    fs.writeFileSync(path.join(root, 'public', 'robots.txt'), first.files[0].contents);
    assert.strictEqual(robots.apply(ctxFor(root)), null);
  });

  console.log('\nsitemap');
  await test('lists every discovered route', () => {
    const root = fixture();
    const out = sitemap.apply(ctxFor(root));
    assert.match(out.files[0].contents, /<loc>https:\/\/demo\.test\/<\/loc>/);
    assert.match(out.files[0].contents, /<loc>https:\/\/demo\.test\/about<\/loc>/);
  });

  await test('leaves an existing sitemap alone', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'public', 'sitemap.xml'), '<urlset/>');
    assert.strictEqual(sitemap.apply(ctxFor(root)), null);
  });

  console.log('\nmarkdown');
  await test('converts html to readable markdown', () => {
    const md = convert('<html><head><title>T</title></head><body><main><h1>Hi</h1><p>A <strong>bold</strong> <a href="/x">link</a> &mdash; ok.</p><ul><li>one</li></ul></main></body></html>');
    assert.match(md, /^# Hi$/m);
    assert.match(md, /\*\*bold\*\*/);
    assert.match(md, /\[link\]\(\/x\)/);
    assert.match(md, /—/, 'named entities must be decoded');
    assert.match(md, /^- one$/m);
  });

  await test('code inside pre is not double-marked-up', () => {
    const md = convert('<body><pre><code>npm i x &amp;&amp; npm test</code></pre></body>');
    assert.match(md, /```\nnpm i x && npm test\n```/);
    assert.ok(!md.includes('`npm i x'), 'inline code marker must not leak into the block');
  });

  await test('scripts and nav are dropped', () => {
    const md = convert('<body><script>alert(1)</script><nav><a href="/">nav</a></nav><main><p>Body.</p></main></body>');
    assert.ok(!md.includes('alert'), 'script contents must not survive');
    assert.ok(!md.includes('nav'), 'navigation must not survive');
    assert.match(md, /Body\./);
  });

  await test('writes llms.txt and a twin for every route', () => {
    const root = fixture();
    const out = markdown.apply(ctxFor(root));
    const paths = out.files.map((f) => f.path);
    assert.ok(paths.includes('llms.txt'));
    assert.ok(paths.includes('index.md'), 'the homepage twin is what makes negotiation pass');
    assert.ok(paths.includes('about.md'));
    assert.ok(paths.includes('llms-full.txt'));
  });

  console.log('\nheaders');
  await test('cloudflare pages gets _headers and middleware', () => {
    const root = fixture();
    const out = linkHeaders.apply(ctxFor(root));
    const paths = out.files.map((f) => f.path);
    assert.ok(paths.includes('_headers'));
    assert.ok(paths.includes('functions/_middleware.js'));
    const headers = out.files.find((f) => f.path === '_headers').contents;
    assert.match(headers, /Link: <\/\.well-known\/api-catalog>; rel="api-catalog"/);
    assert.match(headers, /Vary: Accept/);
  });

  await test('vercel gets header config in vercel.json', () => {
    const root = fixture();
    fs.unlinkSync(path.join(root, 'wrangler.toml'));
    fs.writeFileSync(path.join(root, 'vercel.json'), '{"version":2}');
    const out = linkHeaders.apply(ctxFor(root));
    const vercel = out.files.find((f) => f.path === 'vercel.json');
    assert.ok(vercel && vercel.atRoot, 'vercel.json belongs at the repo root');
    const cfg = JSON.parse(vercel.contents);
    assert.strictEqual(cfg.version, 2, 'existing config must be preserved');
    assert.ok(cfg.headers[0].headers.some((h) => h.key === 'Link'));
  });

  await test('github pages is told plainly that headers are impossible', () => {
    const root = fixture();
    fs.unlinkSync(path.join(root, 'wrangler.toml'));
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'uses: actions/deploy-pages@v4');
    const out = linkHeaders.apply(ctxFor(root));
    assert.match(out.notes.join(' '), /GitHub Pages cannot set custom response headers/);
  });

  console.log('\nwell-known');
  await test('no MCP card is invented without an endpoint', () => {
    const root = fixture();
    const mcp = wellKnown.find((f) => f.id === 'mcpServerCard');
    const out = mcp.apply(ctxFor(root));
    assert.strictEqual(out.files.length, 0);
    assert.match(out.needsInput, /mcp-endpoint/);
  });

  await test('a real MCP card is written when an endpoint is given', () => {
    const root = fixture();
    const mcp = wellKnown.find((f) => f.id === 'mcpServerCard');
    const out = mcp.apply(ctxFor(root, { mcpEndpoint: 'https://demo.test/mcp' }));
    const card = JSON.parse(out.files[0].contents);
    assert.strictEqual(card.url, 'https://demo.test/mcp');
    assert.strictEqual(card.serverInfo.name, 'Demo');
  });

  await test('the skills index carries sha256 digests', () => {
    const root = fixture();
    const skills = wellKnown.find((f) => f.id === 'agentSkills');
    const out = skills.apply(ctxFor(root));
    const index = JSON.parse(out.files.find((f) => f.path.endsWith('index.json')).contents);
    assert.strictEqual(index.skills.length, 1);
    assert.match(index.skills[0].digest, /^sha256:[0-9a-f]{64}$/);
  });

  await test('no api-catalog is invented without an API', () => {
    const root = fixture();
    const cat = wellKnown.find((f) => f.id === 'apiCatalog');
    const out = cat.apply(ctxFor(root));
    assert.strictEqual(out.files.length, 0);
    assert.match(out.needsInput, /openapi-url/);
  });

  console.log('\napply engine');
  await test('writes files to disk and reports them relative to the repo root', async () => {
    const root = fixture();
    const ctx = await buildContext({ root, url: 'https://demo.test', siteDir: '', aiPolicy: 'balanced', fetchLive: false });
    const { written } = applyFixers(ctx, ['robotsTxt', 'sitemap', 'markdownNegotiation', 'linkHeaders']);
    assert.ok(written.includes('public/robots.txt'));
    assert.ok(written.includes('public/sitemap.xml'));
    assert.ok(written.includes('functions/_middleware.js'), 'root-level config must land at the repo root');
    assert.ok(fs.existsSync(path.join(root, 'public', 'robots.txt')));
  });

  await test('a second run writes nothing new', async () => {
    const root = fixture();
    const opts = { root, url: 'https://demo.test', siteDir: '', aiPolicy: 'balanced', fetchLive: false };
    applyFixers(await buildContext(opts), ['robotsTxt', 'sitemap', 'linkHeaders']);
    const second = applyFixers(await buildContext(opts), ['robotsTxt', 'sitemap', 'linkHeaders']);
    assert.deepStrictEqual(second.written, [], 'the fixers must be idempotent');
  });

  console.log('\npreview server');
  await test('honours _headers and Accept: text/markdown', async () => {
    const root = fixture();
    const ctx = await buildContext({ root, url: 'https://demo.test', siteDir: '', aiPolicy: 'balanced', fetchLive: false });
    applyFixers(ctx, ['robotsTxt', 'sitemap', 'markdownNegotiation', 'linkHeaders']);

    const server = createServer(path.join(root, 'public'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const md = await get(port, '/', { accept: 'text/markdown' });
      assert.match(md.headers['content-type'], /text\/markdown/);
      assert.match(md.headers.link, /api-catalog/);

      const html = await get(port, '/');
      assert.match(html.headers['content-type'], /text\/html/);

      const robotsRes = await get(port, '/robots.txt');
      assert.strictEqual(robotsRes.status, 200);
    } finally {
      server.close();
    }
  });

  console.log('\nreport');
  await test('renders a level ladder and the check tables', () => {
    const md = report.render({
      url: 'https://demo.test',
      before: { level: 1, levelName: 'Basic Web Presence', passed: 2, failed: 5, neutral: 1, total: 8, raw: { checks: { discoverability: { robotsTxt: { status: 'pass', message: 'ok' } } } } },
      after: { level: 4, levelName: 'Agent-Integrated', passed: 7, previewUrl: 'https://preview.test' },
      applied: [{ id: 'robots', title: 'robots.txt', checks: ['robotsTxt'], files: [{ path: 'public/robots.txt', bytes: 100, created: true }], notes: ['note'] }],
      needsInput: [], advisories: [], written: ['public/robots.txt'], sandbox: 'tenki',
    });
    assert.match(md, /Level 1 → 4/);
    assert.match(md, /public\/robots\.txt/);
    assert.match(md, /Tenki/);
  });

  await meteringTests();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const [name, e] of failures) console.error(`\n${name}\n${e.stack}`);
    process.exit(1);
  }
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Metering. These run against a local stand-in for both endpoints, so no network
 * and no secrets — the behaviour under test is entirely ours.
 */
async function meteringTests() {
  console.log('\nmetering');

  const SCAN_OK = {
    level: 2,
    levelName: 'Bot-Aware',
    checks: { discoverability: { robotsTxt: { status: 'pass', message: 'ok' } } },
  };

  /** A fake scanner. `plan(request)` decides what each call returns. */
  async function withScanner(plan, fn) {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        seen.push({ url: req.url, headers: req.headers, body: parsed });
        const out = plan({ path: req.url, body: parsed, headers: req.headers, calls: seen.length });
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const prevMetered = process.env.AGENT_READY_METERED_SCANNER;
    const prevPublic = process.env.AGENT_READY_PUBLIC_SCANNER;
    process.env.AGENT_READY_METERED_SCANNER = `http://127.0.0.1:${port}/metered`;
    process.env.AGENT_READY_PUBLIC_SCANNER = `http://127.0.0.1:${port}/public`;
    delete require.cache[require.resolve('../src/scan')];
    const scanModule = require('../src/scan');

    try {
      return await fn(scanModule, seen);
    } finally {
      server.close();
      if (prevMetered === undefined) delete process.env.AGENT_READY_METERED_SCANNER;
      else process.env.AGENT_READY_METERED_SCANNER = prevMetered;
      if (prevPublic === undefined) delete process.env.AGENT_READY_PUBLIC_SCANNER;
      else process.env.AGENT_READY_PUBLIC_SCANNER = prevPublic;
      delete require.cache[require.resolve('../src/scan')];
    }
  }

  await test('sends the license key and run context to the metered endpoint', async () => {
    await withScanner(
      () => ({ status: 200, body: { ...SCAN_OK, meta: { plan: 'pro', used: 3, limit: 5000, remaining: 4997 } } }),
      async (scanModule, seen) => {
        const result = await scanModule.scan('https://demo.test', {
          scannerUrl: scanModule.METERED_SCANNER,
          licenseKey: 'ar_live_' + 'a'.repeat(48),
          context: { repository: 'octo/demo', runId: '42', actionVersion: '1.1.0', sandbox: 'runner' },
        });
        assert.strictEqual(result.level, 2);
        assert.strictEqual(result.meta.plan, 'pro');

        const call = seen[0];
        assert.match(call.headers.authorization, /^Bearer ar_live_a+$/);
        assert.strictEqual(call.body.repository, 'octo/demo');
        assert.strictEqual(call.body.runId, '42');
        assert.strictEqual(call.body.sandbox, 'runner');
      },
    );
  });

  await test('sends nothing but the url to the public checker', async () => {
    await withScanner(
      () => ({ status: 200, body: SCAN_OK }),
      async (scanModule, seen) => {
        await scanModule.scan('https://demo.test', {
          scannerUrl: scanModule.PUBLIC_SCANNER,
          licenseKey: 'ar_live_' + 'a'.repeat(48),
          context: { repository: 'octo/demo' },
        });
        assert.deepStrictEqual(Object.keys(seen[0].body), ['url'], 'opting out must not leak run metadata');
        assert.strictEqual(seen[0].headers.authorization, undefined, 'and must not send the key');
      },
    );
  });

  await test('a 402 is a hard stop, not a fallback', async () => {
    await withScanner(
      ({ path }) => {
        if (path === '/metered') {
          return {
            status: 402,
            body: { error: 'quota_exhausted', plan: 'free', used: 50, limit: 50, period: '2026-08', upgradeUrl: 'https://example.test/upgrade' },
          };
        }
        return { status: 200, body: SCAN_OK };
      },
      async (scanModule, seen) => {
        await assert.rejects(
          () => scanModule.scan('https://demo.test', { scannerUrl: scanModule.METERED_SCANNER }),
          (err) => {
            assert.ok(err instanceof scanModule.QuotaExceededError);
            assert.strictEqual(err.quota.used, 50);
            assert.strictEqual(err.quota.upgradeUrl, 'https://example.test/upgrade');
            return true;
          },
        );
        assert.strictEqual(seen.length, 1, 'a 402 must not be retried');
        assert.ok(!seen.some((c) => c.path === '/public'), 'and must not fall through to the public checker');
      },
    );
  });

  await test('a broken metering service falls back instead of breaking CI', async () => {
    await withScanner(
      ({ path }) => (path === '/metered'
        ? { status: 503, body: { error: 'down' } }
        : { status: 200, body: SCAN_OK }),
      async (scanModule, seen) => {
        const result = await scanModule.scan('https://demo.test', {
          scannerUrl: scanModule.METERED_SCANNER,
          retries: 0,
        });
        assert.strictEqual(result.level, 2, 'the run must still get a score');
        assert.ok(seen.some((c) => c.url === '/public'), 'it must have fallen back to the public checker');
      },
    );
  });

  await test('the quota line renders in the report', () => {
    const md = report.render({
      url: 'https://demo.test',
      meta: { plan: 'free', planName: 'Free', used: 48, limit: 50, remaining: 2, upgradeUrl: 'https://example.test/upgrade' },
      before: { level: 2, levelName: 'Bot-Aware', passed: 6, failed: 14, neutral: 2, total: 22, raw: { checks: {} } },
      applied: [], needsInput: [], advisories: [], written: [], sandbox: 'runner',
    });
    assert.match(md, /2 left/);
    assert.match(md, /example\.test\/upgrade/);
    assert.match(md, /isitagentready\.com\/api\/scan/, 'the opt-out must be stated, not hidden');
  });
}
