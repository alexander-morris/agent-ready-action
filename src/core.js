'use strict';
/**
 * The engine: scan a URL, decide what to fix, and write the files.
 *
 * This module is deliberately free of GitHub and Tenki specifics so the exact
 * same code runs on the runner and inside a sandbox VM.
 */
const fs = require('node:fs');
const path = require('node:path');
const { scan, failingChecks, requirementsById, tally, levelName } = require('./scan');
const site = require('./site');
const { FIXERS, ADVISORY, FIXABLE, fixerFor } = require('./fixers');
const { readIfExists, writeFileEnsured, log, json } = require('./util');

/**
 * Decide which check ids to attempt.
 * target-level "next" restricts to the scanner's own nextLevel requirements;
 * "max" attempts every failing check we have a fixer for.
 */
function selectChecks(result, opts) {
  const failing = failingChecks(result);
  const reqs = requirementsById(result);

  let candidates;
  if (opts.targetLevel === 'next') {
    candidates = [...reqs.keys()];
  } else {
    // Everything failing, plus anything the scanner explicitly asked for next.
    candidates = [...new Set([...failing, ...reqs.keys()])];
  }

  if (opts.only.length) candidates = candidates.filter((c) => opts.only.includes(c));
  if (opts.skip.length) candidates = candidates.filter((c) => !opts.skip.includes(c));

  return {
    fixable: candidates.filter((c) => FIXABLE.has(c)),
    advisory: candidates.filter((c) => !FIXABLE.has(c)),
    failing,
    requirements: reqs,
  };
}

/** Build the context handed to every fixer. */
async function buildContext(opts) {
  const detected = site.detect(opts.root, opts.siteDir);
  const origin = new URL(opts.url).origin;
  const { routes, source } = await site.discoverRoutes(detected, origin, { fetchLive: opts.fetchLive !== false });
  const identity = site.siteIdentity(detected, opts.siteName);
  if (opts.siteName) identity.name = opts.siteName;
  if (opts.siteDescription) identity.description = opts.siteDescription;

  return {
    origin,
    url: opts.url,
    site: detected,
    routes,
    routeSource: source,
    identity,
    inputs: opts,
    /** Read a path relative to the servable site root. */
    read: (rel) => readIfExists(path.join(detected.siteDir, rel)),
    /** Read a path relative to the repository root. */
    readRoot: (rel) => readIfExists(path.join(detected.root, rel)),
  };
}

/** Run the selected fixers and write their files to disk. */
function applyFixers(ctx, checkIds) {
  const seen = new Set();
  const applied = [];
  const needsInput = [];
  const written = [];
  const pendingHeaders = [];

  for (const checkId of checkIds) {
    const fixer = fixerFor(checkId);
    if (!fixer || seen.has(fixer.id)) continue;
    seen.add(fixer.id);

    let result;
    try {
      result = fixer.apply(ctx);
    } catch (e) {
      applied.push({ id: fixer.id, title: fixer.title, checks: fixer.checks, error: e.message, files: [], notes: [] });
      continue;
    }
    if (!result) continue;

    if (result.needsInput) {
      needsInput.push({ id: fixer.id, title: fixer.title, checks: fixer.checks, reason: result.needsInput });
      if (!result.files || !result.files.length) continue;
    }
    if (result.headers) pendingHeaders.push(...result.headers);

    const files = [];
    for (const f of result.files || []) {
      const base = f.atRoot ? ctx.site.root : ctx.site.siteDir;
      const abs = path.join(base, f.path);
      const before = readIfExists(abs);
      if (before === f.contents) continue; // idempotent: nothing changed
      writeFileEnsured(abs, f.contents);
      const rel = path.relative(ctx.site.root, abs).split(path.sep).join('/');
      files.push({ path: rel, bytes: Buffer.byteLength(f.contents), created: before == null });
      written.push(rel);
    }

    applied.push({
      id: fixer.id,
      title: fixer.title,
      checks: fixer.checks,
      category: fixer.category,
      files,
      notes: result.notes || [],
    });
  }

  // Content-type rules requested by fixers get appended to the same _headers file.
  if (pendingHeaders.length) {
    const headersPath = path.join(ctx.site.siteDir, '_headers');
    let contents = readIfExists(headersPath) || '';
    let changed = false;
    for (const h of pendingHeaders) {
      if (contents.includes(h.match) && new RegExp(`^\\s*${h.name}:`, 'im').test(contents)) continue;
      contents = contents.replace(/\s*$/, '\n') + `\n${h.match}\n  ${h.name}: ${h.value}\n`;
      changed = true;
    }
    if (changed) {
      writeFileEnsured(headersPath, contents.replace(/^\n+/, ''));
      const rel = path.relative(ctx.site.root, headersPath).split(path.sep).join('/');
      if (!written.includes(rel)) written.push(rel);
    }
  }

  return { applied, needsInput, written };
}

/** Advisory entries, enriched with the scanner's own remediation prompt. */
function buildAdvisories(checkIds, requirements) {
  return checkIds.map((id) => {
    const req = requirements.get(id);
    const local = ADVISORY[id] || {};
    return {
      check: id,
      title: local.title || (req && req.description) || id,
      why: local.why || '',
      how: local.how || '',
      scannerPrompt: req ? req.prompt : '',
      specUrls: req ? req.specUrls || [] : [],
      skillUrl: req ? req.skillUrl : '',
    };
  });
}

/**
 * Full run: scan, plan, apply. Returns everything the reporter needs.
 * `mode: 'scan'` stops after the scan.
 */
async function run(opts) {
  log(`Scanning ${opts.url} …`);
  const before = await scan(opts.url, {
    scannerUrl: opts.scannerUrl,
    licenseKey: opts.licenseKey,
    context: opts.context,
  });
  const counts = tally(before);
  log(`Level ${before.level} — ${levelName(before.level, before.levelName)} (${counts.passed} passing, ${counts.failed} failing)`);

  const out = {
    url: opts.url,
    scannedAt: before.scannedAt || new Date().toISOString(),
    // Present only when the scan went through the metered endpoint.
    meta: before.meta || null,
    before: { level: before.level, levelName: levelName(before.level, before.levelName), ...counts, raw: before },
    applied: [],
    needsInput: [],
    advisories: [],
    written: [],
    siteInfo: null,
  };

  if (opts.mode === 'scan') {
    const selection = selectChecks(before, opts);
    out.advisories = buildAdvisories(selection.advisory, selection.requirements);
    out.plannedFixes = selection.fixable;
    const detected = site.detect(opts.root, opts.siteDir);
    out.siteInfo = { framework: detected.framework, host: detected.host, siteDir: detected.siteDirRel, reason: detected.reason };
    return out;
  }

  const ctx = await buildContext(opts);
  out.siteInfo = {
    framework: ctx.site.framework,
    host: ctx.site.host,
    siteDir: ctx.site.siteDirRel,
    reason: ctx.site.reason,
    routes: ctx.routes.length,
    routeSource: ctx.routeSource,
  };
  log(`Site root: ${ctx.site.siteDirRel} (${ctx.site.reason}) · framework: ${ctx.site.framework} · host: ${ctx.site.host}`);
  log(`Discovered ${ctx.routes.length} route(s) from ${ctx.routeSource}`);

  const selection = selectChecks(before, opts);
  log(`Fixing: ${selection.fixable.join(', ') || '(nothing to fix)'}`);

  const { applied, needsInput, written } = applyFixers(ctx, selection.fixable);
  out.applied = applied;
  out.needsInput = needsInput;
  out.written = written;
  out.advisories = buildAdvisories(selection.advisory, selection.requirements);

  log(`Wrote ${written.length} file(s)`);
  return out;
}

module.exports = { run, selectChecks, buildContext, applyFixers, buildAdvisories, FIXERS };
