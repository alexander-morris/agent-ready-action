# Commercial notes

The action is MIT and stays that way. This page is about the paid layer that can
sit on top of it, and what in the repo is already shaped for that.

## The constraint to know first

**GitHub Marketplace cannot sell a GitHub Action.** Paid Marketplace listings are
for GitHub *Apps*, and only for apps owned by an organization. Actions can be
listed, but only for free.

So "charge for the Action" isn't a thing you can do directly. Publishing to the
Marketplace is still worth doing — it's the distribution channel, and it's what
makes `uses: alexander-morris/agent-ready-action@v1` discoverable — but the
revenue has to come from somewhere adjacent.

## Four routes that do work

**1. Hosted service + license key.** The OSS action stays fully functional. A
paid tier adds what a stateless action structurally cannot do: score history over
time, alerting when a score drops, fleet dashboards across many domains,
scheduled scans without burning Actions minutes, and competitor benchmarking.
The `license-key` input already exists and is a no-op — nothing in the OSS path
reads it, and nothing is gated behind it today. Wiring it to a hosted API is a
small change; keeping the free path complete is the part that matters.

**2. A GitHub App.** This is the one route that can bill through GitHub itself,
with per-seat or flat plans and GitHub handling payment. An App can watch pushes,
open PRs without a workflow file, and comment on PRs — a materially better
experience than a workflow the user installs and maintains. It's also the most
work: an App needs hosting, webhooks and a database.

**3. Managed sandboxes.** Right now users bring their own `TENKI_API_KEY`. A
hosted tier could run the sandbox on your account and bill for it, which removes
the signup step that currently sits between a user and the verification feature.

**4. Services.** Agent-readiness audits and remediation for sites where the
automated fixes are the floor rather than the ceiling — large content sites,
commerce sites that want the level-5 protocol work, anyone who needs the OAuth
and MCP surface built rather than described.

## What's already in place

- `license-key` input, documented as reserved, no-op, and not required.
- Every network call goes through one client (`src/scan.js`) with a
  `scanner-url` override — a hosted scanner is a config change.
- `core.js` has no GitHub or Tenki specifics, so the same engine runs in an
  action, a CLI, a sandbox VM, or a server.
- Full JSON output at `.agent-ready/result.json` — the shape a hosted history
  would store.
- Zero dependencies, so it drops into any Node runtime without a build.

## What to be careful about

**Don't cripple the free tier to sell the paid one.** The value here is that it
works on the first run for anyone. A fixer that only runs with a license key
would make the action worse and the adoption story worse with it.

**Keep the honesty rules non-negotiable, paid or free.** The fixers refuse to
publish capability cards for endpoints that don't exist. That is the thing worth
trusting, and it's not a feature to trade away for a green checkmark on a
dashboard.

**Trademark, don't restrict.** MIT means anyone can fork and host it. A name and
a hosted service are what stay yours.

## Publishing to the Marketplace

1. Push a `v1` tag.
2. On the release page, tick **Publish this Action to the GitHub Marketplace**.
3. `action.yml` already carries the `name`, `description` and `branding` the
   listing needs.
4. Categories: *Code quality* and *Utilities*.

A Marketplace listing needs the action to be in a public repository with
`action.yml` at the root, which it is.
