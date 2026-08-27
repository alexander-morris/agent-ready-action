'use strict';
/**
 * Content accessibility for agents:
 *   - /llms.txt        a curated map of the site in Markdown
 *   - /llms-full.txt   the same map with inline content where we have it
 *   - Markdown twins   /about -> /about.md for pages whose source is Markdown
 *
 * The scanner's `markdownNegotiation` check wants `Accept: text/markdown` to be
 * honoured, which needs the server in the loop — so we also emit the right edge
 * config for the detected host (see link-headers.js for where headers land).
 */
const fs = require('node:fs');
const path = require('node:path');
const { convert } = require('./html-to-markdown');

function apply(ctx) {
  const { origin, routes, identity, site } = ctx;
  const files = [];
  const notes = [];

  if (!ctx.read('llms.txt')) {
    const grouped = groupRoutes(routes);
    const lines = [
      `# ${identity.name}`,
      '',
      `> ${identity.description || `${identity.name} — see the pages below for the canonical content.`}`,
      '',
      'This file follows the llms.txt convention (https://llmstxt.org): a concise,',
      'Markdown map of this site for language models and agents.',
      '',
    ];
    for (const [heading, group] of grouped) {
      lines.push(`## ${heading}`, '');
      for (const r of group) {
        lines.push(`- [${titleFor(r)}](${origin}${r === '/' ? '/' : r}): ${describe(r)}`);
      }
      lines.push('');
    }
    files.push({ path: 'llms.txt', contents: lines.join('\n') });
    notes.push('`llms.txt` lists your pages for models that look for it. Edit the descriptions — generated ones are placeholders derived from URL slugs.');
  }

  // A Markdown twin per route. Source Markdown wins; anything left over is
  // converted from the rendered HTML, because `markdownNegotiation` only passes
  // when the page an agent asks for actually has Markdown behind it.
  const fromSource = markdownTwins(site, routes);
  const covered = new Set(fromSource.map((t) => t.path));
  const fromHtml = htmlTwins(site, routes, covered);

  const twins = [...fromSource, ...fromHtml].slice(0, 300);
  for (const t of twins) files.push(t);

  if (fromSource.length) {
    notes.push(`${fromSource.length} Markdown twin${fromSource.length === 1 ? '' : 's'} copied from your existing Markdown source.`);
  }
  if (fromHtml.length) {
    notes.push(`${fromHtml.length} Markdown twin${fromHtml.length === 1 ? '' : 's'} converted from rendered HTML. Skim them — a converter cannot know what your markup means. If your framework can emit Markdown directly, prefer that and delete these.`);
  }
  if (twins.length) {
    notes.push('Twins are what make `Accept: text/markdown` work: `/about` serves `/about.md`. Without them the negotiation check cannot pass, whatever the edge config says.');
  }

  // llms-full.txt: the same map with the content inline, for agents that would
  // rather make one request than twenty.
  if (twins.length && !ctx.read('llms-full.txt')) {
    const parts = [`# ${identity.name}`, ''];
    if (identity.description) parts.push(`> ${identity.description}`, '');
    let budget = 400000;
    for (const t of twins) {
      if (budget <= 0) { parts.push('', '<!-- truncated -->'); break; }
      const body = t.contents.slice(0, 20000);
      budget -= body.length;
      parts.push(`---`, '', `url: ${origin}/${t.path.replace(/index\.md$/, '').replace(/\.md$/, '')}`.replace(/\/$/, '/'), '', body.trim(), '');
    }
    files.push({ path: 'llms-full.txt', contents: parts.join('\n') + '\n' });
  }

  if (!files.length) return null;
  return { files, notes };
}

/** Convert rendered HTML to Markdown for routes with no Markdown source. */
function htmlTwins(site, routes, covered) {
  const out = [];
  for (const route of routes) {
    const target = route === '/' ? 'index.md' : route.replace(/^\//, '').replace(/\/$/, '') + '.md';
    if (covered.has(target)) continue;

    const rel = route === '/' ? '' : route.replace(/^\//, '').replace(/\/$/, '');
    const candidates = rel
      ? [path.join(site.siteDir, rel, 'index.html'), path.join(site.siteDir, rel + '.html')]
      : [path.join(site.siteDir, 'index.html')];

    const file = candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!file) continue;

    let html;
    try { html = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const md = convert(html);
    if (!md.trim()) continue; // the page had no extractable content
    out.push({ path: target, contents: md });
    covered.add(target);
  }
  return out;
}

/** Find repo Markdown files that correspond to a public route and copy them into the site dir. */
function markdownTwins(site, routes) {
  const roots = ['content', 'src/content', 'src/pages', 'pages', 'app', 'docs', '_posts', 'posts']
    .map((d) => path.join(site.root, d))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!roots.length) return [];

  const routeSet = new Set(routes);
  const out = [];
  const seen = new Set();

  for (const root of roots) {
    for (const file of listMarkdown(root)) {
      let rel = path.relative(root, file).split(path.sep).join('/').replace(/\.(md|mdx|markdown)$/i, '');
      if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
      else if (rel === 'index') rel = '';
      const route = '/' + rel.replace(/^\/+/, '');
      const normalised = route === '/' ? '/' : route.replace(/\/$/, '');
      if (!routeSet.has(normalised)) continue;

      const target = normalised === '/' ? 'index.md' : normalised.replace(/^\//, '') + '.md';
      if (seen.has(target)) continue;
      seen.add(target);

      let body;
      try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
      out.push({ path: target, contents: stripFrontmatter(body) });
    }
  }
  return out;
}

function listMarkdown(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < 1000) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.(md|mdx|markdown)$/i.test(e.name)) out.push(full);
    }
  }
  return out;
}

/** Keep the title from YAML frontmatter, drop the rest — agents want prose. */
function stripFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return src;
  const title = m[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const rest = src.slice(m[0].length).replace(/^\s+/, '');
  return title ? `# ${title[1]}\n\n${rest}` : rest;
}

function groupRoutes(routes) {
  // A handful of pages reads better as one flat list than as a heading each.
  if (routes.length <= 10) return [['Pages', routes]];
  const groups = new Map();
  for (const r of routes) {
    const seg = r === '/' ? 'Home' : titleCase(r.split('/').filter(Boolean)[0] || 'Pages');
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg).push(r);
  }
  // Home first, then alphabetical, and keep the file readable.
  return [...groups.entries()].sort((a, b) => (a[0] === 'Home' ? -1 : b[0] === 'Home' ? 1 : a[0].localeCompare(b[0])));
}

function titleFor(route) {
  if (route === '/') return 'Home';
  const last = route.split('/').filter(Boolean).pop() || 'Page';
  return titleCase(last);
}

function describe(route) {
  return route === '/' ? 'Site homepage.' : `${titleFor(route)} page.`;
}

function titleCase(s) {
  return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  id: 'markdown',
  checks: ['markdownNegotiation'],
  title: 'llms.txt and Markdown content for agents',
  category: 'contentAccessibility',
  apply,
};
