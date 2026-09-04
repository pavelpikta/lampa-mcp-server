# lampa-mcp-server

<a href="https://glama.ai/mcp/servers/pavelpikta/lampa-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/pavelpikta/lampa-mcp-server/badge" alt="lampa-mcp-server MCP server" />
</a>

An [MCP](https://modelcontextprotocol.io) server for AI-assisted development on the [Lampa](https://github.com/yumata/lampa-source) open-source TV app.

It gives AI agents (Claude, Cursor, etc.) structured, read-only access to the Lampa source tree — so they understand the repo before making changes.

Runs in two modes:

- **Local stdio** — Node process spawned by Cursor / Claude Desktop (unchanged workflow)
- **Cloudflare Workers** — remote Streamable HTTP MCP at `/mcp` with GitHub PAT auth and an R2 source snapshot

---

## What it does

The server exposes discovery, analysis, planning, editing, validation, and Lampa/CUB specialty tools, plus curated resources (`lampa://plugin-guide`, `lampa://pitfalls`, `lampa://events`, `lampa://landmarks`, `lampa://edit-rules`, `lampa://api-surface`).

Preferred agent loop:

```
snapshot_info → lampa://plugin-guide | plugin_docs
  → plugin_deep_dive | search_code(prefix)
  → plan_change → scaffold_plugin_integration / draft_patch
  → validate_plugin | i18n_check
```

Use `resolve_edit_path` before editing so you change `src/` / `plugins/` rather than `public/` or `build/`.

---

## Requirements

- Node.js 20+
- For **local** mode: a checkout of [lampa-source](https://github.com/yumata/lampa-source)
- For **Workers** mode: a Cloudflare account, R2 bucket, KV namespace, and a GitHub Personal Access Token (`read:user`)

---

## Local stdio setup

```bash
git clone <this-repo>
cd lampa-mcp-server
npm install
npm run build
export LAMPA_REPO_PATH=/path/to/lampa-source
npm start
```

### Claude Desktop

```json
{
  "mcpServers": {
    "lampa-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/lampa-mcp-server/dist/index.js"],
      "env": {
        "LAMPA_REPO_PATH": "/absolute/path/to/lampa-source"
      }
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "lampa-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/lampa-mcp-server/dist/index.js"],
      "env": {
        "LAMPA_REPO_PATH": "/absolute/path/to/lampa-source"
      }
    }
  }
}
```

---

## Cloudflare Workers (remote MCP)

Architecture: `createMcpHandler` (MCP SDK v2, stateless) + R2 Lampa snapshot + GitHub PAT auth via `resolveExternalToken` on `@cloudflare/workers-oauth-provider`.

### 1. Create Cloudflare resources

```bash
npx wrangler r2 bucket create lampa-mcp-source
npx wrangler kv namespace create OAUTH_KV
```

Put the returned KV namespace id into [`wrangler.jsonc`](wrangler.jsonc) (`kv_namespaces[0].id`).

### 2. Create a GitHub Personal Access Token

Create a [classic](https://github.com/settings/tokens) or [fine-grained](https://github.com/settings/personal-access-tokens) PAT with at least **`read:user`**.

No GitHub OAuth App / `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` is required.

Optional allowlist (comma-separated GitHub logins) in `wrangler.jsonc` vars or `.dev.vars`:

```
ALLOWED_GITHUB_USERS=your-login,coworker
```

### 3. Upload a Lampa source snapshot to R2

```bash
# clone Lampa if needed
git clone https://github.com/yumata/lampa-source temp/lampa-source

# local Miniflare R2 (for wrangler dev)
npm run snapshot:upload:local

# production R2
npm run snapshot:upload
```

Objects land under `lampa/manifest.json`, `lampa/bundle.json` (all source text), and `lampa/indexes/*.json`.

### 4. Deploy

```bash
npm run types:worker
npm run deploy
```

MCP endpoint: `https://lampa-mcp-server.<account>.workers.dev/mcp`

### 5. Connect a remote MCP client

Pass the GitHub PAT as a Bearer token. Cursor example:

```json
{
  "mcpServers": {
    "lampa": {
      "url": "https://lampa-mcp-server.<account>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ghp_YOUR_GITHUB_PAT"
      }
    }
  }
}
```

Or via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "lampa": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://lampa-mcp-server.<account>.workers.dev/mcp",
        "--header",
        "Authorization: Bearer ghp_YOUR_GITHUB_PAT"
      ]
    }
  }
}
```

Prefer storing the PAT in env / secret storage rather than committing it to `mcp.json`.

### Local Worker development

```bash
npm run snapshot:upload:local
npm run dev:worker
```

Then point the MCP inspector / client at `http://localhost:8787/mcp` with `Authorization: Bearer <pat>`.

---

## Recommended agent workflow

```
snapshot_info → lampa://plugin-guide | plugin_docs
    → plugin_deep_dive | search_code(prefix)
    → plan_change → scaffold_plugin_integration / draft_patch
    → validate_plugin | i18n_check
```

Plugin authoring must follow official `docs/en` (Listener app:ready, SettingsApi, double-load guard). Do not emit `$(document).on('appready')` or `Lampa.Settings.add`.

For CUB account/sync work:

```
cub_auth_guide → cub_api_catalog → cub_sync_guide
    → cub_data_models → cub_endpoint_detail
```

---

## Project structure

```
src/
├── index.ts                 # Local stdio entry
├── worker.ts                # Cloudflare Worker + PAT auth entry
├── server.ts                # Shared createLampaServer factory
├── config.ts                # Local Config (NodeRepoFs)
├── auth/github-handler.ts   # Public pages + GitHub PAT validation
├── fs/                      # RepoFs: types, Node, R2, paths
├── utils/                   # Async analysis helpers
├── tools/                   # MCP tools
└── resources/               # MCP resources
scripts/
└── upload-snapshot.mjs      # R2 snapshot + index uploader
wrangler.jsonc
```

---

## Development

```bash
npm run build                # wrangler types + tsc → dist/
npm run dev                  # build, then run stdio server
npm start                    # run compiled stdio server
npm run typecheck            # wrangler types + tsc --noEmit
npm run lint
npm run format
npm run types:worker         # regenerate worker-configuration.d.ts (gitignored)
npm run dev:worker           # wrangler dev
npm run deploy               # wrangler deploy
npm run snapshot:upload:local
npm run snapshot:upload
```

### Dependencies (what / why)

| Package | Role |
|---|---|
| `@modelcontextprotocol/server` | MCP SDK (stdio + shared server factory) |
| `agents` | Workers MCP handler (`createMcpHandler`) |
| `@cloudflare/workers-oauth-provider` | Worker auth wrapper (PAT via `resolveExternalToken`) |
| `hono` | Public HTML routes (`/`, `/authorize`) |
| `zod` | Tool input schemas |
| `typescript` | TypeScript 6 compiler + types for `typescript-eslint` |
| `wrangler` | Deploy, `wrangler types`, local Worker dev |
| `eslint` + `typescript-eslint` + `prettier` | Lint / format |

Runtime deps ship with both the stdio CLI and the Worker. Dev deps are local-only.

---

## License

MIT
