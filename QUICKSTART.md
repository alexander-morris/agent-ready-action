# Quick start

Three ways in, shortest first. Pick one.

## 1. The one-liner (30 seconds)

From inside your repository:

```bash
curl -fsSL https://raw.githubusercontent.com/alexander-morris/agent-ready-action/main/install.sh | bash
```

It asks for your URL (guessing from `CNAME` or `package.json`), detects your site
directory from your framework, and writes `.github/workflows/agent-ready.yml`.
Nothing is committed. Then:

```bash
git add .github/workflows/agent-ready.yml
git commit -m "Add agent-ready workflow"
git push
gh workflow run "Agent Ready"
```

Watch it: `gh run watch`. When it finishes you'll have a pull request.

### Options

```bash
curl -fsSL https://raw.githubusercontent.com/alexander-morris/agent-ready-action/main/install.sh | bash -s -- \
  --url https://example.com \
  --site-dir public \
  --schedule weekly \      # daily | weekly | monthly | manual
  --mode pr \              # pr | fix | scan
  --yes
```

## 2. Look before you leap

See the score without touching your repo:

```bash
npx --yes github:alexander-morris/agent-ready-action scan https://example.com
```

Write the files locally and read the diff yourself:

```bash
npx --yes github:alexander-morris/agent-ready-action fix https://example.com
git diff
```

## 3. Paste the workflow

`.github/workflows/agent-ready.yml`:

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

`permissions: contents: write` and `pull-requests: write` are required for
`mode: pr`. Without them the action still runs and reports, but cannot open a PR.

---

## Optional: the Tenki sandbox

With a [Tenki](https://tenki.cloud) API key the fixers run inside a disposable
Firecracker VM, and the patched site is served on a public preview URL and
re-scored before the PR opens — so the PR says `level 1 → 4` because the checker
confirmed it.

```bash
gh secret set TENKI_API_KEY     # paste your tk_... key
```

Without it everything runs on the GitHub runner and you simply don't get the
verification section. Nothing else changes.

---

## After the first run

The PR contains generated files, a full check table, and a list of what's still
failing with the scanner's own guidance. Three things are worth doing by hand:

1. **Edit `llms.txt`.** Generated descriptions come from URL slugs. Real
   one-liners make it far more useful to an agent.
2. **Skim the `.md` twins** converted from HTML. A converter can't know what your
   markup meant.
3. **Fill in the endpoints you actually have.** If you run an MCP server or ship
   an OpenAPI document, add `mcp-endpoint` / `openapi-url` to the workflow and
   rerun — that's what unlocks the top of the ladder.

## Troubleshooting

**"No files changed."** Everything fixable already passes. Check the job summary
for what's left.

**PR wasn't opened.** Check `permissions:` in the workflow, and that
`Settings → Actions → General → Allow GitHub Actions to create and approve pull
requests` is enabled.

**Wrong directory.** Set `site-dir:` explicitly. It should be the folder whose
contents land at the root of your deployed site.

**`markdownNegotiation` still fails.** It needs a server hook. On Cloudflare
Pages the action wires it up; elsewhere the PR includes the snippet at
`docs/agent-ready/markdown-negotiation.md`. On GitHub Pages it isn't possible.

**Sandbox errors.** With `sandbox: auto` a Tenki failure falls back to the runner
and the job continues. Set `sandbox: tenki` if you'd rather it fail loudly.
