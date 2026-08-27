# The 22 checks

The Agent Readiness score groups checks into five categories and maps them onto a
six-rung ladder. This page lists every check, whether this action fixes it, and
what to do about the ones it doesn't.

| Level | Name |
|---|---|
| 0 | Not Ready |
| 1 | Basic Web Presence |
| 2 | Bot-Aware |
| 3 | Agent-Readable |
| 4 | Agent-Integrated |
| 5 | Agent-Commerce |

Legend: **auto** — fixed with no input · **needs input** — fixed once you supply
an endpoint · **manual** — outside what a repo-level action can safely do.

## Discoverability

| Check | Status | Notes |
|---|---|---|
| `robotsTxt` | auto | RFC 9309. Merged into an existing file if you have one. |
| `sitemap` | auto | Built from discovered routes; skipped if you already ship one. |
| `linkHeaders` | auto | RFC 8288, via `_headers` or `vercel.json`. Impossible on GitHub Pages. |
| `dnsAid` | manual | Needs SVCB/HTTPS records under `_agents.<domain>` in your DNS zone. |

## Content accessibility

| Check | Status | Notes |
|---|---|---|
| `markdownNegotiation` | auto | Needs both a `.md` twin per page **and** a server that honours `Accept: text/markdown`. The action writes the twins everywhere and wires the server on Cloudflare Pages; other hosts get a snippet. |

## Bot access control

| Check | Status | Notes |
|---|---|---|
| `robotsTxtAiRules` | auto | Named groups for 18 AI crawlers. |
| `contentSignals` | auto | `Content-Signal:` per your `ai-policy`. |
| `webBotAuth` | manual | Informational; does not affect the score. Only relevant if you operate a crawler. |

## Protocol discovery

| Check | Status | Notes |
|---|---|---|
| `agentSkills` | auto | Indexes skills in `skills/` or `.claude/skills/`; publishes a `read-site` skill if you have none. |
| `apiCatalog` | needs input | Set `openapi-url` or `api-docs-url`. RFC 9727. |
| `mcpServerCard` | needs input | Set `mcp-endpoint`. |
| `a2aAgentCard` | needs input | Set `a2a-endpoint` (falls back to `mcp-endpoint`). |
| `oauthDiscovery` | manual | RFC 8414 metadata belongs to a real authorization server. |
| `oauthProtectedResource` | manual | RFC 9728 metadata belongs to the protected API. |
| `authMd` | manual | Only passes alongside real OAuth metadata. |
| `webMcp` | manual | Tools registered by JavaScript at runtime, in your app code. |
| `ard` | manual | Describes a live capability surface. |

## Commerce (informational, unscored)

`x402` · `mpp` · `ucp` · `acp` · `ap2` — only relevant if you sell to agents.
`ap2` additionally requires an A2A Agent Card.

---

## Why some checks are deliberately not automated

`mcpServerCard`, `a2aAgentCard` and `apiCatalog` all advertise a live endpoint to
other agents. Generating them from nothing would flip the check green while
making your site *worse*: agents would discover the card, call the endpoint, and
fail. The action refuses to write them until you confirm the endpoint exists, and
tells you in the PR exactly which one-line input to add.

The OAuth checks are the same problem with a sharper edge — a static
`/.well-known/oauth-protected-resource` tells clients where to get tokens. Wrong
information there is a security problem, not a scoring one.

## Getting to each level

**Level 1** wants `robotsTxt` and `sitemap`. Both automatic.

**Level 2** adds `contentSignals` and `robotsTxtAiRules`. Both automatic.

**Level 3** adds `markdownNegotiation` and `linkHeaders`. Automatic on Cloudflare
Pages, Netlify and Vercel; on GitHub Pages it's unreachable because the platform
serves no custom headers.

**Level 4** adds protocol discovery. `agentSkills` is automatic; the rest need one
line of config each, once the underlying thing exists.

**Level 5** is commerce. Only meaningful if agents transact with you.

## Keeping up

The scanner adds checks over time. The action reads `nextLevel.requirements`
straight from the API response, so a check it has no fixer for still appears in
the PR with the scanner's own guidance and spec links. A scheduled weekly run
surfaces new checks without you having to watch for them.
