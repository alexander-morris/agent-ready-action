'use strict';
/** Renders the Markdown that lands in the job summary and the pull request body. */
const { flattenChecks } = require('./scan');

const CATEGORY_TITLES = {
  discoverability: 'Discoverability',
  contentAccessibility: 'Content accessibility',
  botAccessControl: 'Bot access control',
  discovery: 'Protocol discovery',
  commerce: 'Commerce (informational)',
};

const ICON = { pass: '✅', fail: '❌', neutral: '➖' };

const LADDER = [
  [0, 'Not Ready'],
  [1, 'Basic Web Presence'],
  [2, 'Bot-Aware'],
  [3, 'Agent-Readable'],
  [4, 'Agent-Integrated'],
  [5, 'Agent-Commerce'],
];

function bar(level, max = 5) {
  const filled = Math.max(0, Math.min(max, level));
  return '█'.repeat(filled) + '░'.repeat(max - filled);
}

function headline(result) {
  const b = result.before;
  const a = result.after;
  if (a && a.level > b.level) {
    return `**Level ${b.level} → ${a.level}** · ${b.levelName} → **${a.levelName}** *(verified on a sandbox preview of the patched site)*`;
  }
  if (a) {
    return `**Level ${b.level}** · ${b.levelName} — the patched site verified at level ${a.level} (${a.levelName})`;
  }
  return `**Level ${b.level} / 5** · ${b.levelName}`;
}

function checksTable(raw) {
  const rows = flattenChecks(raw);
  const byCategory = new Map();
  for (const c of rows) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category).push(c);
  }
  const out = [];
  for (const [cat, checks] of byCategory) {
    out.push(`#### ${CATEGORY_TITLES[cat] || cat}`, '');
    out.push('| | Check | Result |', '|---|---|---|');
    for (const c of checks) {
      out.push(`| ${ICON[c.status] || '•'} | \`${c.id}\` | ${escapePipes(c.message)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

function escapePipes(s) { return String(s || '').replace(/\|/g, '\\|').slice(0, 200); }

/** The main report. `context` carries repo/run details when available. */
function render(result, { forPr = false } = {}) {
  const b = result.before;
  const md = [];

  md.push(`## Agent Readiness — ${result.url}`, '');
  md.push(headline(result), '');
  md.push('```');
  for (const [n, name] of LADDER) {
    const here = n === b.level ? ' ← you are here' : '';
    const after = result.after && result.after.level === n && result.after.level !== b.level ? ' ← after this PR' : '';
    md.push(`${n}  ${bar(n)}  ${name}${here}${after}`);
  }
  md.push('```', '');
  md.push(`${b.passed} passing · ${b.failed} failing · ${b.neutral} informational · ${b.total} checks total`, '');

  if (result.siteInfo) {
    const s = result.siteInfo;
    md.push(`> Site root \`${s.siteDir}\` (${s.reason}) · framework \`${s.framework}\` · host \`${s.host}\`` +
      (s.routes ? ` · ${s.routes} route(s) from ${s.routeSource}` : ''), '');
  }

  if (result.applied && result.applied.length) {
    md.push('### What this changes', '');
    for (const a of result.applied) {
      if (a.error) {
        md.push(`- **${a.title}** — fixer errored: \`${a.error}\``);
        continue;
      }
      if (!a.files.length && !a.notes.length) continue;
      md.push(`#### ${a.title}`, '');
      md.push(`Fixes: ${a.checks.map((c) => `\`${c}\``).join(', ')}`, '');
      for (const f of a.files) {
        md.push(`- \`${f.path}\` — ${f.created ? 'new' : 'updated'} (${f.bytes} bytes)`);
      }
      if (a.files.length) md.push('');
      for (const n of a.notes) md.push(`> ${n}`);
      if (a.notes.length) md.push('');
    }
  } else if (result.written && !result.written.length) {
    md.push('### What this changes', '', 'Nothing — every check this action can fix is already passing.', '');
  }

  if (result.needsInput && result.needsInput.length) {
    md.push('### Ready when you are', '',
      'These checks are fixable, but only with information the action will not invent for you:', '');
    for (const n of result.needsInput) {
      md.push(`- **${n.title}** (\`${n.checks.join('`, `')}\`) — ${n.reason}`);
    }
    md.push('');
  }

  if (result.advisories && result.advisories.length) {
    md.push('### Still failing (manual)', '');
    md.push('<details><summary>Checks that need infrastructure this action does not touch</summary>', '');
    for (const a of result.advisories) {
      md.push(`**${a.title}** — \`${a.check}\``, '');
      if (a.why) md.push(`- Why it is not automated: ${a.why}`);
      if (a.how) md.push(`- What to do: ${a.how}`);
      if (a.scannerPrompt) md.push(`- Scanner guidance: ${a.scannerPrompt}`);
      if (a.specUrls && a.specUrls.length) md.push(`- Spec: ${a.specUrls.map((u) => `<${u}>`).join(' · ')}`);
      if (a.skillUrl) md.push(`- Skill: <${a.skillUrl}>`);
      md.push('');
    }
    md.push('</details>', '');
  }

  md.push('### Full check results', '');
  md.push('<details><summary>All checks, as scored before this run</summary>', '');
  md.push(checksTable(b.raw));
  md.push('</details>', '');

  if (result.after && result.after.previewUrl) {
    md.push('### Verification', '',
      `The patched site was served from an isolated Tenki sandbox at \`${result.after.previewUrl}\` and re-scored: ` +
      `**level ${result.after.level} — ${result.after.levelName}** (${result.after.passed} passing).`,
      '',
      'The preview URL is gone — the sandbox was destroyed at the end of the run.', '');
  } else if (result.verifyError) {
    md.push(`> Verification did not run: ${result.verifyError}`, '');
  }

  md.push('---', '');
  md.push(`Scored with the [Agent Readiness](https://isitagentready.com) checker — the engine behind ` +
    `[Cloudflare's Agent Readiness score](https://blog.cloudflare.com/agent-readiness/). ` +
    `Generated by [agent-ready-action](https://github.com/alexander-morris/agent-ready-action)` +
    (result.sandbox === 'tenki' ? ' in a [Tenki](https://tenki.cloud) sandbox.' : ' on the GitHub runner.'));

  return md.join('\n');
}

/** A one-line status suitable for a commit message or a check title. */
function oneLine(result) {
  const b = result.before;
  const a = result.after;
  const climb = a && a.level > b.level ? ` → level ${a.level}` : '';
  return `Agent Readiness: level ${b.level} (${b.levelName})${climb} · ${b.passed}/${b.total} checks passing`;
}

module.exports = { render, oneLine, checksTable, LADDER };
