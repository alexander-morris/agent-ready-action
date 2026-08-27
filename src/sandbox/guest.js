'use strict';
/**
 * Runs inside the sandbox VM.
 *
 * Reads a config file, runs the fixers against the copied working tree, then
 * leaves two artifacts behind for the host to collect:
 *   out/result.json       the full scan + fix report
 *   out/changes.tar.gz    only the files that were written
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../core');

async function main() {
  const configPath = process.argv[2];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const outDir = config.outDir || path.join(path.dirname(configPath), 'out');
  fs.mkdirSync(outDir, { recursive: true });

  let result;
  try {
    result = await core.run(config);
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ error: e.message, stack: e.stack }, null, 2));
    console.error('agent-ready guest failed:', e.message);
    process.exit(1);
  }

  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

  if (result.written.length) {
    // A tarball of exactly the files we touched, so the host applies a minimal diff.
    const listFile = path.join(outDir, 'changed.txt');
    fs.writeFileSync(listFile, result.written.join('\n') + '\n');
    execFileSync('tar', ['-czf', path.join(outDir, 'changes.tar.gz'), '-C', config.root, '-T', listFile], {
      stdio: 'inherit',
    });
  }

  console.log(`agent-ready: level ${result.before.level}, wrote ${result.written.length} file(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
