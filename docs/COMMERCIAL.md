# Commercial

How this project makes money, and what is wired where.

## The constraint

**GitHub Marketplace cannot sell a GitHub Action.** Paid Marketplace listings are
for GitHub *Apps*, and only apps owned by an organization. Actions can be listed,
but only for free. So the revenue had to be engineered rather than switched on.

## What actually happens

The action's default `scanner-url` is
`https://mitosislabs.ai/api/agent-ready/scan`, a metered proxy in front of the
public Agent Readiness checker. Every run is one metered call:

```
action ──► mitosislabs.ai/api/agent-ready/scan ──► isitagentready.com/api/scan
              │
              ├─ resolve license key (or GitHub org, for free users)
              ├─ count this month's scans
              ├─ 402 if the allowance is spent
              └─ record the result as score history
```

Free: 50 scans a month, keyed on the GitHub org so nobody signs up for anything.
Pro ($19/mo): 5,000 scans, 90 days of history, drift alerts.
Team ($99/mo): 25,000 scans, unlimited sites, fleet dashboard.

Full table in [PRICING.md](../PRICING.md).

## Where the code lives

The billing surface is in the Mitosis Labs app (`_mitosis/_website`), not this
repository:

| Path | What it does |
|---|---|
| `scripts/migrations/136_agent_ready.sql` | `agent_ready_licenses`, `agent_ready_usage` |
| `src/components/agent-ready/plans.ts` | plan definitions and prices |
| `src/components/agent-ready/licenses.ts` | key minting, hashing, entitlement, quota |
| `src/app/api/agent-ready/scan` | the metered proxy — the revenue mechanic |
| `src/app/api/agent-ready/license` | key introspection |
| `src/app/api/agent-ready/checkout` | Stripe Checkout |
| `src/app/api/agent-ready/webhook` | its own Stripe webhook and signing secret |
| `src/app/agent-ready/success` | where the key is shown, once |

Keys are `ar_live_<48 hex>`. Only `sha256(key)` is stored; the plaintext exists
exactly once, in the response that hands it over.

## Two decisions worth defending

**The free tier is complete.** Every fixer, every check, every output. What you
buy is volume and the three things a stateless GitHub Action structurally cannot
do: remember last month's score, notice a drop, and show you thirty domains at
once. Gating a fixer would cost more adoption than it would earn.

**The opt-out is documented.** `scanner-url: https://isitagentready.com/api/scan`
skips metering entirely, and both the 402 message and the README say so. This is
open source — the bypass is one glance at `src/scan.js`. A paywall that only
works on people who have not read the source is not a paywall, it is a
misrepresentation, and it would poison the goodwill that makes anyone adopt this
in the first place.

If you want to close that door, delete the opt-out sentence from the 402 message
in `src/app/api/agent-ready/scan/route.ts` and pin `scanner-url`. It will not
actually stop anyone, and it will cost you the trust.

## The license

v1.1.0 onward is [PolyForm Shield 1.0.0](../LICENSE): free for any purpose,
including commercial and internal company use at any scale, with one restriction
— you may not use it to build a competing product. That is the part MIT could not
do: under MIT someone could take the whole thing and stand up a rival paid
service on day one.

v1.0.0 was MIT and stays MIT permanently. See [LICENSE-HISTORY.md](../LICENSE-HISTORY.md).

## What is not built yet

- **Score history UI.** The data is recorded from the first metered scan; the
  dashboard that sells it is not built.
- **Drift alerts.** Same — the rows exist, the emailer does not.
- **Fleet dashboard** for Team.
- **A GitHub App**, the one route that bills through GitHub natively. Better UX
  than a workflow file, and much more work: hosting, webhooks, a database, an
  org-owned Marketplace listing.

Pro is sellable today on volume alone; the history features need building before
the pricing page fully earns its copy.

## Publishing to the Marketplace

1. Push a `v1.1.0` tag and cut a release.
2. Tick **Publish this Action to the GitHub Marketplace** on the release page.
3. `action.yml` already carries the `name`, `description` and `branding`.
4. Categories: *Code quality*, *Utilities*.

Marketplace listings are free; the listing is distribution, not revenue.
