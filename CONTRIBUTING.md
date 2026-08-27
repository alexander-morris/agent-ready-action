# Contributing

Bug reports, fixers for checks we don't cover yet, and host support are all
welcome.

## Setup

```bash
git clone https://github.com/alexander-morris/agent-ready-action
cd agent-ready-action
npm test      # no install step — the action has zero dependencies
```

Keep it that way. A GitHub Action with no `node_modules` needs no build, no
bundling, and no committed `dist/`. If you reach for a package, check whether
Node 20 already does it.

## Layout

```
action.yml            inputs, outputs, and the composite steps
install.sh            the one-line quick start
bin/agent-ready.js    local CLI
src/
  index.js            action entrypoint: inputs, PR, outputs
  core.js             scan -> plan -> apply. No GitHub or Tenki specifics.
  scan.js             Agent Readiness API client
  site.js             framework/host detection and route discovery
  serve.js            header-aware preview server used for verification
  report.js           Markdown for the job summary and PR body
  github.js           branch, push, PR, comments via git + REST
  fixers/             one file per artifact
  sandbox/            tenki.js (host side), guest.js (in-VM), local.js
test/run.js           offline tests
```

## Writing a fixer

A fixer owns one or more scanner check ids and returns files. It never touches
the filesystem itself — `core.js` decides what actually differs and writes it.

```js
module.exports = {
  id: 'myFixer',
  checks: ['someCheckId'],          // ids from the scanner
  title: 'Human-readable name',
  category: 'discoverability',
  apply(ctx) {
    if (ctx.read('some-file')) return null;      // already there, nothing to do
    return {
      files: [{ path: 'some-file', contents: '...' }],  // relative to the site root
      notes: ['Shown in the PR body.'],
    };
  },
};
```

`ctx` gives you `origin`, `site` (root, siteDir, framework, host), `routes`,
`identity` (name, description), `inputs`, `read(rel)` for the site root and
`readRoot(rel)` for the repo root. Add `atRoot: true` to a file that belongs at
the repository root, like build config.

Return `{ files: [], needsInput: 'why' }` when you could fix the check but need
information the user has to supply.

Then register it in `src/fixers/index.js` and add tests.

## Rules that matter

**Never invent a capability.** If a check wants a card describing a live
endpoint, and the user hasn't told us the endpoint exists, return `needsInput`.
A card pointing at nothing makes agents fail against the site — worse than the
failing check.

**Never clobber.** Merge into existing files. A hand-written `robots.txt` must
survive verbatim.

**Be idempotent.** Two runs in a row must produce no second diff. There is a test
for this and it has already caught one real bug.

**Say what you did.** `notes` land in the PR body. If a generated file needs a
human pass, say so there.

## Tests

`npm test` runs offline against temp fixtures — no network, no secrets, so it
works in CI on a fork. Add cases for new fixers, especially the merge and
idempotency paths.

To check something end to end against the real scanner, serve a fixture and
tunnel it:

```bash
node src/serve.js ./fixture/public 8080 &
cloudflared tunnel --url http://localhost:8080
node bin/agent-ready.js scan https://your-tunnel.trycloudflare.com
```
