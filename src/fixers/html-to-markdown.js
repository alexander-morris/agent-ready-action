'use strict';
/**
 * A small HTML-to-Markdown converter.
 *
 * It exists so that pages with no Markdown source still get a `.md` twin — which
 * is what the `markdownNegotiation` check actually looks for. It handles the
 * structural tags that carry meaning for a reader and drops the rest; it is not
 * trying to be a faithful renderer, it is trying to produce something an agent
 * can read instead of a wall of markup.
 */

const BLOCK_END = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'tr', 'br', 'hr']);

const ENTITIES = {
  lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', deg: '\u00b0',
  times: '\u00d7', divide: '\u00f7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
};

function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

/** Strip everything that is not content before we start. */
function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

/** Prefer the main content region when the document marks one. */
function mainRegion(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article) return article[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

function convert(html, { title } = {}) {
  let s = stripNoise(html);
  const docTitle = title || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  s = mainRegion(s);

  // Preformatted blocks are extracted first so inline rules never touch code.
  const pre = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => {
    pre.push(decode(t.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, ''));
    return `\n\n\u0000PRE${pre.length - 1}\u0000\n\n`;
  });

  // Inline markup first, so block handling does not have to care about it.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `**${t.trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `*${t.trim()}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${decode(t).trim()}\``);
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
    const text = decode(t.replace(/<[^>]+>/g, '')).trim();
    return text ? `[${text}](${href})` : '';
  });
  s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*>/gi, (_, alt, src) => `![${alt}](${src})`);
  s = s.replace(/<img\b[^>]*src=["']([^"']*)["'][^>]*>/gi, (_, src) => `![](${src})`);

  // Blocks.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => {
    const text = decode(t.replace(/<[^>]+>/g, '')).trim();
    return text ? `\n\n${'#'.repeat(Number(n))} ${text}\n\n` : '';
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${decode(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `\n\n> ${decode(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n');
  s = s.replace(/<br\b[^>]*>/gi, '\n');

  // Everything still tagged becomes a paragraph break or disappears.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_, tag) => (BLOCK_END.has(tag.toLowerCase()) ? '\n\n' : ''));

  s = decode(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  s = s.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => `\`\`\`\n${pre[Number(i)]}\n\`\`\``);

  const heading = docTitle && !s.startsWith('# ') ? `# ${decode(docTitle).trim()}\n\n` : '';
  return heading + s + '\n';
}

module.exports = { convert };
