'use strict';
/**
 * Drives a Tenki Sandbox (https://tenki.cloud) — a disposable Firecracker microVM.
 *
 * Why the sandbox is worth the round trip:
 *   1. The fixers write files and fetch your live site. That work happens in a VM
 *      that is destroyed afterwards, not on the runner holding your repo token.
 *   2. The VM can expose a public preview URL, so we serve the *patched* site and
 *      re-score it before opening the PR. The PR body carries a verified
 *      "level N -> level M", not a claim.
 *
 * Everything here degrades gracefully: any failure returns null and the caller
 * falls back to running on the runner.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, runOrThrow, have, log, warn, ensureDir, sleep } = require('../util');

const GUEST_HOME = '/home/tenki';
const WORK = `${GUEST_HOME}/work`;
const APP = `${GUEST_HOME}/agent-ready`;
const OUT = `${GUEST_HOME}/out`;
const CHUNK_BYTES = 3 * 1024 * 1024; // base64 chunk size for CLI file transfer
const PREVIEW_PORT = 8080;

function tenki(args, opts = {}) {
  return run('tenki', args, { ...opts, env: { ...process.env, ...(opts.env || {}) } });
}

function tenkiOrThrow(args, opts = {}) {
  const r = tenki(args, opts);
  if (r.code !== 0) throw new Error(`tenki ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r;
}

/** Whether we can and should use Tenki for this run. */
function available(mode) {
  if (mode === 'none') return { ok: false, reason: 'sandbox input is "none"' };
  if (!process.env.TENKI_API_KEY) return { ok: false, reason: 'TENKI_API_KEY is not set' };
  if (!have('tenki')) return { ok: false, reason: 'the tenki CLI is not on PATH' };
  return { ok: true };
}

function login() {
  const status = tenki(['status']);
  if (status.code === 0 && /workspace|signed in|authenticated/i.test(status.stdout)) return;
  tenkiOrThrow(['login', '--api-key', process.env.TENKI_API_KEY]);
}

function createSession(name) {
  const r = tenkiOrThrow([
    'sandbox', 'create',
    '--name', name,
    '--cpu', '2',
    '--memory-mb', '4096',
    '--disk-size-gb', '10',
    '--idle-timeout', '10m',
    '--max-duration', '30m',
    '--metadata', `tool=agent-ready-action`,
  ]);
  const id = extractSessionId(r.stdout + '\n' + r.stderr) || findSessionByName(name);
  if (!id) throw new Error(`could not determine session id from: ${r.stdout.slice(0, 300)}`);
  return id;
}

function extractSessionId(text) {
  const uuid = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (uuid) return uuid[0];
  const generic = text.match(/\b(?:sbx|sess|ses)[-_][A-Za-z0-9]{6,}\b/);
  return generic ? generic[0] : null;
}

function findSessionByName(name) {
  const r = tenki(['sandbox', 'list', '--json']);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const rows = Array.isArray(parsed) ? parsed : (parsed.sessions || parsed.items || []);
    const hit = rows.find((s) => s.name === name);
    return hit ? (hit.id || hit.sessionId) : null;
  } catch { return null; }
}

function exec(sid, line, { timeout = '10m' } = {}) {
  return tenki(['sandbox', 'exec', '--session', sid, '--timeout', timeout, '-c', line]);
}

function execOrThrow(sid, line, opts) {
  const r = exec(sid, line, opts);
  if (r.code !== 0) throw new Error(`sandbox command failed: ${line}\n${(r.stderr || r.stdout).slice(0, 1000)}`);
  return r;
}

/**
 * Push a local file into the guest. The CLI takes text, so we base64 the bytes
 * and reassemble inside the VM — chunked, because a repo tarball is bigger than
 * a comfortable single argument.
 */
function pushFile(sid, localPath, guestPath, tmpDir) {
  const b64 = fs.readFileSync(localPath).toString('base64');
  const chunks = Math.ceil(b64.length / CHUNK_BYTES) || 1;
  execOrThrow(sid, `mkdir -p ${path.posix.dirname(guestPath)} && rm -f ${guestPath}.b64`);
  for (let i = 0; i < chunks; i++) {
    const part = b64.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const partFile = path.join(tmpDir, `chunk-${i}.b64`);
    fs.writeFileSync(partFile, part);
    tenkiOrThrow(['sandbox', 'write', '--session', sid, '--path', `${guestPath}.part`, '--data-file', partFile]);
    execOrThrow(sid, `cat ${guestPath}.part >> ${guestPath}.b64 && rm -f ${guestPath}.part`);
    fs.unlinkSync(partFile);
    log(`  uploaded chunk ${i + 1}/${chunks}`);
  }
  execOrThrow(sid, `base64 -d ${guestPath}.b64 > ${guestPath} && rm -f ${guestPath}.b64`);
}

/** Pull a guest file back to the host, base64 in transit for binary safety. */
function pullFile(sid, guestPath, localPath) {
  const exists = exec(sid, `test -f ${guestPath} && echo yes || echo no`);
  if (!/yes/.test(exists.stdout)) return false;
  execOrThrow(sid, `base64 -w0 ${guestPath} > ${guestPath}.b64 2>/dev/null || base64 ${guestPath} | tr -d '\\n' > ${guestPath}.b64`);
  const tmp = localPath + '.b64';
  tenkiOrThrow(['sandbox', 'read', '--session', sid, '--path', `${guestPath}.b64`, '--out', tmp]);
  const b64 = fs.readFileSync(tmp, 'utf8').replace(/\s+/g, '');
  fs.writeFileSync(localPath, Buffer.from(b64, 'base64'));
  fs.unlinkSync(tmp);
  return true;
}

/** tar the working tree, minus anything large and irrelevant. */
function packRepo(root, dest) {
  const excludes = ['.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', 'target',
    '.venv', 'venv', '__pycache__', '.terraform', '.cache'];
  const args = ['-czf', dest, '-C', root, ...excludes.flatMap((e) => ['--exclude', e]), '.'];
  execFileSync('tar', args, { stdio: 'pipe' });
  return fs.statSync(dest).size;
}

function expose(sid, port) {
  const r = tenki(['sandbox', 'expose', '--session', sid, '--port', String(port)]);
  const text = r.stdout + '\n' + r.stderr;
  const url = text.match(/https?:\/\/[^\s'"]+/);
  if (url) return url[0].replace(/[.,)]+$/, '');
  const ports = tenki(['sandbox', 'ports', '--session', sid]);
  const u2 = (ports.stdout + ports.stderr).match(/https?:\/\/[^\s'"]+/);
  return u2 ? u2[0].replace(/[.,)]+$/, '') : null;
}

function terminate(sid) {
  const r = tenki(['sandbox', 'terminate', '--session', sid]);
  if (r.code !== 0) warn(`could not terminate sandbox ${sid}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  else log(`Sandbox ${sid} terminated.`);
}

/**
 * The whole sandbox round trip. Returns the result object with `sandbox: 'tenki'`
 * and, when verification ran, `after` holding the re-score of the patched site.
 */
async function runInTenki(opts, { actionPath, verify }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ready-'));
  const name = `agent-ready-${process.env.GITHUB_RUN_ID || Date.now()}`;
  let sid;

  try {
    log('Authenticating with Tenki …');
    login();

    log(`Creating sandbox ${name} …`);
    sid = createSession(name);
    log(`Sandbox session: ${sid}`);

    // Ship the repo and the action itself into the VM.
    const repoTar = path.join(tmpDir, 'repo.tar.gz');
    const size = packRepo(opts.root, repoTar);
    log(`Uploading working tree (${(size / 1e6).toFixed(1)} MB) …`);
    execOrThrow(sid, `mkdir -p ${WORK} ${APP} ${OUT}`);
    pushFile(sid, repoTar, `${GUEST_HOME}/repo.tar.gz`, tmpDir);
    execOrThrow(sid, `tar -xzf ${GUEST_HOME}/repo.tar.gz -C ${WORK} && rm -f ${GUEST_HOME}/repo.tar.gz`);

    const appTar = path.join(tmpDir, 'app.tar.gz');
    execFileSync('tar', ['-czf', appTar, '-C', actionPath, 'src', 'package.json'], { stdio: 'pipe' });
    pushFile(sid, appTar, `${GUEST_HOME}/app.tar.gz`, tmpDir);
    execOrThrow(sid, `tar -xzf ${GUEST_HOME}/app.tar.gz -C ${APP} && rm -f ${GUEST_HOME}/app.tar.gz`);

    // Config for the guest run.
    // The GitHub token never enters the VM — that is most of the point of
    // running there. The license key does, because the scan inside the sandbox
    // has to be metered against the right account; it grants nothing but scan
    // quota, and the VM is the customer's own.
    const guestOpts = { ...opts, root: WORK, outDir: OUT };
    delete guestOpts.githubToken;
    const configLocal = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configLocal, JSON.stringify(guestOpts, null, 2));
    tenkiOrThrow(['sandbox', 'write', '--session', sid, '--path', `${GUEST_HOME}/config.json`, '--data-file', configLocal]);

    log('Running fixers inside the sandbox …');
    const nodeCheck = exec(sid, 'node --version');
    if (nodeCheck.code !== 0) throw new Error('the sandbox image has no node on PATH');
    const guestRun = exec(sid, `cd ${WORK} && node ${APP}/src/sandbox/guest.js ${GUEST_HOME}/config.json`, { timeout: '15m' });
    log(guestRun.stdout.trim());
    if (guestRun.code !== 0) throw new Error(`fixers failed in the sandbox:\n${(guestRun.stderr || guestRun.stdout).slice(0, 1500)}`);

    // Collect the report and the changed files.
    const resultLocal = path.join(tmpDir, 'result.json');
    if (!pullFile(sid, `${OUT}/result.json`, resultLocal)) throw new Error('no result.json came back from the sandbox');
    const result = JSON.parse(fs.readFileSync(resultLocal, 'utf8'));
    if (result.error) throw new Error(`fixers reported: ${result.error}`);

    if (result.written && result.written.length) {
      const changesLocal = path.join(tmpDir, 'changes.tar.gz');
      if (pullFile(sid, `${OUT}/changes.tar.gz`, changesLocal)) {
        execFileSync('tar', ['-xzf', changesLocal, '-C', opts.root], { stdio: 'pipe' });
        log(`Applied ${result.written.length} file(s) from the sandbox to the working tree.`);
      } else {
        throw new Error('the sandbox reported changes but returned no archive');
      }
    }

    result.sandbox = 'tenki';
    result.sandboxSession = sid;

    // Serve the patched site publicly and re-score it — proof, not a promise.
    if (verify && result.written && result.written.length) {
      try {
        const siteDirGuest = `${WORK}/${result.siteInfo.siteDir === '.' ? '' : result.siteInfo.siteDir}`.replace(/\/$/, '') || WORK;
        execOrThrow(sid, `cd ${GUEST_HOME} && nohup node ${APP}/src/serve.js ${siteDirGuest} ${PREVIEW_PORT} > ${OUT}/serve.log 2>&1 & sleep 2; echo started`);
        const previewUrl = expose(sid, PREVIEW_PORT);
        if (!previewUrl) throw new Error('no preview URL returned');
        log(`Preview URL: ${previewUrl}`);
        await sleep(4000);
        const { scan } = require('../scan');
        const after = await scan(previewUrl, {
          scannerUrl: opts.scannerUrl,
          licenseKey: opts.licenseKey,
          context: { ...(opts.context || {}), sandbox: 'tenki' },
        });
        const { tally, levelName } = require('../scan');
        result.after = {
          level: after.level,
          levelName: levelName(after.level, after.levelName),
          ...tally(after),
          previewUrl,
          raw: after,
        };
        log(`Verified on the sandbox preview: level ${after.level} — ${result.after.levelName}`);
      } catch (e) {
        warn(`Verification skipped: ${e.message}`);
        result.verifyError = e.message;
      }
    }

    return result;
  } finally {
    if (sid) terminate(sid);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { runInTenki, available };
