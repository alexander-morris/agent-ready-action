'use strict';
/**
 * GitHub Action entrypoint.
 *
 *   1. Score the URL with the Agent Readiness checker.
 *   2. Generate the missing artifacts — inside a Tenki sandbox when one is
 *      available, otherwise on the runner.
 *   3. Optionally verify the patched site on a public sandbox preview URL.
 *   4. Open (or update) a pull request and write the job summary.
 */
const fs = require('node:fs');
const path = require('node:path');
const { list, bool, log, warn, setOutput, appendSummary, ensureDir } = require('./util');
const { runLocal } = require('./sandbox/local');
const tenki = require('./sandbox/tenki');
const report = require('./report');
const gh = require('./github');
const { DEFAULT_SCANNER, QuotaExceededError, PUBLIC_SCANNER } = require('./scan');

function input(name, dflt = '') {
  const v = process.env['INPUT_' + name.toUpperCase().replace(/-/g, '_')];
  return v === undefined || v === '' ? dflt : v;
}

function readOptions() {
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const url = input('url');
  if (!url) throw new Error('the "url" input is required');
  try { new URL(url); } catch { throw new Error(`"url" is not a valid URL: ${url}`); }

  const mode = input('mode', 'pr').toLowerCase();
  if (!['scan', 'fix', 'pr'].includes(mode)) throw new Error(`"mode" must be scan, fix or pr (got "${mode}")`);

  const sandbox = input('sandbox', 'auto').toLowerCase();
  if (!['auto', 'tenki', 'none'].includes(sandbox)) throw new Error(`"sandbox" must be auto, tenki or none (got "${sandbox}")`);

  return {
    root,
    url,
    mode,
    sandbox,
    siteDir: input('site-dir'),
    targetLevel: input('target-level', 'max').toLowerCase() === 'next' ? 'next' : 'max',
    failBelow: input('fail-below') === '' ? null : Number(input('fail-below')),
    verify: bool(input('verify', 'true'), true),
    only: list(input('only')),
    skip: list(input('skip')),
    siteName: input('site-name'),
    siteDescription: input('site-description'),
    aiPolicy: input('ai-policy', 'balanced').toLowerCase(),
    mcpEndpoint: input('mcp-endpoint'),
    a2aEndpoint: input('a2a-endpoint'),
    apiDocsUrl: input('api-docs-url'),
    openapiUrl: input('openapi-url'),
    branch: input('branch', 'agent-ready/auto-fixes'),
    prTitle: input('pr-title', 'Improve AI agent readiness'),
    labels: list(input('labels', 'agent-ready')),
    commitMessage: input('commit-message', 'chore(agent-ready): add agent-readiness artifacts'),
    githubToken: input('github-token', process.env.GITHUB_TOKEN || ''),
    scannerUrl: input('scanner-url', DEFAULT_SCANNER),
    licenseKey: input('license-key', process.env.AGENT_READY_KEY || ''),
    actionPath: process.env.AGENT_READY_ACTION_PATH || path.resolve(__dirname, '..'),
    // Recorded by the metered endpoint so a run can be attributed to an account
    // and shown in score history. Nothing here is sent to the public checker.
    context: {
      repository: process.env.GITHUB_REPOSITORY || '',
      runId: process.env.GITHUB_RUN_ID || '',
      actionVersion: actionVersion(),
      sandbox: 'runner',
    },
  };
}

/** Version from our own package.json, for usage attribution. */
function actionVersion() {
  try {
    return require('../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Pick the sandbox and run the fixers there. */
async function execute(opts) {
  if (opts.mode === 'scan') {
    const result = await runLocal({ ...opts, fetchLive: true });
    result.sandbox = 'runner';
    return result;
  }

  const availability = tenki.available(opts.sandbox);
  if (!availability.ok) {
    if (opts.sandbox === 'tenki') {
      throw new Error(
        `sandbox: tenki was requested but ${availability.reason}. ` +
        'Add TENKI_API_KEY to the job environment (https://tenki.cloud), or set sandbox: auto to fall back to the runner.',
      );
    }
    log(`Running fixers on the GitHub runner (${availability.reason}).`);
    return runLocal(opts);
  }

  log('Running fixers in a Tenki sandbox.');
  try {
    return await tenki.runInTenki(opts, { actionPath: opts.actionPath, verify: opts.verify });
  } catch (e) {
    if (opts.sandbox === 'tenki') throw e;
    warn(`Tenki sandbox failed (${e.message}); falling back to the runner.`);
    return runLocal(opts);
  }
}

async function maybeOpenPr(opts, result) {
  if (opts.mode !== 'pr') return null;
  if (!result.written.length) {
    log('No files changed, so no pull request was opened.');
    return null;
  }
  if (!opts.githubToken) {
    warn('No github-token available, so the changes were left in the working tree instead of opening a pull request.');
    return null;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    warn('GITHUB_REPOSITORY is unset, so no pull request was opened.');
    return null;
  }

  const base = gh.defaultBase(opts.root);
  const branch = gh.commitAndPush({
    cwd: opts.root,
    branch: opts.branch,
    message: `${opts.commitMessage}\n\n${report.oneLine(result)}`,
    files: result.written,
    token: opts.githubToken,
    repo,
  });
  if (!branch) return null;

  const title = result.after && result.after.level > result.before.level
    ? `${opts.prTitle} (level ${result.before.level} → ${result.after.level})`
    : opts.prTitle;

  return gh.openPullRequest({
    token: opts.githubToken,
    repo,
    branch,
    base,
    title,
    body: report.render(result, { forPr: true }),
    labels: opts.labels,
  });
}

/** When the run was triggered by a pull request, leave the score as a comment. */
async function maybeCommentOnPr(opts, body) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !repo || !opts.githubToken) return null;
  let event;
  try { event = JSON.parse(fs.readFileSync(eventPath, 'utf8')); } catch { return null; }
  const number = event.pull_request && event.pull_request.number;
  if (!number) return null;
  try {
    return await gh.upsertPrComment({ token: opts.githubToken, repo, prNumber: number, body });
  } catch (e) {
    warn(`could not comment on the pull request: ${e.message}`);
    return null;
  }
}

async function main() {
  const opts = readOptions();
  log(`agent-ready-action · ${opts.url} · mode=${opts.mode} sandbox=${opts.sandbox}`);

  const result = await execute(opts);

  // Artifacts on disk, so later workflow steps can do whatever they like with
  // them. On a runner they go to the temp dir rather than the checkout, so the
  // action never leaves an untracked directory in someone's repository.
  const outDir = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'agent-ready')
    : path.join(opts.root, '.agent-ready');
  ensureDir(outDir);
  const jsonPath = path.join(outDir, 'result.json');
  const mdPath = path.join(outDir, 'report.md');
  const body = report.render(result);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(mdPath, body);

  appendSummary(body);

  const prUrl = await maybeOpenPr(opts, result);
  await maybeCommentOnPr(opts, body);

  setOutput('level', result.before.level);
  setOutput('level-name', result.before.levelName);
  setOutput('level-after', result.after ? result.after.level : '');
  setOutput('passed', result.before.passed);
  setOutput('failed', result.before.failed);
  setOutput('changed-files', result.written.join('\n'));
  setOutput('pr-url', prUrl || '');
  setOutput('report', mdPath);
  setOutput('json', jsonPath);
  setOutput('sandbox', result.sandbox || 'runner');
  setOutput('plan', (result.meta && result.meta.plan) || '');
  setOutput('quota-used', result.meta ? result.meta.used : '');
  setOutput('quota-limit', result.meta ? result.meta.limit : '');
  setOutput('quota-remaining', result.meta ? result.meta.remaining : '');

  log('');
  log(report.oneLine(result));
  if (prUrl) log(`Pull request: ${prUrl}`);

  if (opts.failBelow != null && !Number.isNaN(opts.failBelow)) {
    const effective = result.after ? result.after.level : result.before.level;
    if (effective < opts.failBelow) {
      console.log(`::error::Agent Readiness level ${effective} is below the required ${opts.failBelow}.`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  if (e instanceof QuotaExceededError) {
    const q = e.quota || {};
    const lines = [
      `Agent Readiness scan quota used up: ${q.used}/${q.limit} for ${q.period} on the ${q.planName || q.plan} plan.`,
      '',
      'Three ways forward:',
      q.upgradeUrl ? `  1. Upgrade for more scans and score history: ${q.upgradeUrl}` : null,
      `  2. Run fewer scans — a weekly schedule uses about 8 a month with sandbox verification on.`,
      `  3. Keep going unmetered against the public checker by adding to your workflow:`,
      `       scanner-url: ${PUBLIC_SCANNER}`,
    ].filter(Boolean);
    for (const line of lines) console.log(line);
    appendSummary(['## Agent Readiness', '', ...lines.map((l) => (l ? l : ''))].join('\n'));
    console.log(`::error::${lines[0]}`);
    process.exit(1);
  }
  console.log(`::error::${e.message}`);
  if (process.env.RUNNER_DEBUG === '1' && e.stack) console.log(e.stack);
  process.exit(1);
});
