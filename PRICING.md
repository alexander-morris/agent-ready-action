# Pricing

The action is free and stays free. What's metered is the **scan** — the call that
scores your site — and that's what funds the project.

| | Free | Pro | Team |
|---|---|---|---|
| **Price** | $0 | $19/mo | $99/mo |
| **Scans per month** | 50 | 5,000 | 25,000 |
| All 10 fixers | ✅ | ✅ | ✅ |
| All 22 checks | ✅ | ✅ | ✅ |
| Pull requests with the full report | ✅ | ✅ | ✅ |
| Tenki sandbox verification | ✅ | ✅ | ✅ |
| Score history | — | 90 days | Full |
| Drift alerts when your score drops | — | ✅ | ✅ |
| Unlimited sites on one key | — | — | ✅ |
| Fleet dashboard | — | — | ✅ |
| Support | GitHub issues | Email | Priority |

[Get a key →](https://mitosislabs.ai/agent-ready)

## What the free tier actually gets you

Everything the action does. There is no fixer, check, or output behind the
paywall. A weekly scheduled run with sandbox verification uses about **8 scans a
month**, so 50 covers a site comfortably — with room for pull-request gating on
top.

Gating features would cost more adoption than it would earn, so the split is
volume and the things a stateless GitHub Action structurally *cannot* do: remember
your score last month, notice when it drops, and show you thirty domains at once.

## Using a key

```bash
gh secret set AGENT_READY_KEY
```

```yaml
- uses: alexander-morris/agent-ready-action@v1
  with:
    url: https://example.com
    license-key: ${{ secrets.AGENT_READY_KEY }}
```

Check it any time:

```bash
curl -s https://mitosislabs.ai/api/agent-ready/license \
  -H "Authorization: Bearer $AGENT_READY_KEY"
```

## How metering works, exactly

By default the action posts to `https://mitosislabs.ai/api/agent-ready/scan`,
which counts the call and proxies through to the public checker at
isitagentready.com. It sends the URL being scanned, your repository name, the run
id, and the action version — nothing about your code, and nothing from inside
your repository.

Without a key, the allowance is keyed on your **GitHub organisation**, so you get
50 scans a month without signing up for anything.

Two guarantees:

**It will not break your CI.** If the metered endpoint is slow, down, or
unreachable, the action falls back to the public checker automatically and the
run continues with a warning.

**It is not a trap.** Running out is a hard stop with a clear message — and that
message tells you how to keep going for free. One line opts out of metering
entirely:

```yaml
with:
  scanner-url: https://isitagentready.com/api/scan
```

That's a real, supported configuration. This is open source; a paywall you could
only respect by not reading the code wouldn't be worth having. If the paid tiers
are worth money, it's because history, alerts, and a fleet view are worth money.

## Licensing

v1.1.0 onward is [PolyForm Shield 1.0.0](LICENSE): free for any use, including
commercial and internal company use, at any scale. The single restriction is
using it to build a competing product. v1.0.0 was MIT and stays MIT — see
[LICENSE-HISTORY.md](LICENSE-HISTORY.md).

Need different terms? a@mitosislabs.ai
