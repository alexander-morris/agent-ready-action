'use strict';
/** sitemap.xml (sitemaps.org protocol) built from the routes we discovered. */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function apply(ctx) {
  const { origin, routes } = ctx;
  if (ctx.read('sitemap.xml')) return null;
  if (!routes.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const urls = routes.map((r) => {
    const loc = origin + (r === '/' ? '/' : r);
    return [
      '  <url>',
      `    <loc>${esc(loc)}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      `    <priority>${r === '/' ? '1.0' : '0.7'}</priority>`,
      '  </url>',
    ].join('\n');
  });

  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');

  return {
    files: [{ path: 'sitemap.xml', contents }],
    notes: [
      `Listed ${routes.length} URL${routes.length === 1 ? '' : 's'}, discovered from ${ctx.routeSource}.`,
      'If your framework already generates a sitemap at build time, delete this file and keep the generated one — the scanner only cares that one is served.',
    ],
  };
}

module.exports = { id: 'sitemap', checks: ['sitemap'], title: 'sitemap.xml', category: 'discoverability', apply };
