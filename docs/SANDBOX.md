# The sandbox

## What runs where

Without `TENKI_API_KEY`, everything happens on the GitHub runner: scan, generate,
commit, PR. That works fine and is the default fallback.

With a key, the middle part moves:

```
GitHub runner                        Tenki microVM
─────────────                        ─────────────
install tenki CLI
create session ────────────────────► boots in < 2s
tar working tree ─────────────────►  extract to /home/tenki/work
                                     run the fixers
                                     write files
                       ◄───────────  result.json + changes.tar.gz
                                     serve patched site on :8080
expose port ──────────────────────►  public preview URL
scan(preview URL) ─────────────────► Agent Readiness API
apply patch
open PR
terminate session ────────────────►  VM destroyed
```

## Why bother

**Isolation.** The fix step reads your whole repository, fetches your live site,
converts HTML, and writes files. On the runner that all happens next to a live
`GITHUB_TOKEN` with write access. In the sandbox it happens in a Firecracker VM
that is destroyed when the run ends. The VM never receives your GitHub token —
`tenki.js` strips it from the config before upload.

**Verification.** This is the part you can't get on the runner. A GitHub runner
has no public address, so the patched site cannot be scored before it ships. A
Tenki session can expose a public preview URL, so the action serves the patched
site and re-scans it. The PR body's `level 1 → 4` is a measurement.

## Configuration

```yaml
- uses: alexander-morris/agent-ready-action@v1
  env:
    TENKI_API_KEY: ${{ secrets.TENKI_API_KEY }}
  with:
    url: https://example.com
    sandbox: auto     # auto | tenki | none
    verify: true
```

| `sandbox` | Behaviour |
|---|---|
| `auto` (default) | Use Tenki if a key is present. Any failure falls back to the runner and the job continues. |
| `tenki` | Require Tenki. A missing key or a sandbox failure fails the job. |
| `none` | Always the runner. Never installs the CLI or contacts Tenki. |

`verify: false` skips the preview-and-re-score step but still runs the fixers in
the sandbox.

Session shape: 2 vCPU, 4 GB RAM, 10 GB disk, 10-minute idle timeout, 30-minute
hard cap. Sessions are terminated in a `finally` block, so a crash still tears the
VM down.

## Getting a key

Sign up at [tenki.cloud](https://tenki.cloud), create an API key, then:

```bash
gh secret set TENKI_API_KEY
```

The installer offers to do this for you.

## The preview server

`src/serve.js` is a zero-dependency static server that behaves like the edge
config the action generates: it reads the `_headers` file, applies `Link` and
`Vary`, answers `Accept: text/markdown` from the `.md` twins, resolves
extensionless routes and directory indexes, and sets
`application/linkset+json` on `/.well-known/api-catalog`.

That fidelity matters — the verification is only meaningful if the preview serves
the site the way your host will. You can run it locally:

```bash
node src/serve.js ./public 8080
curl -i -H 'Accept: text/markdown' http://localhost:8080/
```

## Failure modes

| What happens | Result |
|---|---|
| No `TENKI_API_KEY` | Falls back to the runner (unless `sandbox: tenki`). |
| CLI install fails | Falls back to the runner. |
| Session won't start | Falls back to the runner. |
| Fixers fail inside the VM | Falls back to the runner and reruns there. |
| Preview URL unavailable | Fixes are kept; the PR notes that verification didn't run. |
| Re-scan fails | Same — fixes kept, verification section omitted. |

The working tree is uploaded excluding `.git`, `node_modules`, and the usual
build caches. Very large repositories will spend most of the run on upload; set
`sandbox: none` if that trade isn't worth it for you.
