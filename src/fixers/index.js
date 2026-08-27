'use strict';
/**
 * Fixer registry.
 *
 * A fixer owns one or more scanner check ids and returns:
 *   { files: [{path, contents, atRoot?}], notes?: [], headers?: [], needsInput?: string }
 * or null when there is nothing to do.
 *
 * `atRoot: true` means the file belongs at the repository root (build config),
 * not inside the servable site directory.
 */
const robots = require('./robots');
const sitemap = require('./sitemap');
const markdown = require('./markdown');
const linkHeaders = require('./link-headers');
const wellKnown = require('./well-known');

const FIXERS = [robots, sitemap, markdown, linkHeaders, ...wellKnown];

/**
 * Checks with no safe automated fix — they need DNS records, a running auth
 * server, or a deployed agent. We surface the scanner's own guidance for these
 * rather than pretending to fix them.
 */
const ADVISORY = {
  dnsAid: {
    title: 'DNS for AI Discovery (DNS-AID)',
    why: 'Requires SVCB/HTTPS records under `_agents.<domain>`, which lives in your DNS zone, not your repo.',
    how: 'In Cloudflare DNS add an SVCB record for `_index._agents.<domain>` pointing at your agent entrypoint. This action does not touch DNS.',
  },
  webBotAuth: {
    title: 'Web Bot Auth',
    why: 'Informational only — it does not currently affect your score.',
    how: 'If you operate a crawler, publish a signature directory at `/.well-known/http-message-signatures-directory`.',
  },
  oauthDiscovery: {
    title: 'OAuth authorization server discovery (RFC 8414)',
    why: 'Only meaningful if you actually run an OAuth authorization server.',
    how: 'Serve `/.well-known/oauth-authorization-server` from your identity provider. Publishing a static stub would break clients that trust it.',
  },
  oauthProtectedResource: {
    title: 'OAuth protected resource metadata (RFC 9728)',
    why: 'Describes a real protected API and the authorization servers that guard it.',
    how: 'Serve `/.well-known/oauth-protected-resource` from the API itself, listing `resource` and `authorization_servers`.',
  },
  authMd: {
    title: 'auth.md',
    why: 'Human/agent-readable login instructions; only passes alongside real OAuth metadata.',
    how: 'Publish `/auth.md` describing how an agent authenticates, once `oauthProtectedResource` is in place.',
  },
  webMcp: {
    title: 'WebMCP',
    why: 'Requires MCP tools registered by JavaScript on the page at runtime.',
    how: 'Register tools via the WebMCP browser API in your app code, then rerun the scan.',
  },
  ard: {
    title: 'ARD capability manifest',
    why: 'Describes a live capability surface, not static content.',
    how: 'Publish an ARD manifest once you have capabilities to declare.',
  },
  x402: { title: 'x402 payments', why: 'Commerce checks are informational and do not affect the score.', how: 'Only relevant if you sell to agents.' },
  mpp: { title: 'MPP', why: 'Commerce checks are informational and do not affect the score.', how: 'Only relevant if you sell to agents.' },
  ucp: { title: 'Universal Commerce Protocol', why: 'Commerce checks are informational and do not affect the score.', how: 'Only relevant if you sell to agents.' },
  acp: { title: 'Agentic Commerce Protocol', why: 'Commerce checks are informational and do not affect the score.', how: 'Only relevant if you sell to agents.' },
  ap2: { title: 'AP2', why: 'Commerce checks are informational and do not affect the score.', how: 'Requires an A2A Agent Card first.' },
};

/** Every check id this action can fix automatically. */
const FIXABLE = new Set(FIXERS.flatMap((f) => f.checks));

/** Find the fixer that owns a check id. */
function fixerFor(checkId) {
  return FIXERS.find((f) => f.checks.includes(checkId)) || null;
}

module.exports = { FIXERS, ADVISORY, FIXABLE, fixerFor };
