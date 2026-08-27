#!/usr/bin/env node
'use strict';
/**
 * Local CLI — the same engine the action runs, for trying things before you
 * commit a workflow.
 *
 *   npx agent-ready scan https://example.com
 *   npx agent-ready fix  https://example.com --site-dir public
 */
const path = require('node:path');
const fs = require('node:fs');
const core = require('../src/core');
const report = require('../src/report');
const { DEFAULT_SCANNER } = require('../src/scan');

const USAGE = `agent-ready — score a site's AI agent readiness and fix what's failing

Usage
  agent-ready scan <url> [options]     Report the score. Writes nothing.
  agent-ready fix  <url> [options]     Write the missing artifacts into your repo.

Options
  --site-dir <dir>        Servable root (public/, static/ ...). Auto-detected by default.
  --root <dir>            Repository root. Defaults to the current directory.
  --target-level <l>      max (default) or next.
  --only <a,b>            Only fix these check ids.
  --skip <a,b>            Never fix these check ids.
  --ai-policy <p>         open | balanced (default) | closed.
  --site-name <name>      Name used in generated artifacts.
  --site-description <s>  One-line description used in generated artifacts.
  --mcp-endpoint <url>    Your MCP server, to publish a real MCP Server Card.
  --a2a-endpoint <url>    Your A2A agent endpoint, to publish a real Agent Card.
  --api-docs-url <url>    API docs, for the api-catalog and Link headers.
  --openapi-url <url>     OpenAPI document, for the api-catalog.
  --scanner-url <url>     Override the scanner endpoint.
  --json                  Print the raw JSON result instead of a report.
  -h, --help              Show this.

Docs: https://github.com/alexander-morris/agent-ready-action
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = 'true'; }
      else { args[key] = next; i++; }
      continue;
    }
    args._.push(a);
  }
  return args;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const list = (v) => String(v || '').split(/[,\s]+/).filter(Boolean);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const url = args._[1];

  if (args.help || !command || !['scan', 'fix'].includes(command) || !url) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  try { new URL(url); } catch {
    console.error(`Not a valid URL: ${url}`);
    process.exit(1);
  }

  const opts = {
    root: path.resolve(args.root || process.cwd()),
    url,
    mode: command === 'scan' ? 'scan' : 'fix',
    siteDir: args['site-dir'] || '',
    targetLevel: args['target-level'] === 'next' ? 'next' : 'max',
    only: list(args.only),
    skip: list(args.skip),
    aiPolicy: args['ai-policy'] || 'balanced',
    scannerUrl: args['scanner-url'] || DEFAULT_SCANNER,
  };
  for (const k of ['site-name', 'site-description', 'mcp-endpoint', 'a2a-endpoint', 'api-docs-url', 'openapi-url']) {
    if (args[k]) opts[camel(k)] = args[k];
  }

  if (args.json) process.env.AGENT_READY_LOG_STDERR = '1';

  const result = await core.run(opts);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log(report.render(result));

  if (command === 'fix' && result.written.length) {
    console.log('');
    console.log(`Wrote ${result.written.length} file(s). Review with: git diff`);
  }
}

main().catch((e) => {
  console.error(`agent-ready: ${e.message}`);
  process.exit(1);
});
