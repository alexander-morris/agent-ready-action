# agent-ready

**Score your site's AI Agent Readiness, then open a PR that fixes what's failing.**

A GitHub Action that runs the same checks behind [Cloudflare's Agent Readiness score](https://blog.cloudflare.com/agent-readiness/), generates the missing artifacts inside a disposable [Tenki](https://tenki.cloud) sandbox, serves the patched site on a real preview URL to prove the score went up, and then opens a pull request.

```bash
curl -fsSL https://raw.githubusercontent.com/alexander-morris/agent-ready-action/main/install.sh | bash
```

That's the install. It detects your framework and site directory, writes the workflow, and tells you what to commit.

---

## Why

The web is being read by agents. Cloudflare now scores every site on how ready it is for them — 22 checks across discoverability, content accessibility, bot access control, and protocol discovery — and the numbers are bleak: **fewer than 4% of sites** support Markdown content negotiation or declare AI usage preferences.

Almost all of that gap is static files you don't have yet: a `robots.txt` with AI crawler rules, Content Signals, `llms.txt`, Markdown twins of your pages, a `Link` header, a skills index. This action writes them.

On a plain static site with no agent artifacts at all:

```
before   0  ░░░░░  Not Ready            0 / 22 checks passing
after    4  ████░  Agent-Integrated     7 / 22 checks passing
```

That is a real before/after from this repo's test fixture, scored by the live checker at [isitagentready.com](https://isitagentready.com) over a public URL — not a simulation.

---

## Quick start

### One line

```bash
curl -fsSL https://raw.githubusercontent.com/alexander-morris/agent-ready-action/main/install.sh | bash
```

Run it in your repo. It will:

1. find your site directory (`public/`, `static/`, …) from your framework
2. guess your URL from `CNAME` or `package.json`
3. write `.github/workflows/agent-ready.yml`
4. offer to store a `TENKI_API_KEY` secret if you have one

Nothing is committed or pushed — you review the workflow first.

Non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/alexander-morris/agent-ready-action/main/install.sh \
  | bash -s -- --url https://example.com --schedule weekly --yes
```

### Or paste the workflow yourself

```yaml
name: Agent Ready

on:
  workflow_dispatch:
  schedule:
    - cron: '0 8 * * 1'

permissions:
  contents: write
  pull-requests: write

jobs:
  agent-ready:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: alexander-morris/agent-ready-action@v1
        env:
          TENKI_API_KEY: ${{ secrets.TENKI_API_KEY }}   # optional
        with:
          url: https://example.com
```

### Or just look at the score first

```bash
npx --yes github:alexander-morris/agent-ready-action scan https://example.com
```

No workflow, no commit, no account. Add `fix` instead of `scan` to write the files into your working tree and read the diff yourself.

---

## What it writes

| Check | What lands in your repo |
|---|---|
| `robotsTxt` | `robots.txt` with explicit `User-agent` rules (RFC 9309) |
| `robotsTxtAiRules` | named groups for GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot and 13 more |
| `contentSignals` | a `Content-Signal:` line declaring what AI may do with your content |
| `sitemap` | `sitemap.xml` from your routes, plus the `Sitemap:` reference |
| `markdownNegotiation` | `llms.txt`, `llms-full.txt`, and a `.md` twin of every page |
| `linkHeaders` | `_headers` / `vercel.json` `Link` rules, and Cloudflare Pages middleware that serves the twins |
| `agentSkills` | `/.well-known/agent-skills/index.json` with SHA-256 digests |
| `apiCatalog` | `/.well-known/api-catalog` (RFC 9727) — **needs** `openapi-url` or `api-docs-url` |
| `mcpServerCard` | `/.well-known/mcp/server-card.json` — **needs** `mcp-endpoint` |
| `a2aAgentCard` | `/.well-known/agent-card.json` — **needs** `a2a-endpoint` |

Everything is merged, never clobbered. A hand-written `robots.txt` is appended to, not replaced. Running twice writes nothing the second time.

**The three marked "needs" are deliberate.** Publishing an MCP Server Card for a server you don't run, or an API catalog for an API that doesn't exist, doesn't make your site more agent-ready — it makes agents fail against it. Those files are only generated once you tell the action the endpoint is real. Until then the PR says exactly which one-line input turns each on.

See [docs/CHECKS.md](docs/CHECKS.md) for all 22 checks, including the ones no action can fix for you.

---

## The sandbox

With `TENKI_API_KEY` set, the whole fix step happens somewhere else:

```
runner                          Tenki microVM (Firecracker, destroyed after)
  │
  ├─ scan https://your-site ──────────────────────────────►  Agent Readiness API
  │
  ├─ ship working tree ──────────►  run fixers, write files
  │                                 serve patched site on :8080
  │                                 expose public preview URL ──►  re-score
  ├─ ◄──────────────── patch + verified before/after
  │
  └─ open PR
```

Two things this buys you:

**Isolation.** The fixers read your repo, fetch your live site and write files. That work happens in a VM that boots in under two seconds and is destroyed at the end of the run — not on the runner holding your `GITHUB_TOKEN`.

**Proof.** Because the sandbox can expose a public URL, the patched site gets re-scored *before* the PR opens. The PR title says `level 1 → 4` because the checker confirmed it, not because we counted the files we wrote.

Without a key, everything runs on the GitHub runner and the PR simply omits the verification section. Set `sandbox: tenki` to make the key mandatory, or `sandbox: none` to always stay on the runner. Details in [docs/SANDBOX.md](docs/SANDBOX.md).

---

## Inputs

| Input | Default | What it does |
|---|---|---|
| `url` | *required* | The site to score. |
| `site-dir` | auto | Servable root. Detected from your framework. |
| `mode` | `pr` | `scan` reports only · `fix` writes files · `pr` writes files and opens a PR. |
| `sandbox` | `auto` | `auto` uses Tenki when a key is present · `tenki` requires it · `none` stays on the runner. |
| `target-level` | `max` | `max` fixes everything it can · `next` climbs exactly one level. |
| `ai-policy` | `balanced` | `open`, `balanced` (crawl yes, train no), or `closed`. |
| `verify` | `true` | Re-score the patched site on a sandbox preview URL. |
| `fail-below` | — | Fail the job under this level. Turns the action into a CI gate. |
| `only` / `skip` | — | Comma-separated check ids to include or exclude. |
| `site-name` | auto | Name used in generated artifacts. |
| `site-description` | auto | One-line description used in generated artifacts. |
| `mcp-endpoint` | — | Your MCP server. Enables a real Server Card. |
| `a2a-endpoint` | — | Your A2A agent. Enables a real Agent Card. |
| `openapi-url` / `api-docs-url` | — | Enable the API catalog and richer `Link` headers. |
| `branch` | `agent-ready/auto-fixes` | PR branch. |
| `pr-title` | `Improve AI agent readiness` | PR title. |
| `labels` | `agent-ready` | Comma-separated PR labels. |
| `commit-message` | `chore(agent-ready): …` | Commit message. |
| `github-token` | `github.token` | Token used to push and open the PR. |
| `scanner-url` | isitagentready.com | Override the scanner endpoint. |

## Outputs

`level` · `level-name` · `level-after` · `passed` · `failed` · `changed-files` · `pr-url` · `report` · `json` · `sandbox`

```yaml
- uses: alexander-morris/agent-ready-action@v1
  id: readiness
  with:
    url: https://example.com
    mode: scan

- run: echo "Level ${{ steps.readiness.outputs.level }} — ${{ steps.readiness.outputs.level-name }}"
```

---

## Recipes

**Gate a PR on readiness** — fail if a change would drop you below level 3:

```yaml
on: pull_request
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: alexander-morris/agent-ready-action@v1
        with:
          url: https://example.com
          mode: scan
          fail-below: 3
```

The score also lands as a comment on the PR.

**Weekly maintenance PR** — the default the installer writes. New checks appear in the scanner over time; a scheduled run picks them up.

**Everything on, once you have the infrastructure:**

```yaml
with:
  url: https://example.com
  mcp-endpoint: https://example.com/mcp
  openapi-url: /openapi.json
  api-docs-url: https://example.com/docs/api
  ai-policy: balanced
```

More in [examples/](examples/).

---

## What it will not do

Being straight about the ceiling, because a tool that overpromises here wastes your time:

- **DNS-AID** needs SVCB records in your DNS zone. The action never touches DNS.
- **OAuth discovery, protected-resource metadata, `auth.md`** describe a real authorization server. A static stub would break every client that trusted it.
- **WebMCP** requires tools registered by JavaScript at runtime, in your application code.
- **GitHub Pages** cannot set response headers at all, so `linkHeaders` and `markdownNegotiation` are unreachable there. Everything else still applies. The PR says so rather than quietly failing.
- **Commerce checks** (x402, UCP, ACP, AP2) are informational and don't affect the score.

Each of these appears in the PR with the scanner's own guidance and a link to the spec.

Two more honest notes: Markdown twins converted from rendered HTML are a best effort — skim them, and if your framework can emit Markdown directly, prefer that. And a generated `llms.txt` has placeholder descriptions derived from URL slugs; ten minutes of editing makes it much better.

---

## How it works

1. `POST https://isitagentready.com/api/scan` with your URL. The response carries the level, all 22 check results, and `nextLevel.requirements` — machine-readable remediation guidance the scanner itself publishes.
2. Detect your framework, host, servable root and routes (existing sitemap → HTML files → Markdown content → links on the live homepage).
3. Run a fixer per failing check. Fixers are pure functions returning files; the engine writes only what actually differs.
4. In the sandbox: serve the result, expose it, re-score it.
5. Commit, push, open or update the PR, write the job summary.

Zero npm dependencies. Node 20 and `git` are all it needs.

---

## Development

```bash
git clone https://github.com/alexander-morris/agent-ready-action
cd agent-ready-action
npm test                                   # 24 offline tests, no network or secrets
node bin/agent-ready.js scan https://example.com
node src/serve.js ./some-site 8080         # the preview server, locally
```

See [CONTRIBUTING.md](CONTRIBUTING.md). New fixers are a single file in `src/fixers/`.

---

## Related

- [Cloudflare: Introducing the Agent Readiness score](https://blog.cloudflare.com/agent-readiness/)
- [isitagentready.com](https://isitagentready.com) — the public checker
- [Tenki](https://tenki.cloud) — the sandboxes, runners and reviewer
- [llmstxt.org](https://llmstxt.org) · [contentsignals.org](https://contentsignals.org) · [agentskills.io](https://agentskills.io)

## License

MIT. Free to use, fork and run. If you're deploying this across a fleet of sites and want managed runs, hosted history, or support, see [docs/COMMERCIAL.md](docs/COMMERCIAL.md).
