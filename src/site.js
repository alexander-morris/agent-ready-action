'use strict';
/**
 * Works out where a repository's servable root lives, which host will serve it,
 * and what URLs it publishes — everything the fixers need to write files that
 * actually end up at the right path in production.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readIfExists, walk, log } = require('./util');

/**
 * Frameworks in priority order. `dir` is the conventional static root that gets
 * copied verbatim to the site root at build time.
 */
const FRAMEWORKS = [
  { id: 'docusaurus', dir: 'static', when: (r) => any(r, ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs']) },
  { id: 'hugo',       dir: 'static', when: (r) => any(r, ['hugo.toml', 'hugo.yaml', 'hugo.json', 'config.toml']) && fs.existsSync(path.join(r, 'content')) },
  { id: 'gatsby',     dir: 'static', when: (r) => any(r, ['gatsby-config.js', 'gatsby-config.ts']) },
  { id: 'sveltekit',  dir: 'static', when: (r) => any(r, ['svelte.config.js', 'svelte.config.ts']) },
  { id: 'jekyll',     dir: '.',      when: (r) => any(r, ['_config.yml']) && fs.existsSync(path.join(r, '_posts')) },
  { id: 'next',       dir: 'public', when: (r) => any(r, ['next.config.js', 'next.config.mjs', 'next.config.ts']) },
  { id: 'astro',      dir: 'public', when: (r) => any(r, ['astro.config.mjs', 'astro.config.js', 'astro.config.ts']) },
  { id: 'nuxt',       dir: 'public', when: (r) => any(r, ['nuxt.config.js', 'nuxt.config.ts']) },
  { id: 'remix',      dir: 'public', when: (r) => any(r, ['remix.config.js', 'remix.config.ts']) },
  { id: 'eleventy',   dir: 'public', when: (r) => any(r, ['.eleventy.js', 'eleventy.config.js']) },
  { id: 'vite',       dir: 'public', when: (r) => any(r, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) },
  { id: 'cra',        dir: 'public', when: (r) => fs.existsSync(path.join(r, 'public', 'index.html')) },
];

/** Host platforms decide how we express response headers. */
const HOSTS = [
  { id: 'cloudflare-pages',   when: (r) => any(r, ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) || fs.existsSync(path.join(r, 'functions')) },
  { id: 'vercel',             when: (r) => any(r, ['vercel.json']) || fs.existsSync(path.join(r, '.vercel')) },
  { id: 'netlify',            when: (r) => any(r, ['netlify.toml']) },
  { id: 'github-pages',       when: (r) => fs.existsSync(path.join(r, '.github', 'workflows')) && hasPagesWorkflow(r) },
];

function any(root, names) { return names.some((n) => fs.existsSync(path.join(root, n))); }

function hasPagesWorkflow(root) {
  const dir = path.join(root, '.github', 'workflows');
  try {
    return fs.readdirSync(dir).some((f) => {
      const c = readIfExists(path.join(dir, f)) || '';
      return c.includes('actions/deploy-pages') || c.includes('peaceiris/actions-gh-pages');
    });
  } catch { return false; }
}

/** Candidate static roots to fall back on when no framework matches. */
const FALLBACK_DIRS = ['public', 'static', 'docs', 'www', 'site', '_site', 'dist', 'build', 'out'];

function detect(root, explicitDir = '') {
  const framework = FRAMEWORKS.find((f) => { try { return f.when(root); } catch { return false; } });
  const host = HOSTS.find((h) => { try { return h.when(root); } catch { return false; } });

  let siteDir;
  let reason;
  if (explicitDir) {
    siteDir = path.resolve(root, explicitDir);
    reason = `site-dir input`;
  } else if (framework) {
    siteDir = path.resolve(root, framework.dir);
    reason = `${framework.id} convention`;
  } else {
    const found = FALLBACK_DIRS.find((d) => fs.existsSync(path.join(root, d)));
    if (found) { siteDir = path.resolve(root, found); reason = `found ./${found}`; }
    else { siteDir = root; reason = 'repository root'; }
  }

  return {
    root,
    siteDir,
    siteDirRel: path.relative(root, siteDir) || '.',
    reason,
    framework: framework ? framework.id : 'unknown',
    host: host ? host.id : 'unknown',
  };
}

/**
 * Best-effort list of the site's public URLs, used to build a sitemap and to
 * decide which pages get a Markdown twin.
 *
 * Order of preference:
 *   1. an existing sitemap.xml in the repo
 *   2. .html files inside the site dir
 *   3. content source files (Markdown) mapped to routes
 *   4. links scraped from the live homepage
 */
async function discoverRoutes(site, origin, { max = 500, fetchLive = true } = {}) {
  const fromSitemap = routesFromSitemap(site, origin);
  if (fromSitemap.length) return { routes: fromSitemap.slice(0, max), source: 'existing sitemap.xml' };

  const fromHtml = routesFromHtml(site);
  if (fromHtml.length) return { routes: fromHtml.slice(0, max), source: 'html files in site dir' };

  const fromContent = routesFromContent(site);
  if (fromContent.length) return { routes: fromContent.slice(0, max), source: 'markdown content files' };

  if (fetchLive) {
    const fromLive = await routesFromLive(origin, max);
    if (fromLive.length) return { routes: fromLive, source: 'links on the live homepage' };
  }

  return { routes: ['/'], source: 'homepage only (no routes discovered)' };
}

function routesFromSitemap(site, origin) {
  for (const name of ['sitemap.xml', 'sitemap_index.xml']) {
    const raw = readIfExists(path.join(site.siteDir, name));
    if (!raw) continue;
    const urls = [...raw.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const routes = urls.map((u) => toRoute(u, origin)).filter(Boolean);
    if (routes.length) return unique(routes);
  }
  return [];
}

function routesFromHtml(site) {
  const files = walk(site.siteDir).filter((f) => f.endsWith('.html'));
  const routes = files.map((f) => {
    let rel = path.relative(site.siteDir, f).split(path.sep).join('/');
    if (rel.endsWith('/index.html')) rel = rel.slice(0, -'index.html'.length);
    else if (rel === 'index.html') rel = '';
    else rel = rel.replace(/\.html$/, '');
    const route = '/' + rel.replace(/^\/+/, '');
    return route === '/' ? '/' : route.replace(/\/$/, '');
  });
  return unique(routes);
}

function routesFromContent(site) {
  const dirs = ['content', 'src/content', 'src/pages', 'app', 'pages', 'posts', '_posts', 'docs']
    .map((d) => path.join(site.root, d))
    .filter((d) => fs.existsSync(d));
  const routes = [];
  for (const d of dirs) {
    for (const f of walk(d)) {
      if (!/\.(md|mdx|markdown)$/i.test(f)) continue;
      let rel = path.relative(d, f).split(path.sep).join('/').replace(/\.(md|mdx|markdown)$/i, '');
      if (rel.endsWith('/index') || rel === 'index') rel = rel.slice(0, -'index'.length);
      routes.push('/' + rel.replace(/^\/+/, '').replace(/\/$/, ''));
    }
  }
  return unique(routes.length ? ['/', ...routes] : []);
}

async function routesFromLive(origin, max) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const res = await fetch(origin, { signal: ac.signal, headers: { 'user-agent': 'agent-ready-action' } });
    clearTimeout(timer);
    if (!res.ok) return [];
    const html = await res.text();
    const hrefs = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]);
    const routes = hrefs.map((h) => toRoute(h, origin)).filter(Boolean);
    return unique(['/', ...routes]).slice(0, max);
  } catch { return []; }
}

/** Convert an absolute or relative href into a same-origin route, or null. */
function toRoute(href, origin) {
  try {
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return null;
    const u = new URL(href, origin + '/');
    if (u.origin !== new URL(origin).origin) return null;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|pdf|zip|xml|txt|json|mp4|webm)$/i.test(u.pathname)) return null;
    let p = u.pathname.replace(/\/index\.html?$/, '/');
    if (p.length > 1) p = p.replace(/\/$/, '');
    return p || '/';
  } catch { return null; }
}

function unique(arr) {
  return [...new Set(arr)].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

/** Pull a display name and description from package.json / an existing index.html. */
function siteIdentity(site, fallbackName) {
  const pkg = safeJson(readIfExists(path.join(site.root, 'package.json')));
  let name = (pkg && (pkg.displayName || pkg.name)) || fallbackName || path.basename(site.root);
  let description = (pkg && pkg.description) || '';

  const index = readIfExists(path.join(site.siteDir, 'index.html'));
  if (index) {
    const title = index.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title) name = title[1].trim();
    const desc = index.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (desc && !description) description = desc[1].trim();
  }
  name = String(name).replace(/^@[^/]+\//, '').replace(/[-_]/g, ' ').trim();
  return { name, description };
}

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

module.exports = { detect, discoverRoutes, siteIdentity, toRoute, FRAMEWORKS, HOSTS };
