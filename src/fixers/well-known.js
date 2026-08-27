'use strict';
/**
 * The /.well-known/ family: api-catalog (RFC 9727), agent skills discovery,
 * MCP Server Card (SEP-1649) and A2A Agent Card.
 *
 * Deliberate policy: these advertise capabilities to other agents. Publishing a
 * card that points at an MCP server you do not run, or an API catalog for an API
 * that does not exist, makes your site worse, not more ready — agents will call
 * it and fail. So each of these only writes a file when we can back it with
 * something real: an input you supplied, or a spec file already in the repo.
 * Otherwise the check is reported as "needs input" with the exact one-liner to
 * turn it on.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { json } = require('../util');

const sha256 = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------------------------------------------ api-catalog */

function findOpenapi(root) {
  const candidates = [
    'openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml',
    'public/openapi.json', 'static/openapi.json', 'docs/openapi.json', 'api/openapi.json',
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c))) return '/' + c.replace(/^(public|static|docs)\//, '');
  }
  return null;
}

const apiCatalog = {
  id: 'apiCatalog',
  checks: ['apiCatalog'],
  title: 'API catalog (RFC 9727)',
  category: 'discovery',
  apply(ctx) {
    if (ctx.read('.well-known/api-catalog')) return null;

    const openapi = ctx.inputs.openapiUrl || findOpenapi(ctx.site.root);
    const docs = ctx.inputs.apiDocsUrl;
    const mcp = ctx.inputs.mcpEndpoint;
    if (!openapi && !docs && !mcp) {
      return {
        files: [],
        needsInput: 'Set `openapi-url`, `api-docs-url`, or `mcp-endpoint` and this file is generated automatically. Publishing an empty catalog would advertise APIs you do not serve.',
      };
    }

    const abs = (u) => (/^https?:/i.test(u) ? u : ctx.origin + (u.startsWith('/') ? u : '/' + u));
    const entry = { anchor: mcp ? abs(mcp) : ctx.origin + '/' };
    if (openapi) entry['service-desc'] = [{ href: abs(openapi), type: 'application/json' }];
    if (docs) entry['service-doc'] = [{ href: abs(docs), type: 'text/html' }];
    if (!docs) entry['service-doc'] = [{ href: ctx.origin + '/llms.txt', type: 'text/plain' }];

    const linkset = { linkset: [entry] };
    if (mcp) {
      linkset.linkset.push({
        anchor: abs(mcp),
        'service-desc': [{ href: ctx.origin + '/.well-known/mcp/server-card.json', type: 'application/json' }],
      });
    }

    return {
      files: [{ path: '.well-known/api-catalog', contents: json(linkset) }],
      notes: [
        'The catalog must be served as `application/linkset+json`. The `_headers` rule in this PR sets that content type.',
      ],
      headers: [{ match: '/.well-known/api-catalog', name: 'Content-Type', value: 'application/linkset+json' }],
    };
  },
};

/* ---------------------------------------------------------------- agent skills */

/** Skills already authored in the repo, in the conventional locations. */
function repoSkills(root) {
  const dirs = ['skills', '.claude/skills', 'public/.well-known/agent-skills', 'static/.well-known/agent-skills'];
  const out = [];
  for (const d of dirs) {
    const full = path.join(root, d);
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillFile = path.join(full, e.name, 'SKILL.md');
      let body;
      try { body = fs.readFileSync(skillFile, 'utf8'); } catch { continue; }
      const desc = (body.match(/^description:\s*(.+)$/m) || [])[1] || `The ${e.name} skill for this site.`;
      out.push({ name: e.name, body, description: desc.replace(/^["']|["']$/g, '').trim() });
    }
  }
  return out;
}

const agentSkills = {
  id: 'agentSkills',
  checks: ['agentSkills'],
  title: 'Agent skills discovery index',
  category: 'discovery',
  apply(ctx) {
    if (ctx.read('.well-known/agent-skills/index.json')) return null;

    const found = repoSkills(ctx.site.root);
    const files = [];
    const skills = [];

    for (const s of found) {
      const rel = `.well-known/agent-skills/${s.name}/SKILL.md`;
      files.push({ path: rel, contents: s.body });
      skills.push({
        name: s.name,
        type: 'skill-md',
        description: s.description,
        url: '/' + rel,
        digest: sha256(s.body),
      });
    }

    if (!skills.length) {
      // Publish one honest, useful skill: how to read this site as an agent.
      const body = readSiteSkill(ctx);
      const rel = '.well-known/agent-skills/read-site/SKILL.md';
      files.push({ path: rel, contents: body });
      skills.push({
        name: 'read-site',
        type: 'skill-md',
        description: `Read ${ctx.identity.name} efficiently as an agent: fetch Markdown instead of HTML, and start from llms.txt.`,
        url: '/' + rel,
        digest: sha256(body),
      });
    }

    const index = { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills };
    files.push({ path: '.well-known/agent-skills/index.json', contents: json(index) });

    return {
      files,
      notes: [
        found.length
          ? `Indexed ${found.length} skill${found.length === 1 ? '' : 's'} already in your repo.`
          : 'No skills found in `skills/` or `.claude/skills/`, so a single `read-site` skill was published describing how agents should consume this site. Add your own skills to `skills/<name>/SKILL.md` and rerun to index them.',
        'Digests are SHA-256 over the skill body — regenerate the index whenever a skill changes.',
      ],
    };
  },
};

function readSiteSkill(ctx) {
  return `---
name: read-site
description: Read ${ctx.identity.name} efficiently as an agent — fetch Markdown instead of HTML, and start from llms.txt.
---

# Reading ${ctx.identity.name}

${ctx.identity.description || `${ctx.identity.name} publishes agent-readable copies of its pages.`}

## Start here

Fetch \`${ctx.origin}/llms.txt\`. It is a Markdown index of the site's canonical
pages with a one-line description of each.

## Fetching a page

Send \`Accept: text/markdown\` and you get Markdown back instead of HTML:

\`\`\`
GET ${ctx.origin}/some-page
Accept: text/markdown
\`\`\`

Every page is also directly available at its \`.md\` path, so
\`${ctx.origin}/some-page.md\` works if content negotiation is not convenient.

## Crawl rules

\`${ctx.origin}/robots.txt\` declares which agents may crawl and, via
\`Content-Signal\`, what the content may be used for. Honour it.

## Enumerating pages

\`${ctx.origin}/sitemap.xml\` lists every canonical URL.
`;
}

/* -------------------------------------------------------------- MCP server card */

const mcpServerCard = {
  id: 'mcpServerCard',
  checks: ['mcpServerCard'],
  title: 'MCP Server Card',
  category: 'discovery',
  apply(ctx) {
    if (ctx.read('.well-known/mcp/server-card.json')) return null;
    const endpoint = ctx.inputs.mcpEndpoint;
    if (!endpoint) {
      return {
        files: [],
        needsInput: 'Set `mcp-endpoint: https://your-site/mcp` and a valid Server Card is generated. Skipped on purpose — a card pointing at an MCP server you do not run makes agents fail against your site.',
      };
    }
    const card = {
      serverInfo: { name: ctx.identity.name, version: '1.0.0' },
      description: ctx.identity.description || `MCP server for ${ctx.identity.name}.`,
      url: /^https?:/i.test(endpoint) ? endpoint : ctx.origin + (endpoint.startsWith('/') ? endpoint : '/' + endpoint),
      transport: { type: 'streamable-http' },
      capabilities: { tools: true },
    };
    return {
      files: [{ path: '.well-known/mcp/server-card.json', contents: json(card) }],
      notes: ['Bump `serverInfo.version` when your tool surface changes, and set `capabilities` to match what your server actually implements.'],
    };
  },
};

/* --------------------------------------------------------------- A2A agent card */

const a2aAgentCard = {
  id: 'a2aAgentCard',
  checks: ['a2aAgentCard'],
  title: 'A2A Agent Card',
  category: 'discovery',
  apply(ctx) {
    if (ctx.read('.well-known/agent-card.json')) return null;
    const endpoint = ctx.inputs.a2aEndpoint || ctx.inputs.mcpEndpoint;
    if (!endpoint) {
      return {
        files: [],
        needsInput: 'Set `a2a-endpoint` (or `mcp-endpoint`) to publish an A2A Agent Card. Skipped on purpose — an agent card with no agent behind it is worse than none.',
      };
    }
    const url = /^https?:/i.test(endpoint) ? endpoint : ctx.origin + (endpoint.startsWith('/') ? endpoint : '/' + endpoint);
    const card = {
      name: ctx.identity.name,
      version: '1.0.0',
      description: ctx.identity.description || `Agent interface for ${ctx.identity.name}.`,
      supportedInterfaces: [{ url, transport: 'JSONRPC' }],
      capabilities: { streaming: false, pushNotifications: false },
      skills: [
        {
          id: 'read-site',
          name: 'Read site content',
          description: `Retrieve pages from ${ctx.identity.name} as Markdown.`,
        },
      ],
    };
    return {
      files: [{ path: '.well-known/agent-card.json', contents: json(card) }],
      notes: ['Replace the placeholder skill with the operations your agent actually exposes before you rely on this.'],
    };
  },
};

module.exports = [apiCatalog, agentSkills, mcpServerCard, a2aAgentCard];
