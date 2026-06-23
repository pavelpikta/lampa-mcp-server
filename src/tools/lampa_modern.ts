import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { Config } from "../config.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import {
  extractMakerClasses,
  extractSocketProtocol,
  extractComponentRegistry,
  extractLampaSettingsFlags,
  extractPlatformTargets,
  extractContentRows,
  extractFavoriteCategories,
  extractManifestMirrors,
  checkDeprecatedApis,
} from "../utils/lampa_modern.js";

export function registerLampaModernTools(server: McpServer, config: Config): void {
  // ── maker_module_map ───────────────────────────────────────────────────────
  server.tool(
    "maker_module_map",
    "Map the Lampa 3.0 Maker architecture: all modular classes (Card, Main, Category, Line, etc.), their module/map file paths, and lifecycle hook names. Essential for 3.0 plugin and component development.",
    {
      class_name: z
        .string()
        .optional()
        .describe("Filter to one Maker class, e.g. 'Main', 'Card', 'Episode'. Omit to list all."),
    },
    async ({ class_name }) => {
      const classes = extractMakerClasses(config.repoPath);
      const filtered = class_name
        ? classes.filter((c) => c.name.toLowerCase() === class_name.toLowerCase())
        : classes;

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: class_name
                ? `Maker class "${class_name}" not found. Available: ${classes.map((c) => c.name).join(", ")}`
                : "Maker system not found. Ensure src/interaction/maker.js exists.",
            },
          ],
        };
      }

      const maskFile = path.join(config.repoPath, "src", "utils", "mask.js");
      const maskPreview = readFileSafe(maskFile)?.split("\n").slice(0, 25).join("\n") ?? "";

      const rows = [
        `# Lampa Maker Module Map  (${filtered.length} class${filtered.length > 1 ? "es" : ""})`,
        ``,
        `| Class | Class file | Module | Map hooks |`,
        `|-------|-----------|--------|-----------|`,
        ...filtered.map(
          (c) =>
            `| \`${c.name}\` | \`${c.classPath}\` | \`${c.modulePath ?? "—"}\` | ${c.mapHooks.length > 0 ? c.mapHooks.join(", ") : "—"} |`
        ),
        ``,
        `## API quick reference`,
        `- \`Lampa.Maker.make('Main', data, moduleFn)\` — create instance with modules`,
        `- \`Lampa.Maker.get('Main')\` — get class constructor`,
        `- \`Lampa.Maker.module('Main').toggle(MASK.base, 'Callback')\` — configure modules`,
        `- \`Lampa.Maker.map('Main')\` — override lifecycle hooks`,
        `- \`Lampa.Maker.list()\` — list all class names`,
        ``,
        `## MaskHelper (src/utils/mask.js)`,
        `\`\`\`javascript`,
        maskPreview,
        `\`\`\``,
        ``,
        `See UPGRADE.md for migration from deprecated Lampa.Card / InteractionMain.`,
      ];

      return { content: [{ type: "text" as const, text: rows.join("\n") }] };
    }
  );

  // ── socket_protocol_map ────────────────────────────────────────────────────
  server.tool(
    "socket_protocol_map",
    "Map the Lampa WebSocket sync protocol: inbound server methods, outbound client sends, mirror hosts, and connection URL pattern. Used for multi-device sync and remote control.",
    {},
    async () => {
      const proto = extractSocketProtocol(config.repoPath);

      const inboundBlock = proto.inbound
        .map((m) => `- \`${m.method}\` — ${m.description}`)
        .join("\n");

      const outboundBlock = proto.outbound
        .map((m) => `- \`${m.method}\` — ${m.context}`)
        .join("\n");

      const out = [
        `# Lampa WebSocket Protocol`,
        ``,
        `**URL pattern:** ${proto.urlPattern}`,
        `**Mirrors (soc_mirrors):** ${proto.mirrors.join(", ")}`,
        `**Gated by:** \`window.lampa_settings.socket_use\` and \`socket_methods\``,
        ``,
        `## Inbound methods (server → client)`,
        inboundBlock,
        ``,
        `## Outbound methods (client → server)`,
        outboundBlock,
        ``,
        `## Payload envelope`,
        `Every outbound message includes: \`device_id\`, \`name\`, \`method\`, \`version\`, \`account\`, \`premium\`, \`terminal\``,
        ``,
        `> Remote terminal requires \`Storage.terminal_access\` code match.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── activity_component_registry ──────────────────────────────────────────────
  server.tool(
    "activity_component_registry",
    "Registry of all navigation components: Lampa.Component.add registrations and Router routes. Maps component name strings to their source files — essential for Activity.push and back-navigation debugging.",
    {
      name: z
        .string()
        .optional()
        .describe("Filter by component or route name, e.g. 'full', 'iptv', 'online'."),
    },
    async ({ name }) => {
      let registry = extractComponentRegistry(config.repoPath);
      if (name) {
        const lower = name.toLowerCase();
        registry = registry.filter((r) => r.name.toLowerCase().includes(lower));
      }

      if (registry.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: name
                ? `No components/routes matching "${name}".`
                : "No component registrations found.",
            },
          ],
        };
      }

      const components = registry.filter((r) => r.type === "component");
      const routes = registry.filter((r) => r.type === "router");

      const fmt = (items: typeof registry) =>
        items.map((r) => `| \`${r.name}\` | ${r.type} | \`${r.file}\` | ${r.line} |`).join("\n");

      const out = [
        `# Activity Component Registry  (${registry.length} entries)`,
        ``,
        `## Router routes (${routes.length})`,
        `| Name | Type | File | Line |`,
        `|------|------|------|------|`,
        fmt(routes) || "| — | — | — | — |",
        ``,
        `## Component registrations (${components.length})`,
        `| Name | Type | File | Line |`,
        `|------|------|------|------|`,
        fmt(components) || "| — | — | — | — |",
        ``,
        `**Navigate:** \`Lampa.Activity.push({ component: 'name', ... })\` or \`Lampa.Router.call('route', data)\``,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── lampa_settings_flags ─────────────────────────────────────────────────────
  server.tool(
    "lampa_settings_flags",
    "Parse window.lampa_settings feature flags from src/app.js: socket, account, plugins, torrents, disable_features, IPTV mode side effects, and platform overrides.",
    {
      filter: z
        .string()
        .optional()
        .describe("Filter flags by keyword, e.g. 'socket', 'torrents', 'disable_features'."),
    },
    async ({ filter }) => {
      let flags = extractLampaSettingsFlags(config.repoPath);
      if (filter) {
        const lower = filter.toLowerCase();
        flags = flags.filter((f) => f.key.toLowerCase().includes(lower));
      }

      if (flags.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "lampa_settings not found in src/app.js.",
            },
          ],
        };
      }

      const rows = flags.map(
        (f) =>
          `| \`${f.key}\` | \`${f.defaultValue}\` | ${f.gates ?? (f.nested ? "disable_features sub-flag" : "—")} |`
      );

      const out = [
        `# lampa_settings Feature Flags  (${flags.length})`,
        ``,
        `Defined in \`src/app.js\` via \`Arrays.extend(window.lampa_settings, {...})\``,
        `Platforms and stores can override flags (e.g. RuStore disables torrents, IPTV mode disables account/plugins).`,
        ``,
        `| Flag | Default | Notes |`,
        `|------|---------|-------|`,
        ...rows,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── platform_packaging_guide ─────────────────────────────────────────────────
  server.tool(
    "platform_packaging_guide",
    "Platform build and packaging targets from gulpfile.js: web dev, webOS, Tizen, GitHub Pages, plugins, and docs. Shows gulp task, output directory, and index shell for each target.",
    {},
    async () => {
      const targets = extractPlatformTargets(config.repoPath);
      const pkg = readFileSafe(path.join(config.repoPath, "package.json"));
      let scripts = "";
      if (pkg) {
        const data = JSON.parse(pkg) as { scripts?: Record<string, string> };
        scripts = Object.entries(data.scripts ?? {})
          .map(([k, v]) => `- \`npm run ${k}\` → ${v}`)
          .join("\n");
      }

      const rows = targets.map(
        (t) => `| \`${t.gulpTask}\` | \`${t.outputDir}\` | \`${t.indexShell}\` | ${t.description} |`
      );

      const out = [
        `# Lampa Platform Packaging Guide`,
        ``,
        `## NPM scripts`,
        scripts || "No package.json scripts found.",
        ``,
        `## Gulp targets`,
        `| Task | Output | Index shell | Description |`,
        `|------|--------|-------------|-------------|`,
        ...rows,
        ``,
        `## Build pipeline`,
        `\`src/app.js\` + plugins → Rollup/Babel → \`dest/\` → uglify → \`build/{web,webos,tizen,github}/\``,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── content_rows_api ─────────────────────────────────────────────────────────
  server.tool(
    "content_rows_api",
    "List all ContentRows.add registrations — the extension point for injecting custom home-screen rows on main/category screens. Used by favorites, IPTV, and plugins.",
    {},
    async () => {
      const rows = extractContentRows(config.repoPath);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No ContentRows.add registrations found.",
            },
          ],
        };
      }

      const table = rows.map(
        (r) =>
          `| \`${r.name}\` | ${r.title ?? "—"} | ${r.screen.join(", ") || "—"} | \`${r.file}\`:${r.line} |`
      );

      const out = [
        `# ContentRows Extension Points  (${rows.length})`,
        ``,
        `Register rows with:`,
        `\`\`\`javascript`,
        `Lampa.ContentRows.add({`,
        `  name: 'my_row',`,
        `  title: 'My Row',`,
        `  index: 1,`,
        `  screen: ['main', 'category'],`,
        `  call: (params, screen) => function(callback) { /* build row */ }`,
        `})`,
        `\`\`\``,
        ``,
        `| name | title | screens | source |`,
        `|------|-------|---------|--------|`,
        ...table,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── favorite_category_schema ─────────────────────────────────────────────────
  server.tool(
    "favorite_category_schema",
    "Document favorite/bookmark category types from src/core/favorite.js: like, watch, book, history, look, viewed, scheduled, continued, thrown — and which are timeline marks.",
    {},
    async () => {
      const info = extractFavoriteCategories(config.repoPath);
      if (!info) {
        return {
          content: [{ type: "text" as const, text: "src/core/favorite.js not found." }],
        };
      }

      const out = [
        `# Favorite Category Schema`,
        ``,
        `**Source:** \`${info.file}\``,
        ``,
        `## All categories (${info.categories.length})`,
        info.categories.map((c) => `- \`${c}\``).join("\n"),
        ``,
        `## Timeline marks (${info.marks.length})`,
        `Subset used for watch-state tracking:`,
        info.marks.map((m) => `- \`${m}\``).join("\n"),
        ``,
        `## Usage`,
        `- Local: \`Lampa.Favorite.get({ type: 'history' })\``,
        `- Cloud sync: CUB \`bookmarks/*\` and \`timeline/*\` APIs (requires account)`,
        `- Home row: \`continue_watch\` ContentRow injects continued viewing on main screen`,
        ``,
        `> Note: category array uses \`wath\` (typo preserved in source) for the watch list.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── manifest_mirrors_map ─────────────────────────────────────────────────────
  server.tool(
    "manifest_mirrors_map",
    "Document CUB mirror resolution: cub_mirrors, soc_mirrors, cub_domain selection, app version, and CDN URL logic from src/core/manifest.js.",
    {},
    async () => {
      const mirrors = extractManifestMirrors(config.repoPath);

      const out = [
        `# Lampa Manifest & Mirrors`,
        ``,
        `| Property | Value / logic |`,
        `|----------|--------------|`,
        ...Object.entries(mirrors).map(([k, v]) => `| \`${k}\` | ${v} |`),
        ``,
        `## Resolution logic`,
        `- \`cub_domain\`: reads \`localStorage.cub_domain\`; falls back to first \`cub_mirrors\` entry if invalid`,
        `- \`cub_mirrors\`: built-in list + user-added mirrors from \`localStorage.cub_mirrors\``,
        `- \`soc_mirrors\`: separate list for WebSocket (may differ from HTTP mirrors)`,
        `- \`cub_alive\`: health-check selects working mirror at runtime`,
        ``,
        `Use \`get_network_map\` to find hardcoded URLs in plugins.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── upgrade_migration_checker ────────────────────────────────────────────────
  server.tool(
    "upgrade_migration_checker",
    "Check a file for deprecated Lampa 2.x APIs that must be migrated to Maker modules (Lampa.Card, InteractionMain, InteractionCategory, InteractionLine). Based on UPGRADE.md 2.4.7 → 3.0 guide.",
    {
      file: z.string().describe("Repo-relative path to check, e.g. 'plugins/my_plugin/main.js'."),
    },
    async ({ file }) => {
      const abs = path.join(config.repoPath, file);
      if (!fileExists(abs)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${file}` }],
        };
      }

      const hits = checkDeprecatedApis(config.repoPath, file);

      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No deprecated 2.x APIs found in \`${file}\`. File appears compatible with Lampa 3.0 Maker architecture.`,
            },
          ],
        };
      }

      const rows = hits.map(
        (h) =>
          `- **Line ${h.line}** — \`${h.api}\`\n  \`${h.text}\`\n  → Replace with: \`${h.replacement}\``
      );

      const upgradePath = path.join(config.repoPath, "UPGRADE.md");
      const upgradeExists = fileExists(upgradePath);

      const out = [
        `# Migration Check: ${file}`,
        ``,
        `Found **${hits.length}** deprecated API usage(s):`,
        ``,
        ...rows,
        ``,
        upgradeExists
          ? `See \`UPGRADE.md\` in the repo for full migration examples.`
          : `UPGRADE.md not found in repo.`,
        ``,
        `**Version gate:** \`if (Lampa.Manifest.app_digital >= 300) { /* use Maker */ }\``,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );
}
