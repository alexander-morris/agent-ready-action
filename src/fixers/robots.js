'use strict';
/**
 * robots.txt — covers three scanner checks at once, because they all live in the
 * same file: robotsTxt (RFC 9309), robotsTxtAiRules (named AI crawler groups) and
 * contentSignals (Cloudflare's Content-Signal policy syntax).
 *
 * Existing robots.txt content is preserved. We only append the groups and
 * directives that are missing, so a hand-tuned file is never clobbered.
 */

const AI_CRAWLERS = [
  // Model training / crawling
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'Google-Extended', 'PerplexityBot', 'Perplexity-User',
  'CCBot', 'Bytespider', 'Applebot-Extended',
  'meta-externalagent', 'Amazonbot', 'cohere-ai', 'Diffbot', 'Timpibot',
];

const POLICIES = {
  // What agents may do with the content, expressed as Content-Signal directives.
  open:     { search: 'yes', 'ai-input': 'yes', 'ai-train': 'yes', allow: true },
  balanced: { search: 'yes', 'ai-input': 'yes', 'ai-train': 'no',  allow: true },
  closed:   { search: 'yes', 'ai-input': 'no',  'ai-train': 'no',  allow: false },
};

function signalLine(policy) {
  const p = POLICIES[policy] || POLICIES.balanced;
  return `Content-Signal: search=${p.search}, ai-input=${p['ai-input']}, ai-train=${p['ai-train']}`;
}

/** Parse robots.txt into groups so we can tell what is already declared. */
function parse(raw) {
  const lines = (raw || '').split(/\r?\n/);
  const agents = new Set();
  let hasSitemap = false;
  let hasContentSignal = false;
  for (const line of lines) {
    const l = line.replace(/#.*$/, '').trim();
    if (!l) continue;
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') agents.add(val.toLowerCase());
    if (key === 'sitemap') hasSitemap = true;
    if (key === 'content-signal') hasContentSignal = true;
  }
  return { agents, hasSitemap, hasContentSignal };
}

function apply(ctx) {
  const { origin, identity, inputs } = ctx;
  const policy = POLICIES[inputs.aiPolicy] ? inputs.aiPolicy : 'balanced';
  const existing = ctx.read('robots.txt');
  const parsed = parse(existing);
  const notes = [];
  const blocks = [];

  const needsBase = !existing || !parsed.agents.has('*');
  const missingAi = AI_CRAWLERS.filter((a) => !parsed.agents.has(a.toLowerCase()));
  const needsSignal = !parsed.hasContentSignal;
  const needsSitemap = !parsed.hasSitemap;

  if (!needsBase && !missingAi.length && !needsSignal && !needsSitemap) return null;

  if (needsBase) {
    blocks.push([
      `# ${identity.name} — crawl rules (RFC 9309)`,
      'User-agent: *',
      'Allow: /',
    ].join('\n'));
  }

  if (needsSignal) {
    // Content Signals attach to the wildcard group; if that group already exists
    // we emit a standalone group so we never rewrite the user's directives.
    const header = needsBase
      ? null
      : ['', '# Content usage preferences for AI systems — https://contentsignals.org'];
    const lines = [];
    if (header) lines.push(...header, 'User-agent: *');
    lines.push(signalLine(policy));
    blocks.push(lines.filter((l) => l !== null).join('\n'));
  } else if (needsBase) {
    blocks.push(signalLine(policy));
  }

  if (missingAi.length) {
    const p = POLICIES[policy];
    const rule = p.allow ? 'Allow: /' : 'Disallow: /';
    blocks.push([
      '',
      `# AI crawlers and agents — explicit rules so their behaviour is unambiguous.`,
      `# Policy: ${policy}. Change the "ai-policy" input to open | balanced | closed.`,
      ...missingAi.flatMap((a) => [`User-agent: ${a}`, rule, '']),
    ].join('\n').trimEnd());
  }

  if (needsSitemap) {
    blocks.push('', `Sitemap: ${origin}/sitemap.xml`);
  }

  const addition = blocks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  const contents = existing
    ? existing.replace(/\s*$/, '\n') + '\n' + addition
    : addition;

  if (existing) notes.push('Appended to your existing `robots.txt`; nothing was removed.');
  notes.push(`AI crawler policy: **${policy}** (${signalLine(policy).replace('Content-Signal: ', '')}).`);

  return {
    files: [{ path: 'robots.txt', contents }],
    notes,
  };
}

module.exports = {
  id: 'robots',
  checks: ['robotsTxt', 'robotsTxtAiRules', 'contentSignals'],
  title: 'robots.txt, AI crawler rules and Content Signals',
  category: 'discoverability',
  apply,
  AI_CRAWLERS,
  POLICIES,
};
