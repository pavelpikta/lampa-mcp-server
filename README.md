# lampa-mcp-server

An [MCP](https://modelcontextprotocol.io) server for AI-assisted development on the [Lampa](https://github.com/yumata/lampa-source) open-source TV app.

It gives AI agents (Claude, Cursor, etc.) structured, read-only access to the Lampa source tree — so they understand the repo before making changes.

---

## What it does

The server exposes **41 tools** and **5 resources** across seven capability layers:

| Layer | File | Tools | Purpose |
|---|---|---|---|
| Discovery | `discovery.ts` | 6 | Navigate repo structure, list modules, search code, read files |
| Analysis | `analysis.ts` | 7 | Locate settings, API calls, UI components, translations, dependency maps |
| Planning | `planning.ts` | 4 | Generate change plans, impact analysis, edit targets, risk scans |
| Editing | `editing.ts` | 4 | Draft patches, scaffold plugins, generate hook/setting boilerplate |
| Validation | `validation.ts` | 4 | Quality checks, find tests, resolve build commands, query docs |
| Lampa Deep | `lampa_deep.ts` | 8 | Deep Lampa-specific analysis: providers, events, translations, lifecycle |
| Advanced | `advanced.ts` | 8 | File reads, storage schema, event bus map, network map, pattern guide |

---

### Tools

**Discovery**
- `repo_overview` — summarise app structure, folders, entrypoints, plugins, and scripts
- `list_modules` — list JS/TS modules in any subfolder
- `find_files` — find files by name pattern or extension
- `search_code` — regex/text search with file:line previews (uses `ripgrep` when available)
- `read_file_segment` — read a specific line range from any repo file
- `list_scripts` — show all NPM scripts from `package.json`

**Analysis**
- `find_settings` — locate `Lampa.Settings.add` and `Lampa.Storage` usage; optionally filter by keyword
- `find_api_calls` — find `fetch`, `$.ajax`, and provider integrations
- `find_ui_component` — find templates, components, and views by name
- `find_translation_keys` — look up translation key definitions and usages across all language files
- `find_styles_for_module` — find CSS/SCSS files related to a module or feature name
- `module_dependency_map` — map imports and reverse dependencies with change blast radius
- `find_feature` — infer all files relevant to a named feature (player, catalog, iptv, search, etc.)

**Planning**
- `plan_feature_change` — step-by-step implementation plan (call before `draft_patch`)
- `impact_analysis` — reference count and risk level for a target file
- `suggest_edit_targets` — minimal file set and safe insertion guidance for a feature request
- `risk_scan` — detect coupling risks: global events, storage, shared templates, DOM globals

**Editing**
- `draft_patch` — guided patch draft with file previews and Lampa patterns (requires prior `plan_feature_change`)
- `insert_hook` — find the best `Lampa.Listener` hook point for a lifecycle trigger
- `add_setting` — generate toggle / select / input setting boilerplate with storage wiring
- `scaffold_plugin_integration` — full plugin folder scaffold with `main.js`, CSS, and component boilerplate

**Validation**
- `run_grep_checks` — scan for TODOs, `console.log` leftovers, loose `undefined` checks, hardcoded strings
- `list_related_tests` — find spec files related to a module or feature
- `run_build_hint` — resolve the right build / dev / test / lint command from `package.json`
- `doc_lookup` — search generated docs or README for a topic

**Lampa Deep**
- `plugin_deep_dive` — single-call analysis of a plugin folder: files, Lampa API usage, events, settings, entry-point preview
- `list_streaming_providers` — catalog all online streaming providers with base URLs, methods, and Lampa APIs used
- `translation_coverage` — compare all language files against the English reference; shows coverage % and missing keys per language
- `trace_event` — trace a `Lampa.Listener` event through the full codebase: who sends it, who follows it
- `lampa_api_surface` — extract the complete `Lampa.*` global API surface: every module with sub-methods and file usage counts
- `list_templates` — list all UI templates in `src/templates/`; optionally read one to inspect HTML and data bindings
- `generate_plugin_boilerplate` — generate working plugin code for selected features: settings, hooks, storage, lang keys, IPTV
- `component_lifecycle` — deep-analyse a component: lifecycle methods, events, APIs, storage, templates, and settings

**Advanced**
- `read_file` — read a complete file (truncated at `max_lines`); use `read_file_segment` for large files
- `get_storage_schema` — scan all `Lampa.Storage.get/set` calls; returns a complete key → default / readers / writers table
- `list_all_events` — build a full `Lampa.Listener` event bus map: every event, listener count, emitter count, orphan detection
- `get_network_map` — extract all hardcoded URLs, base URL variables, and proxy names from any scope
- `validate_plugin` — score a plugin against 10 Lampa conventions (IIFE, strict mode, `appready` bootstrap, no `eval`, etc.)
- `extract_template_html` — extract actual HTML markup, CSS classes, and data-binding placeholders from `src/templates/*.js`
- `get_core_module` — browse and read `src/core/` modules; lists all available when called without a name
- `explain_lampa_pattern` — pattern reference guide backed by live source examples: `iife-plugin`, `storage`, `settings`, `events`, `component`, `request`, `template`, `activity`, `player-hook`

---

### Resources

| URI | Description |
|---|---|
| `repo://overview` | Top-level directory listing |
| `repo://scripts` | NPM scripts as JSON |
| `docs://index` | Generated JSDoc (requires `npm run doc` in the Lampa repo) |
| `settings://catalog` | All `Lampa.Settings.add` registrations in the repo |
| `api://integrations` | All API and network call sites |

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

Set the path to your Lampa checkout via the environment variable:

```bash
export LAMPA_REPO_PATH=/path/to/lampa-source
```

Or pass it inline when starting the server:

```bash
LAMPA_REPO_PATH=/path/to/lampa-source node dist/index.js
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

For deep plugin work, start with the single-call analysis tools:

```
plugin_deep_dive → trace_event → get_storage_schema
    → plan_feature_change → draft_patch → validate_plugin
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
├── config.ts              # Repo path config (LAMPA_REPO_PATH env var)
├── utils/
│   ├── fs.ts              # File system helpers
│   ├── search.ts          # ripgrep + Node fallback search
│   ├── lampa.ts           # Lampa-specific patterns, feature map, risk patterns
│   └── lampa_deep.ts      # Deep analysis utilities (events, lifecycle, providers)
├── tools/
│   ├── discovery.ts       # Phase 1 — repo navigation (6 tools)
│   ├── analysis.ts        # Phase 2 — Lampa understanding (7 tools)
│   ├── planning.ts        # Phase 3 — change planning (4 tools)
│   ├── editing.ts         # Phase 4 — assisted editing (4 tools)
│   ├── validation.ts      # Phase 5 — quality checks (4 tools)
│   ├── lampa_deep.ts      # Lampa-specific deep analysis (8 tools)
│   └── advanced.ts        # File I/O, schema, pattern guide (8 tools)
└── resources/
    └── index.ts           # MCP resources (5 read-only stable context endpoints)
```

---

## Development

```bash
npm run build         # compile TypeScript → dist/
npm run dev           # run directly with ts-node
npm start             # run compiled dist/index.js
npm run typecheck     # type-check without emitting
npm run lint          # ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format        # Prettier write
npm run format:check  # Prettier check (CI)
```

---

## License

MIT
