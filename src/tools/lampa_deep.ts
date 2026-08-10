import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename, joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists } from "../utils/fs.js";
import { searchCode, type SearchMatch } from "../utils/search.js";
import {
  extractLampaApiUsage,
  extractEvents,
  extractProviderInfo,
  parseLangFile,
  analyseComponentFile,
} from "../utils/lampa_deep.js";

export function registerLampaDeepTools(server: McpServer, config: Config): void {
  // ── plugin_deep_dive ───────────────────────────────────────────────────────
  server.registerTool(
    "plugin_deep_dive",
    {
      description:
        "Comprehensive single-call analysis of a Lampa plugin folder: all files, Lampa API usage, event hooks (follow/send), settings registrations, CSS, and entry-point preview. Replaces 6–10 individual tool calls.",
      inputSchema: {
        plugin: z
          .string()
          .describe(
            "Plugin folder name inside plugins/, e.g. 'online', 'iptv', 'collections', 'shots', 'online_prestige', 'dlna'."
          ),
      },
    },
    async ({ plugin }) => {
      const pluginDir = joinRepo("plugins", plugin);

      if (!(await fileExists(config.fs, pluginDir))) {
        const available = (await fileExists(config.fs, "plugins"))
          ? (await config.fs.listDir("plugins"))
              .filter((e) => e.type === "dir")
              .map((e) => e.name)
              .join(", ")
          : "plugins/ directory not found";
        return {
          content: [
            {
              type: "text" as const,
              text: `Plugin "${plugin}" not found.\nAvailable plugins: ${available}`,
            },
          ],
        };
      }

      const allFiles = await listFilesRecursive(config.fs, pluginDir, []);
      const jsFiles = allFiles.filter((f) => f.endsWith(".js"));
      const cssFiles = allFiles.filter((f) => f.endsWith(".css") || f.endsWith(".scss"));

      const lampaApis = await extractLampaApiUsage(config.fs, pluginDir);
      const { follows, sends } = await extractEvents(config.fs, pluginDir);

      const settingsHits = (await searchCode(config.fs, "Lampa.Settings.add", ["*.js"], false))
        .filter((m) => m.file.startsWith(`plugins/${plugin}/`))
        .map((m) => `  ${m.file}:${m.line}  ${m.text.trim()}`);

      const entryPoint =
        jsFiles.find((f) => basename(f) === "main.js") ??
        jsFiles.find((f) => basename(f) === `${plugin}.js`) ??
        jsFiles[0] ??
        null;

      let entryPreview = "";
      if (entryPoint) {
        const content = (await readFileSafe(config.fs, entryPoint)) ?? "";
        entryPreview = content.split("\n").slice(0, 30).join("\n");
      }

      const apiBlock =
        Object.entries(lampaApis).length > 0
          ? Object.entries(lampaApis)
              .sort(([, a], [, b]) => b.length - a.length)
              .map(
                ([api, files]) =>
                  `- **Lampa.${api}** (${files.length} file${files.length > 1 ? "s" : ""})`
              )
              .join("\n")
          : "No Lampa.* API calls detected.";

      const followBlock =
        Object.keys(follows).length > 0
          ? Object.entries(follows)
              .map(([evt, files]) => `- \`${evt}\`  ← ${files.join(", ")}`)
              .join("\n")
          : "None.";

      const sendBlock =
        Object.keys(sends).length > 0
          ? Object.entries(sends)
              .map(([evt, files]) => `- \`${evt}\`  → ${files.join(", ")}`)
              .join("\n")
          : "None.";

      const out = [
        `# Plugin deep-dive: **${plugin}**`,
        `**Path:** plugins/${plugin}  |  **JS files:** ${jsFiles.length}  |  **CSS files:** ${cssFiles.length}`,
        ``,
        `## File structure (${allFiles.length} total)`,
        allFiles.map((f) => `- ${f}`).join("\n"),
        ``,
        `## Lampa API usage`,
        apiBlock,
        ``,
        `## Event hooks`,
        `### Listens to (follow)`,
        followBlock,
        `### Emits (send)`,
        sendBlock,
        ``,
        `## Settings registrations`,
        settingsHits.length > 0 ? settingsHits.join("\n") : "None.",
        ``,
        `## Entry point: ${entryPoint ?? "not found"}`,
        entryPoint ? `\`\`\`javascript\n${entryPreview}\n\`\`\`` : "No entry point file found.",
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── list_streaming_providers ───────────────────────────────────────────────
  server.registerTool(
    "list_streaming_providers",
    {
      description:
        "List all online streaming content providers bundled with Lampa (plugins/online/*.js and plugins/online_prestige/balansers/*.js). Shows base URL, public methods, and Lampa APIs each provider uses.",
      inputSchema: {},
    },
    async () => {
      const dirs = ["plugins/online", "plugins/online_prestige/balansers"];

      const providerFiles: string[] = [];
      for (const dir of dirs) {
        if (!(await fileExists(config.fs, dir))) continue;
        const entries = await config.fs.listDir(dir);
        for (const e of entries) {
          if (
            e.type === "file" &&
            e.name.endsWith(".js") &&
            !e.name.startsWith("component") &&
            !e.name.startsWith("online")
          ) {
            providerFiles.push(joinRepo(dir, e.name));
          }
        }
      }

      if (providerFiles.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No streaming providers found in plugins/online/ or plugins/online_prestige/balansers/.",
            },
          ],
        };
      }

      const providers = [];
      for (const f of providerFiles) {
        providers.push(await extractProviderInfo(config.fs, f));
      }

      const sections = providers.map((p) => {
        return [
          `## ${p.name}`,
          `**File:** ${p.path}`,
          `**Base URL:** ${p.baseUrl ?? "*(not found — may use proxy or dynamic URL)*"}`,
          `**Public methods:** ${p.methods.length > 0 ? p.methods.join(", ") : "none detected"}`,
          `**Lampa APIs:** ${p.lampaApis.length > 0 ? p.lampaApis.join(", ") : "none"}`,
        ].join("\n");
      });

      const scannedDirs: string[] = [];
      for (const d of dirs) {
        if (await fileExists(config.fs, d)) scannedDirs.push(`- ${d}`);
      }

      const out = [
        `# Lampa Streaming Providers (${providers.length})`,
        ``,
        sections.join("\n\n"),
        ``,
        `---`,
        `**Provider directories scanned:**`,
        scannedDirs.join("\n"),
        ``,
        `> Use \`plugin_deep_dive\` with plugin name \`online\` or \`online_prestige\` for full source analysis.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── translation_coverage ───────────────────────────────────────────────────
  server.registerTool(
    "translation_coverage",
    {
      description:
        "Compare all Lampa language files against the English reference. Shows coverage percentage and lists missing/extra keys per language. Helps identify untranslated strings before shipping.",
      inputSchema: {
        show_missing: z
          .boolean()
          .optional()
          .describe("Include the list of missing keys for each language. Default: true."),
      },
    },
    async ({ show_missing = true }) => {
      const langDir = (await fileExists(config.fs, "src/lang"))
        ? "src/lang"
        : (await fileExists(config.fs, "public/lang"))
          ? "public/lang"
          : null;

      if (!langDir) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No language directory found (checked src/lang/ and public/lang/).",
            },
          ],
        };
      }

      const langFiles = (await config.fs.listDir(langDir))
        .filter((e) => e.type === "file" && e.name.endsWith(".js") && e.name !== "meta.js")
        .map((e) => e.name)
        .sort();

      const enFile = joinRepo(langDir, "en.js");
      if (!(await fileExists(config.fs, enFile))) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Reference file en.js not found in ${langDir}.`,
            },
          ],
        };
      }

      const enKeys = await parseLangFile(config.fs, enFile);
      const enCount = enKeys.length;

      const rows: string[] = [
        `# Translation Coverage`,
        `**Directory:** ${langDir}`,
        `**Reference:** en.js (${enCount} keys)`,
        ``,
        `| Lang | File | Keys | Coverage | Missing |`,
        `|------|------|------|----------|---------|`,
      ];

      const details: string[] = [];

      for (const file of langFiles) {
        const langPath = joinRepo(langDir, file);
        const keys = await parseLangFile(config.fs, langPath);
        const missingKeys = enKeys.filter((k) => !keys.includes(k));
        const extraKeys = keys.filter((k) => !enKeys.includes(k));
        const covered = enCount - missingKeys.length;
        const pct = enCount > 0 ? Math.round((covered / enCount) * 100) : 0;
        const icon = pct === 100 ? "✅" : pct >= 90 ? "🟡" : "🔴";
        const lang = file.replace(".js", "");

        rows.push(
          `| ${lang} | ${file} | ${keys.length} | ${icon} ${pct}% | ${missingKeys.length} |`
        );

        if (show_missing) {
          if (missingKeys.length > 0) {
            details.push(
              `\n### ${lang} — ${missingKeys.length} missing key(s)`,
              missingKeys.join(", ")
            );
          }
          if (extraKeys.length > 0) {
            details.push(
              `### ${lang} — ${extraKeys.length} extra key(s) (not in en.js)`,
              extraKeys.join(", ")
            );
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [...rows, ...details].join("\n"),
          },
        ],
      };
    }
  );

  // ── trace_event ────────────────────────────────────────────────────────────
  server.registerTool(
    "trace_event",
    {
      description:
        "Trace a Lampa event through the entire codebase. Shows every file that emits it (Lampa.Listener.send) and every file that listens to it (Lampa.Listener.follow). Essential for understanding the event bus.",
      inputSchema: {
        event: z
          .string()
          .describe(
            "Lampa event name, e.g. 'app', 'full', 'player', 'catalog', 'torrent_file', 'shots_status', 'state:changed'."
          ),
      },
    },
    async ({ event }) => {
      const patterns = [
        `Lampa.Listener.follow('${event}'`,
        `Lampa.Listener.follow("${event}"`,
        `Lampa.Listener.send('${event}'`,
        `Lampa.Listener.send("${event}"`,
        `.listener.follow('${event}'`,
        `.listener.follow("${event}"`,
        `.listener.send('${event}'`,
        `.listener.send("${event}"`,
      ];

      const allFollows: SearchMatch[] = [];
      const allSends: SearchMatch[] = [];

      for (const pat of patterns) {
        const hits = await searchCode(config.fs, pat, ["*.js"], false);
        const isSend = pat.includes(".send(");
        if (isSend) allSends.push(...hits);
        else allFollows.push(...hits);
      }

      const dedup = (arr: SearchMatch[]) => {
        const seen = new Set<string>();
        return arr.filter((m) => {
          const key = `${m.file}:${m.line}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const follows = dedup(allFollows);
      const sends = dedup(allSends);

      const followBlock =
        follows.length > 0
          ? follows
              .map((m) => `- **${m.file}** line ${m.line}  \`${m.text.trim().slice(0, 120)}\``)
              .join("\n")
          : "No listeners found.";

      const sendBlock =
        sends.length > 0
          ? sends
              .map((m) => `- **${m.file}** line ${m.line}  \`${m.text.trim().slice(0, 120)}\``)
              .join("\n")
          : "No emitters found.";

      const notFound =
        follows.length === 0 && sends.length === 0
          ? `\n> ⚠ Event \`${event}\` not found in the codebase.\n> Common events: \`app\`, \`full\`, \`player\`, \`catalog\`, \`settings\`, \`torrent\`, \`torrent_file\`, \`shots_status\`, \`shots_update\`, \`state:changed\``
          : "";

      const out = [
        `# Event trace: \`${event}\``,
        ``,
        `## Files that LISTEN to \`${event}\` — Lampa.Listener.follow (${follows.length})`,
        followBlock,
        ``,
        `## Files that EMIT \`${event}\` — Lampa.Listener.send (${sends.length})`,
        sendBlock,
        notFound,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── lampa_api_surface ──────────────────────────────────────────────────────
  server.registerTool(
    "lampa_api_surface",
    {
      description:
        "Extract the complete Lampa.* global API surface from the source code. Lists every module (Lampa.Storage, Lampa.Player, etc.) with its sub-methods and file usage count. The definitive reference for plugin development.",
      inputSchema: {
        module: z
          .string()
          .optional()
          .describe(
            "Filter to a specific module, e.g. 'Storage', 'Player', 'Settings', 'Lang'. Omit for the full map."
          ),
        scope: z
          .enum(["all", "plugins", "src"])
          .optional()
          .describe("Limit search scope. Default: 'all'."),
      },
    },
    async ({ module: mod, scope = "all" }) => {
      const searchRoot = scope === "plugins" ? "plugins" : scope === "src" ? "src" : "";

      const jsFiles = await listFilesRecursive(config.fs, searchRoot, [".js"]);

      const map: Record<string, { methods: Set<string>; files: Set<string> }> = {};

      for (const file of jsFiles) {
        const content = await readFileSafe(config.fs, file);
        if (!content) continue;

        const pat = /Lampa\.([A-Z][a-zA-Z]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?/g;
        let m: RegExpExecArray | null;
        while ((m = pat.exec(content)) !== null) {
          const modName = m[1];
          const method = m[2] ?? "";
          if (mod && modName.toLowerCase() !== mod.toLowerCase()) continue;
          if (!map[modName]) map[modName] = { methods: new Set(), files: new Set() };
          if (method) map[modName].methods.add(method);
          map[modName].files.add(file);
        }
      }

      if (Object.keys(map).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: mod
                ? `No usage of Lampa.${mod} found in scope "${scope}".`
                : `No Lampa.* usage found in scope "${scope}".`,
            },
          ],
        };
      }

      const sorted = Object.entries(map).sort(([, a], [, b]) => b.files.size - a.files.size);

      const header = mod
        ? `# Lampa.${mod} API Surface (scope: ${scope})`
        : `# Lampa Global API Surface (scope: ${scope}, ${sorted.length} modules)`;

      const sections = sorted.map(([modName, { methods, files }]) => {
        const methodList =
          methods.size > 0
            ? `  Methods: \`${[...methods].sort().join("`, `")}\``
            : "  *(called directly, no sub-method detected)*";
        return [
          `## Lampa.${modName}  *(${files.size} file${files.size > 1 ? "s" : ""})*`,
          methodList,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [header, "", ...sections].join("\n"),
          },
        ],
      };
    }
  );

  // ── list_templates ─────────────────────────────────────────────────────────
  server.registerTool(
    "list_templates",
    {
      description:
        "List all Lampa UI templates in src/templates/. Optionally read a specific template's source to understand its HTML structure and data bindings.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(
            "Template name or partial name to read, e.g. 'card', 'modal', 'player', 'settings'. Omit to list all templates."
          ),
      },
    },
    async ({ name }) => {
      const templatesDir = "src/templates";
      if (!(await fileExists(config.fs, templatesDir))) {
        return {
          content: [
            {
              type: "text" as const,
              text: "src/templates/ directory not found in the repository.",
            },
          ],
        };
      }

      const allFiles = await listFilesRecursive(config.fs, templatesDir, [".js"]);

      if (!name) {
        const grouped: Record<string, string[]> = {};
        for (const rel of allFiles) {
          const parts = rel.split("/");
          const group = parts.length > 2 ? parts[2] : "root";
          if (!grouped[group]) grouped[group] = [];
          grouped[group].push(rel);
        }

        const lines = Object.entries(grouped)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, files]) => `### ${group}\n${files.map((f) => `- ${f}`).join("\n")}`)
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `# Lampa UI Templates (${allFiles.length} files)\n\n${lines}\n\nUse the \`name\` parameter to read a specific template.`,
            },
          ],
        };
      }

      const lower = name.toLowerCase();
      const matches = allFiles.filter((f) => basename(f).toLowerCase().includes(lower));

      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No template matching "${name}" in src/templates/.\nUse list_templates (no name) to see all available templates.`,
            },
          ],
        };
      }

      const results = [];
      for (const file of matches.slice(0, 4)) {
        const content = (await readFileSafe(config.fs, file)) ?? "";
        const preview =
          content.length > 2500 ? content.slice(0, 2500) + "\n// …(truncated)" : content;
        results.push(`## ${file}\n\`\`\`javascript\n${preview}\n\`\`\``);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: results.join("\n\n"),
          },
        ],
      };
    }
  );

  // ── generate_plugin_boilerplate ────────────────────────────────────────────
  server.registerTool(
    "generate_plugin_boilerplate",
    {
      description:
        "Generate a ready-to-use Lampa plugin boilerplate based on real patterns from existing plugins. Select the features you need and get working code instantly.",
      inputSchema: {
        plugin_name: z.string().describe("Plugin folder/id in snake_case, e.g. 'my_plugin'."),
        display_name: z
          .string()
          .describe("Human-readable name shown in the Lampa UI, e.g. 'My Plugin'."),
        features: z
          .array(
            z.enum([
              "settings",
              "full_card_hook",
              "player_hook",
              "catalog_hook",
              "storage",
              "lang_keys",
              "iptv",
            ])
          )
          .optional()
          .describe(
            "Features to include. Defaults to [settings, full_card_hook]. Options: settings | full_card_hook | player_hook | catalog_hook | storage | lang_keys | iptv."
          ),
      },
    },
    async ({ plugin_name, display_name, features = ["settings", "full_card_hook"] }) => {
      const L: string[] = [];

      L.push(
        `// plugins/${plugin_name}/main.js`,
        `// Lampa plugin — generated boilerplate`,
        `(function () {`,
        `    'use strict';`,
        ``
      );

      if (features.includes("lang_keys")) {
        L.push(
          `    // ── Translations ─────────────────────────────────────────────────────────`,
          `    var LANG = {`,
          `        ru: {`,
          `            ${plugin_name}_title:    '${display_name}',`,
          `            ${plugin_name}_settings: 'Настройки ${display_name}',`,
          `            ${plugin_name}_enabled:  'Включено',`,
          `        },`,
          `        en: {`,
          `            ${plugin_name}_title:    '${display_name}',`,
          `            ${plugin_name}_settings: '${display_name} settings',`,
          `            ${plugin_name}_enabled:  'Enabled',`,
          `        },`,
          `    };`,
          ``
        );
      }

      L.push(
        `    // ── State ─────────────────────────────────────────────────────────────────`,
        `    var initialized = false;`,
        ``
      );

      if (features.includes("settings")) {
        L.push(
          `    // ── Settings component ────────────────────────────────────────────────────`,
          `    function SettingsComponent() {`,
          `        var html = Lampa.Template.get('${plugin_name}_settings', {});`,
          ``,
          `        this.create = function () { return html; };`,
          `        this.destroy = function () { html.remove(); };`,
          `    }`,
          ``
        );
      }

      L.push(
        `    // ── Init ──────────────────────────────────────────────────────────────────`,
        `    function init() {`,
        `        if (initialized) return;`,
        `        initialized = true;`,
        ``
      );

      if (features.includes("lang_keys")) {
        L.push(
          `        // Register translations for all languages`,
          `        Object.keys(LANG).forEach(function (code) {`,
          `            Lampa.Lang.add(code, LANG[code]);`,
          `        });`,
          ``
        );
      }

      if (features.includes("settings")) {
        L.push(
          `        // Register settings section`,
          `        Lampa.Settings.add('${plugin_name}', {`,
          `            component: '${plugin_name}',`,
          `            name: '${display_name}',`,
          `            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'`,
          `        });`,
          ``
        );
      }

      if (features.includes("full_card_hook")) {
        L.push(
          `        // Hook: full card view (movie/show detail page)`,
          `        Lampa.Listener.follow('full', function (e) {`,
          `            if (e.type !== 'complite') return;`,
          ``,
          `            // e.object.movie  — TMDB movie/show object`,
          `            // e.object.activity — current Activity`,
          `            var movie = e.object.movie;`,
          `            var isEnabled = Lampa.Storage.get('${plugin_name}_enabled', false);`,
          `            if (!isEnabled) return;`,
          ``,
          `            // Example: append a button to the full card`,
          `            // var btn = $('<div class="full__button selector">${display_name}</div>');`,
          `            // btn.on('hover:enter', function () { /* action */ });`,
          `            // e.object.activity.view.find('.full__buttons').append(btn);`,
          `        });`,
          ``
        );
      }

      if (features.includes("player_hook")) {
        L.push(
          `        // Hook: video player lifecycle`,
          `        Lampa.Listener.follow('player', function (e) {`,
          `            if (e.type === 'start') {`,
          `                // Player started, e.object — player instance`,
          `            } else if (e.type === 'end') {`,
          `                // Playback ended`,
          `            } else if (e.type === 'destroy') {`,
          `                // Player destroyed — clean up any injected UI`,
          `            }`,
          `        });`,
          ``
        );
      }

      if (features.includes("catalog_hook")) {
        L.push(
          `        // Hook: catalog / content feed`,
          `        Lampa.Listener.follow('catalog', function (e) {`,
          `            if (e.type === 'complite') {`,
          `                // e.object — catalog component`,
          `            }`,
          `        });`,
          ``
        );
      }

      if (features.includes("iptv")) {
        L.push(
          `        // Hook: IPTV integration`,
          `        Lampa.Listener.follow('app', function (e) {`,
          `            if (e.type !== 'ready') return;`,
          `            if (!Lampa.PlayerIPTV) return; // IPTV not available`,
          ``,
          `            // Lampa.PlayerIPTV — IPTV player instance`,
          `            // Use Lampa.Storage to persist channel lists:`,
          `            // Lampa.Storage.get('${plugin_name}_channels', []);`,
          `        });`,
          ``
        );
      }

      if (features.includes("storage")) {
        L.push(
          `        // Storage helpers (example keys — rename as needed)`,
          `        // Read:   var val = Lampa.Storage.get('${plugin_name}_key', defaultValue);`,
          `        // Write:  Lampa.Storage.set('${plugin_name}_key', value);`,
          `        // Watch:  Lampa.Storage.listener.follow('change', fn);`,
          ``
        );
      }

      if (
        !features.includes("full_card_hook") &&
        !features.includes("player_hook") &&
        !features.includes("catalog_hook") &&
        !features.includes("iptv")
      ) {
        L.push(`        // TODO: add your plugin logic here`, ``);
      }

      L.push(
        `    }`,
        ``,
        `    // ── Bootstrap ─────────────────────────────────────────────────────────────`,
        `    // Works whether the plugin loads before or after the app is ready`,
        `    if (window.appready) init();`,
        `    else $(document).on('appready', init);`,
        ``,
        `})();`
      );

      const boilerplate = L.join("\n");

      const nextSteps = [
        `1. Create folder \`plugins/${plugin_name}/\` in the repo`,
        `2. Save the code as \`plugins/${plugin_name}/main.js\``,
        features.includes("settings")
          ? `3. Add a settings HTML template as \`plugins/${plugin_name}/template.html\` or via Lampa.Template.add()`
          : null,
        features.includes("lang_keys")
          ? `4. Add more keys to the LANG object; use \`find_translation_keys\` to see existing key patterns`
          : null,
        `5. Load the plugin by adding its URL in Lampa → Settings → Plugins`,
        `6. Test with \`run_grep_checks\` after implementing`,
      ]
        .filter(Boolean)
        .join("\n");

      const out = [
        `# Plugin Boilerplate: **${display_name}** (\`${plugin_name}\`)`,
        `**Features:** ${features.join(", ")}`,
        ``,
        `## plugins/${plugin_name}/main.js`,
        `\`\`\`javascript`,
        boilerplate,
        `\`\`\``,
        ``,
        `## Next steps`,
        nextSteps,
        ``,
        `> Patterns sourced from: plugins/collections/collections.js, plugins/iptv/iptv.js, plugins/online/online.js`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── component_lifecycle ────────────────────────────────────────────────────
  server.registerTool(
    "component_lifecycle",
    {
      description:
        "Deep-analyse a Lampa component's lifecycle: lifecycle methods (create/render/destroy), event hooks, Lampa APIs used, storage reads/writes, template usages, and settings interactions — all in one call.",
      inputSchema: {
        component: z
          .string()
          .describe(
            "Component name (e.g. 'episodes', 'bookmarks', 'full') or repo-relative file path (e.g. 'src/components/episodes.js')."
          ),
      },
    },
    async ({ component }) => {
      let targetFile: string | null = null;

      if (component.includes("/") || component.endsWith(".js")) {
        if (await fileExists(config.fs, component)) targetFile = component;
      }

      if (!targetFile) {
        const searchDirs = ["src/components", "src/interaction", "plugins"];
        const lower = component.toLowerCase().replace(/\.js$/, "");
        for (const dir of searchDirs) {
          if (!(await fileExists(config.fs, dir))) continue;
          const files = await listFilesRecursive(config.fs, dir, [".js"]);
          const match = files.find((f) => basename(f, ".js").toLowerCase() === lower);
          if (match) {
            targetFile = match;
            break;
          }
        }
      }

      if (!targetFile) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Component "${component}" not found.`,
                `Try a repo-relative path like 'src/components/episodes.js',`,
                `or use list_modules with subfolder 'src/components' to browse available components.`,
              ].join("\n"),
            },
          ],
        };
      }

      const summary = await analyseComponentFile(config.fs, targetFile);

      const lifecycleBlock =
        Object.entries(summary.methods)
          .filter(([, lns]) => lns.length > 0)
          .map(
            ([name, lns]) => `- **${name}** → line${lns.length > 1 ? "s" : ""} ${lns.join(", ")}`
          )
          .join("\n") || "No standard lifecycle methods detected.";

      const followBlock =
        Object.keys(summary.events.follows).length > 0
          ? Object.keys(summary.events.follows)
              .map((e) => `- follows \`${e}\``)
              .join("\n")
          : "None.";

      const sendBlock =
        Object.keys(summary.events.sends).length > 0
          ? Object.keys(summary.events.sends)
              .map((e) => `- sends \`${e}\``)
              .join("\n")
          : "None.";

      const fmtHits = (arr: Array<{ line: number; text: string }>) =>
        arr.length > 0
          ? arr.map((h) => `  line ${h.line}: \`${h.text.slice(0, 120)}\``).join("\n")
          : "None.";

      const out = [
        `# Component lifecycle: ${summary.file}`,
        `**Lines:** ${summary.lineCount}`,
        ``,
        `## Lifecycle methods`,
        lifecycleBlock,
        ``,
        `## Event hooks`,
        `### Listens to (follow)`,
        followBlock,
        `### Emits (send)`,
        sendBlock,
        ``,
        `## Lampa APIs used (${summary.lampaApis.length})`,
        summary.lampaApis.length > 0
          ? summary.lampaApis.map((a) => `- Lampa.${a}`).join("\n")
          : "None.",
        ``,
        `## Storage reads (${summary.storageReads.length})`,
        fmtHits(summary.storageReads),
        ``,
        `## Storage writes (${summary.storageWrites.length})`,
        fmtHits(summary.storageWrites),
        ``,
        `## Template usages (${summary.templateUsages.length})`,
        fmtHits(summary.templateUsages),
        ``,
        `## Settings usages (${summary.settingsUsages.length})`,
        fmtHits(summary.settingsUsages),
        ``,
        `## Source preview (first 35 lines)`,
        `\`\`\`javascript`,
        summary.preview,
        `\`\`\``,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );
}
