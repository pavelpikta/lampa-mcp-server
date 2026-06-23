# lampa-mcp-server

An [MCP](https://modelcontextprotocol.io) server for AI-assisted development on the [Lampa](https://github.com/yumata/lampa-source) open-source TV app.

It gives AI agents (Claude, Cursor, etc.) structured, read-only access to the Lampa source tree — so they understand the repo before making changes.

---

## What it does

The server exposes **24 tools** and **5 resources** across five capability layers:

| Layer | File | Purpose |
|---|---|---|
| Discovery | `discovery.ts` | Navigate repo structure, list modules, search code, read file segments |
| Analysis | `analysis.ts` | Locate settings, API calls, UI components, translations, styles, dependency maps |
| Planning | `planning.ts` | Generate change plans, impact analysis, edit target suggestions, risk scans |
| Editing | `editing.ts` | Draft patches, scaffold plugins, generate hook/setting boilerplate |
| Validation | `validation.ts` | Grep quality checks, find related tests, resolve build commands, query docs |

### Tools

**Discovery**
- `repo_overview` — summarise app structure, folders, entrypoints, plugins, scripts
- `list_modules` — list JS/TS modules in any subfolder
- `find_files` — find files by name pattern or extension
- `search_code` — regex/text search with file:line previews (uses `ripgrep` when available)
- `read_file_segment` — read a line range from any repo file
- `list_scripts` — show all NPM scripts

**Analysis**
- `find_settings` — locate `Lampa.Settings.add` and `Lampa.Storage` usage
- `find_api_calls` — find `fetch`, `$.ajax`, provider integrations
- `find_ui_component` — find templates, components, views by name
- `find_translation_keys` — look up translation keys across all language files
- `find_styles_for_module` — find CSS/SCSS files for a feature
- `module_dependency_map` — map imports and reverse dependencies with blast radius
- `find_feature` — infer all files for a named feature (player, catalog, iptv, etc.)

**Planning**
- `plan_feature_change` — step-by-step implementation plan (call before `draft_patch`)
- `impact_analysis` — reference count + risk level for a target file
- `suggest_edit_targets` — minimal file set and safe insertion guidance
- `risk_scan` — detect global coupling: events, storage, shared templates, DOM globals

**Editing**
- `draft_patch` — guided patch draft with file previews and Lampa patterns (requires prior plan)
- `insert_hook` — find the right `Lampa.Listener` hook for a lifecycle event
- `add_setting` — generate toggle/select/input setting boilerplate
- `scaffold_plugin_integration` — full plugin folder scaffold with `main.js` + CSS

**Validation**
- `run_grep_checks` — scan for TODOs, `console.log`, loose `undefined` checks, hardcoded strings
- `list_related_tests` — find spec files for a module
- `run_build_hint` — resolve the right build/test/doc command from `package.json`
- `doc_lookup` — search generated docs or README for a topic

### Resources

| URI | Description |
|---|---|
| `repo://overview` | Top-level directory listing |
| `repo://scripts` | NPM scripts as JSON |
| `docs://index` | Generated JSDoc (requires `npm run doc` in the Lampa repo) |
| `settings://catalog` | All settings registrations in the repo |
| `api://integrations` | All API call sites |

---

## Requirements

- Node.js 20+
- A local checkout of the [Lampa source repo](https://github.com/yumata/lampa-source)
- Optional: [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) for faster search — falls back to pure Node if not present

---

## Setup

```bash
git clone https://github.com/your-username/lampa-mcp-server
cd lampa-mcp-server
npm install
npm run build
```

Copy `.env.example` to `.env` and set the path to your Lampa checkout:

```bash
cp .env.example .env
# edit .env:
# LAMPA_REPO_PATH=/path/to/lampa-source
```

---

## Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Connect to Cursor

Add to `.cursor/mcp.json` in your project (or the global `~/.cursor/mcp.json`):

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

## Recommended agent workflow

The server enforces a deliberate two-step contract: **plan first, patch second**.

```
repo_overview → find_feature → module_dependency_map
    → plan_feature_change → draft_patch
```

**System prompt for best results:**

> You are an AI coding agent working on the Lampa source repository.
> Always begin by collecting context through MCP tools: overview, relevant modules, settings, API calls, and dependency map.
> Do not invent project structure or framework patterns.
> Before writing code, produce: affected files, why each matters, implementation steps, risks, and validation checks.
> When generating code, preserve naming, style, and surrounding patterns used in the target files.

---

## Project structure

```
src/
├── index.ts               # Server entry point
├── config.ts              # Repo path config (LAMPA_REPO_PATH)
├── utils/
│   ├── fs.ts              # File system helpers
│   ├── search.ts          # ripgrep + Node fallback search
│   └── lampa.ts           # Lampa-specific patterns, feature map, risk patterns
├── tools/
│   ├── discovery.ts       # Phase 1 — repo navigation
│   ├── analysis.ts        # Phase 2 — Lampa understanding
│   ├── planning.ts        # Phase 3 — change planning
│   ├── editing.ts         # Phase 4 — assisted editing
│   └── validation.ts      # Phase 5 — quality checks
└── resources/
    └── index.ts           # MCP resources (read-only stable context)
```

---

## Development

```bash
npm run build   # compile TypeScript → dist/
npm run dev     # run directly with ts-node (requires ts-node)
npm start       # run compiled dist/index.js
```

---

## License

MIT
