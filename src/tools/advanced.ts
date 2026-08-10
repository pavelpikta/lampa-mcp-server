import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename, joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { formatTemplates } from "../utils/lampa_deep.js";

function indexText(indexed: unknown): string {
  if (typeof indexed === "string") return indexed;
  if (indexed && typeof indexed === "object" && "hits" in indexed) {
    const hits = (
      indexed as {
        hits: {
          file: string;
          key?: string;
          event?: string;
          op?: string;
          bus?: string;
          text?: string;
          line?: number;
        }[];
        note?: string;
      }
    ).hits;
    const note = (indexed as { note?: string }).note;
    const lines = hits.slice(0, 300).map((h) => {
      const label = h.key ?? h.event ?? h.text ?? "";
      const meta = [h.op, h.bus].filter(Boolean).join("/");
      return `${h.file}${h.line ? `:${h.line}` : ""}${meta ? ` [${meta}]` : ""}  ${label}`;
    });
    return [note ? `# ${note}` : null, ...lines].filter(Boolean).join("\n");
  }
  return JSON.stringify(indexed, null, 2);
}

function isR2Backend(config: Config): boolean {
  return config.label.startsWith("r2://");
}

export function registerAdvancedTools(server: McpServer, config: Config): void {
  // ── read_file ──────────────────────────────────────────────────────────────
  server.registerTool(
    "read_file",
    {
      description:
        "Read the complete contents of any file in the Lampa repo. Files larger than max_lines are truncated — use read_file_segment to read specific sections of large files.",
      inputSchema: {
        file: z
          .string()
          .describe(
            "Repo-relative path, e.g. 'plugins/iptv/iptv.js', 'src/core/lang.js', 'gulpfile.js'."
          ),
        max_lines: z.number().optional().describe("Maximum lines to return. Default: 300."),
      },
    },
    async ({ file, max_lines = 300 }) => {
      if (!(await fileExists(config.fs, file))) {
        return {
          content: [
            {
              type: "text" as const,
              text: `File not found: ${file}\nUse find_files or list_modules to locate the correct path.`,
            },
          ],
        };
      }

      const content = (await readFileSafe(config.fs, file)) ?? "";
      const lines = content.split("\n");
      const total = lines.length;
      const truncated = total > max_lines;
      const shown = truncated ? lines.slice(0, max_lines).join("\n") : content;

      const base = basename(file);
      const dot = base.lastIndexOf(".");
      const ext = dot >= 0 ? base.slice(dot + 1) : "text";
      const lang = ext === "ts" ? "typescript" : ext === "js" ? "javascript" : ext;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `// ${file}  (${total} lines${truncated ? `, first ${max_lines} shown` : ""})`,
              `\`\`\`${lang}`,
              shown,
              truncated
                ? `\n// … ${total - max_lines} more lines omitted.\n// Use read_file_segment with start_line=${max_lines + 1} to continue.`
                : "",
              "```",
            ]
              .filter((l) => l !== "")
              .join("\n"),
          },
        ],
      };
    }
  );

  // ── get_storage_schema ─────────────────────────────────────────────────────
  server.registerTool(
    "get_storage_schema",
    {
      description:
        "Extract all Lampa.Storage keys used across the codebase. Builds a complete map of the user-persistence model: key names, default values, which files read and write each key.",
      inputSchema: {
        scope: z
          .enum(["all", "plugins", "src"])
          .optional()
          .describe("Limit the search scope. Default: 'all'."),
        key: z.string().optional().describe("Filter to a single storage key, e.g. 'filmix_token'."),
      },
    },
    async ({ scope = "all", key }) => {
      const indexed = await config.fs.readIndex?.("storage-schema");
      if (indexed != null && scope === "all" && !key) {
        return { content: [{ type: "text" as const, text: indexText(indexed) }] };
      }

      if (indexed == null && isR2Backend(config) && scope === "all" && !key) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `# Storage schema index missing`,
                ``,
                `Full-tree Storage scans are disabled on R2 backends without a prebuilt index.`,
                ``,
                `Narrow the query:`,
                `- Pass \`scope: "src"\` or \`scope: "plugins"\``,
                `- Or pass \`key: "<storage_key>"\` to look up one key`,
                ``,
                `Or rebuild indexes (snapshot upload) so \`indexes/storage-schema\` is available.`,
              ].join("\n"),
            },
          ],
        };
      }

      const searchRoot = scope === "plugins" ? "plugins" : scope === "src" ? "src" : "";
      const jsFiles = await listFilesRecursive(config.fs, searchRoot, [".js"]);

      const schema: Record<
        string,
        { defaults: Set<string>; readers: string[]; writers: string[] }
      > = {};

      for (const file of jsFiles) {
        const content = await readFileSafe(config.fs, file);
        if (!content) continue;

        const getPat = /Lampa\.Storage\.get\(['"]([^'"]{1,60})['"](?:\s*,\s*([^)]{0,60}))?\)/g;
        let m: RegExpExecArray | null;
        while ((m = getPat.exec(content)) !== null) {
          const k = m[1];
          const def = (m[2] ?? "").trim().slice(0, 40);
          if (key && k !== key) continue;
          if (!schema[k]) schema[k] = { defaults: new Set(), readers: [], writers: [] };
          if (def) schema[k].defaults.add(def);
          if (!schema[k].readers.includes(file)) schema[k].readers.push(file);
        }

        const setPat = /Lampa\.Storage\.set\(['"]([^'"]{1,60})['"]/g;
        while ((m = setPat.exec(content)) !== null) {
          const k = m[1];
          if (key && k !== key) continue;
          if (!schema[k]) schema[k] = { defaults: new Set(), readers: [], writers: [] };
          if (!schema[k].writers.includes(file)) schema[k].writers.push(file);
        }
      }

      const entries = Object.entries(schema).sort(([a], [b]) => a.localeCompare(b));

      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: key
                ? `Storage key '${key}' not found in scope '${scope}'.`
                : `No Lampa.Storage usage found in scope '${scope}'.`,
            },
          ],
        };
      }

      const rows = [
        `# Lampa Storage Schema  (scope: ${scope}, ${entries.length} unique key${entries.length > 1 ? "s" : ""})`,
        ``,
        `| Key | Default(s) | Readers | Writers |`,
        `|-----|-----------|---------|---------|`,
        ...entries.map(([k, { defaults, readers, writers }]) => {
          const defs = [...defaults].slice(0, 2).join(" / ") || "—";
          return `| \`${k}\` | \`${defs}\` | ${readers.length} | ${writers.length} |`;
        }),
      ];

      if (key && entries.length === 1) {
        const [k, { defaults, readers, writers }] = entries[0];
        rows.push(
          ``,
          `## \`${k}\` — full detail`,
          `**All defaults:** ${[...defaults].join(", ") || "none observed"}`,
          `**Readers (${readers.length}):**`,
          readers.map((r) => `- ${r}`).join("\n") || "none",
          `**Writers (${writers.length}):**`,
          writers.map((w) => `- ${w}`).join("\n") || "none"
        );
      }

      return { content: [{ type: "text" as const, text: rows.join("\n") }] };
    }
  );

  // ── list_all_events ────────────────────────────────────────────────────────
  server.registerTool(
    "list_all_events",
    {
      description:
        "Build a complete map of the Lampa.Listener event bus. Lists every event name, how many files listen to it, and how many files emit it — across the entire codebase.",
      inputSchema: {
        scope: z
          .enum(["all", "plugins", "src"])
          .optional()
          .describe("Scope to search. Default: 'all'."),
        detail: z
          .boolean()
          .optional()
          .describe("Include per-file details for each event. Default: false."),
      },
    },
    async ({ scope = "all", detail = false }) => {
      const indexed = await config.fs.readIndex?.("events");
      if (indexed != null && scope === "all" && !detail) {
        return { content: [{ type: "text" as const, text: indexText(indexed) }] };
      }

      if (indexed == null && isR2Backend(config) && scope === "all") {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `# Events index missing`,
                ``,
                `Full-tree event scans are disabled on R2 backends without a prebuilt index.`,
                ``,
                `Narrow the query:`,
                `- Pass \`scope: "src"\` or \`scope: "plugins"\``,
                ``,
                `Or rebuild indexes (snapshot upload) so \`indexes/events\` is available.`,
                `For a single event, prefer \`trace_event\`.`,
              ].join("\n"),
            },
          ],
        };
      }

      const searchRoot = scope === "plugins" ? "plugins" : scope === "src" ? "src" : "";
      const jsFiles = await listFilesRecursive(config.fs, searchRoot, [".js"]);

      const events: Record<string, { listeners: string[]; emitters: string[] }> = {};

      for (const file of jsFiles) {
        const content = await readFileSafe(config.fs, file);
        if (!content) continue;

        const followPat = /Lampa\.Listener\.follow\(['"]([\w:.-]+)['"]/g;
        const sendPat = /Lampa\.Listener\.send\(['"]([\w:.-]+)['"]/g;
        let m: RegExpExecArray | null;

        while ((m = followPat.exec(content)) !== null) {
          const evt = m[1];
          if (!events[evt]) events[evt] = { listeners: [], emitters: [] };
          if (!events[evt].listeners.includes(file)) events[evt].listeners.push(file);
        }
        while ((m = sendPat.exec(content)) !== null) {
          const evt = m[1];
          if (!events[evt]) events[evt] = { listeners: [], emitters: [] };
          if (!events[evt].emitters.includes(file)) events[evt].emitters.push(file);
        }
      }

      const sorted = Object.entries(events).sort(([, a], [, b]) => {
        const ta = a.listeners.length + a.emitters.length;
        const tb = b.listeners.length + b.emitters.length;
        return tb - ta;
      });

      const rows = [
        `# Lampa Event Bus  (scope: ${scope}, ${sorted.length} distinct event${sorted.length > 1 ? "s" : ""})`,
        ``,
        `| Event | Listeners | Emitters | Status |`,
        `|-------|-----------|---------|--------|`,
        ...sorted.map(([evt, { listeners, emitters }]) => {
          const status =
            emitters.length === 0
              ? "⚠ no emitter found"
              : listeners.length === 0
                ? "⚠ no listener found"
                : "✅";
          return `| \`${evt}\` | ${listeners.length} | ${emitters.length} | ${status} |`;
        }),
      ];

      if (detail) {
        rows.push(``, `---`, `## Per-event details`);
        for (const [evt, { listeners, emitters }] of sorted) {
          rows.push(
            ``,
            `### \`${evt}\``,
            `**Listeners:** ${listeners.length > 0 ? listeners.join(", ") : "none"}`,
            `**Emitters:** ${emitters.length > 0 ? emitters.join(", ") : "none"}`
          );
        }
      }

      return { content: [{ type: "text" as const, text: rows.join("\n") }] };
    }
  );

  // ── get_network_map ────────────────────────────────────────────────────────
  server.registerTool(
    "get_network_map",
    {
      description:
        "Extract all hardcoded URLs, API base URLs, and proxy patterns from the Lampa source. Reveals every external service the app communicates with.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe(
            "Repo-relative subfolder to search, e.g. 'plugins/online', 'plugins/iptv'. Defaults to 'plugins'."
          ),
      },
    },
    async ({ scope }) => {
      const searchRoot = scope ?? "plugins";

      if (!(await fileExists(config.fs, searchRoot))) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Path not found: ${scope}. Check with repo_overview.`,
            },
          ],
        };
      }

      const jsFiles = await listFilesRecursive(config.fs, searchRoot, [".js"]);

      const map: Record<string, { urls: string[]; proxies: string[]; embedVars: string[] }> = {};

      for (const file of jsFiles) {
        const content = await readFileSafe(config.fs, file);
        if (!content) continue;

        const entry = { urls: [] as string[], proxies: [] as string[], embedVars: [] as string[] };

        const urlPat = /['"`](https?:\/\/[^'"`\s\\]{4,120})['"`]/g;
        let m: RegExpExecArray | null;
        while ((m = urlPat.exec(content)) !== null) {
          const url = m[1];
          if (!entry.urls.includes(url)) entry.urls.push(url);
        }

        const proxyPat = /\.proxy\(['"]([^'"]+)['"]\)/g;
        while ((m = proxyPat.exec(content)) !== null) {
          if (!entry.proxies.includes(m[1])) entry.proxies.push(m[1]);
        }

        const embedPat = /(?:let|var|const)\s+embed\s*=\s*['"`]([^'"`]+)['"`]/g;
        while ((m = embedPat.exec(content)) !== null) {
          if (!entry.embedVars.includes(m[1])) entry.embedVars.push(m[1]);
        }

        if (entry.urls.length > 0 || entry.proxies.length > 0 || entry.embedVars.length > 0) {
          map[file] = entry;
        }
      }

      const entries = Object.entries(map);

      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No URLs or network patterns found in: ${scope ?? "plugins"}`,
            },
          ],
        };
      }

      const sections = entries.map(([file, { urls, proxies, embedVars }]) => {
        const lines = [`## ${file}`];
        if (embedVars.length > 0) lines.push(`**Base URL (embed):** \`${embedVars.join("`, `")}\``);
        if (proxies.length > 0) lines.push(`**Proxy names:** \`${proxies.join("`, `")}\``);
        if (urls.length > 0) lines.push(`**Other URLs:**`, ...urls.map((u) => `- \`${u}\``));
        return lines.join("\n");
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# Network Map  (scope: ${scope ?? "plugins"}, ${entries.length} files)`,
              ``,
              ...sections,
            ].join("\n\n"),
          },
        ],
      };
    }
  );

  // ── validate_plugin ────────────────────────────────────────────────────────
  server.registerTool(
    "validate_plugin",
    {
      description:
        "Validate a Lampa plugin against established conventions: IIFE wrapping, strict mode, appready bootstrap, no localhost URLs, proper event cleanup, and more. Returns a scored report with fix guidance.",
      inputSchema: {
        plugin: z
          .string()
          .describe(
            "Plugin folder name (e.g. 'iptv', 'online') or repo-relative path to a plugin JS file."
          ),
      },
    },
    async ({ plugin }) => {
      let targetFile: string | null = null;

      if ((await fileExists(config.fs, plugin)) && plugin.endsWith(".js")) {
        targetFile = plugin;
      } else {
        const pluginDir = joinRepo("plugins", plugin);
        if (await fileExists(config.fs, pluginDir)) {
          const candidates = [joinRepo(pluginDir, "main.js"), joinRepo(pluginDir, `${plugin}.js`)];
          for (const c of candidates) {
            if (await fileExists(config.fs, c)) {
              targetFile = c;
              break;
            }
          }
          if (!targetFile) {
            const jsFiles = await listFilesRecursive(config.fs, pluginDir, [".js"]);
            targetFile = jsFiles[0] ?? null;
          }
        }
      }

      if (!targetFile) {
        const available = (await fileExists(config.fs, "plugins"))
          ? (await config.fs.listDir("plugins"))
              .filter((e) => e.type === "dir")
              .map((e) => e.name)
              .join(", ")
          : "plugins/ not found";
        return {
          content: [
            {
              type: "text" as const,
              text: [`Plugin "${plugin}" not found.`, `Available: ${available}`].join("\n"),
            },
          ],
        };
      }

      const content = (await readFileSafe(config.fs, targetFile)) ?? "";
      const rel = targetFile;
      const lines = content.split("\n");

      const checks: Array<{
        name: string;
        pass: boolean;
        severity: "error" | "warn" | "info";
        fix: string;
      }> = [
        {
          name: "IIFE wrapper `(function() { ... })()`",
          pass: /\(function\s*\(/.test(content),
          severity: "error",
          fix: "Wrap the entire plugin in `(function() { 'use strict'; ... })();` to prevent global scope pollution.",
        },
        {
          name: "`'use strict'` declaration",
          pass: content.includes("'use strict'") || content.includes('"use strict"'),
          severity: "warn",
          fix: "Add `'use strict';` as the first statement inside the IIFE.",
        },
        {
          name: "Bootstraps on `appready`",
          pass: content.includes("appready"),
          severity: "error",
          fix: "Use `if (window.appready) init(); else $(document).on('appready', init);` — never call Lampa APIs before the app is ready.",
        },
        {
          name: "No hardcoded `localhost` URLs",
          pass: !content.includes("localhost"),
          severity: "error",
          fix: "Remove localhost URLs. Use environment-relative paths or a configurable base URL from Lampa.Storage.",
        },
        {
          name: "No `document.write()`",
          pass: !content.includes("document.write"),
          severity: "error",
          fix: "Replace document.write() with Lampa.Template / jQuery DOM manipulation.",
        },
        {
          name: "No `eval()` usage",
          pass: !/\beval\s*\(/.test(content),
          severity: "error",
          fix: "Remove eval(). It triggers CSP violations and is a security risk.",
        },
        {
          name: "Uses `Lampa.Lang` for UI strings",
          pass: content.includes("Lampa.Lang"),
          severity: "warn",
          fix: "Replace hardcoded UI strings with Lampa.Lang.translate('key') for i18n support.",
        },
        {
          name: "Has a named `init()` function",
          pass: /function\s+init\s*\(|var\s+init\s*=\s*function|const\s+init\s*=/.test(content),
          severity: "info",
          fix: "Define a clear `function init()` entry point for readability and testability.",
        },
        {
          name: "Settings icon provided",
          pass: !content.includes("Lampa.Settings.add") || content.includes("icon:"),
          severity: "info",
          fix: "Add an `icon: '<svg>...</svg>'` property to your Lampa.Settings.add() call.",
        },
        {
          name: "Storage keys use plugin prefix",
          pass: (() => {
            const storageKeys: string[] = [];
            const pat = /Lampa\.Storage\.get\(['"]([^'"]+)['"]/g;
            let m: RegExpExecArray | null;
            while ((m = pat.exec(content)) !== null) storageKeys.push(m[1]);
            if (storageKeys.length === 0) return true;
            const pluginBase = basename(rel, ".js").split(/[/_]/)[0];
            return storageKeys.every(
              (k) => k.startsWith(pluginBase) || k.startsWith("video_") || k.startsWith("online_")
            );
          })(),
          severity: "info",
          fix: `Prefix storage keys with the plugin name (e.g. '${plugin}_key') to avoid conflicts with other plugins.`,
        },
      ];

      const errors = checks.filter((c) => !c.pass && c.severity === "error");
      const warns = checks.filter((c) => !c.pass && c.severity === "warn");
      const passed = checks.filter((c) => c.pass);
      const score = Math.round((passed.length / checks.length) * 100);
      const scoreIcon = score === 100 ? "✅" : score >= 70 ? "🟡" : "🔴";

      const out = [
        `# Plugin Validation: ${rel}`,
        `**Score:** ${scoreIcon} ${score}% (${passed.length}/${checks.length} checks passed)`,
        `**Lines:** ${lines.length}`,
        ``,
        `## Results`,
        ...checks.map((c) => {
          const icon = c.pass
            ? "✅"
            : c.severity === "error"
              ? "❌"
              : c.severity === "warn"
                ? "⚠️"
                : "ℹ️";
          return `${icon} **${c.name}**${c.pass ? "" : `\n   → ${c.fix}`}`;
        }),
        errors.length > 0
          ? `\n## Errors to fix (${errors.length})\n${errors.map((c) => `- **${c.name}**: ${c.fix}`).join("\n")}`
          : "",
        warns.length > 0
          ? `\n## Warnings (${warns.length})\n${warns.map((c) => `- **${c.name}**: ${c.fix}`).join("\n")}`
          : "",
      ]
        .filter((l) => l !== "")
        .join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── extract_template_html (alias of list_templates mode=html) ──────────────
  server.registerTool(
    "extract_template_html",
    {
      description:
        "Alias of list_templates mode=html. Extract HTML markup from Lampa template files (src/templates/*.js).",
      inputSchema: {
        name: z
          .string()
          .describe(
            "Template name to find, e.g. 'card', 'modal', 'player', 'settings'. Matches by filename."
          ),
      },
    },
    async ({ name }) => {
      const text = await formatTemplates(config.fs, "html", name);
      return {
        content: [
          {
            type: "text" as const,
            text: `> Prefer \`list_templates\` with mode=html.\n\n${text}`,
          },
        ],
      };
    }
  );

  // ── get_core_module ────────────────────────────────────────────────────────
  server.registerTool(
    "get_core_module",
    {
      description:
        "Read a Lampa core module from src/core/. Core modules implement the fundamental Lampa APIs (storage, lang, player, api, component, etc.). Lists all available modules when no name is given.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(
            "Module name, e.g. 'lang', 'storage', 'player', 'api', 'component'. Omit to list all."
          ),
        max_lines: z.number().optional().describe("Max lines to return. Default: 250."),
      },
    },
    async ({ name, max_lines = 250 }) => {
      const coreDir = "src/core";
      if (!(await fileExists(config.fs, coreDir))) {
        return {
          content: [{ type: "text" as const, text: "src/core/ not found in repository." }],
        };
      }

      if (!name) {
        const entries = (await config.fs.listDir(coreDir)).sort((a, b) =>
          a.name.localeCompare(b.name)
        );
        const dirs = entries.filter((e) => e.type === "dir").map((e) => `📁 ${e.name}/`);
        const files = entries.filter((e) => e.type === "file").map((e) => `📄 ${e.name}`);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `# src/core/  (${entries.length} items)`,
                ``,
                `## Subdirectories`,
                dirs.join("\n") || "none",
                ``,
                `## Files`,
                files.join("\n") || "none",
                ``,
                `Use the \`name\` parameter to read a specific module, e.g. name="lang".`,
              ].join("\n"),
            },
          ],
        };
      }

      const lower = name.toLowerCase().replace(/\.js$/, "");
      const allFiles = await listFilesRecursive(config.fs, coreDir, [".js"]);
      const match =
        allFiles.find((f) => basename(f, ".js").toLowerCase() === lower) ??
        allFiles.find((f) => basename(f).toLowerCase().includes(lower));

      if (!match) {
        const available = allFiles.map((f) => basename(f, ".js")).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Module "${name}" not found in src/core/.\nAvailable: ${available}`,
            },
          ],
        };
      }

      const content = (await readFileSafe(config.fs, match)) ?? "";
      const lines = content.split("\n");
      const truncated = lines.length > max_lines;
      const shown = truncated ? lines.slice(0, max_lines).join("\n") : content;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# ${match}  (${lines.length} lines${truncated ? `, first ${max_lines} shown` : ""})`,
              ``,
              "```javascript",
              shown,
              truncated
                ? `\n// … ${lines.length - max_lines} more lines.\n// Use read_file_segment with start_line=${max_lines + 1} to continue.`
                : "",
              "```",
            ].join("\n"),
          },
        ],
      };
    }
  );

  // ── explain_lampa_pattern ──────────────────────────────────────────────────
  server.registerTool(
    "explain_lampa_pattern",
    {
      description:
        "Get a detailed explanation and real extracted code examples for any core Lampa development pattern. Combines a written guide with live source examples — the fastest way to understand how Lampa works.",
      inputSchema: {
        pattern: z
          .enum([
            "iife-plugin",
            "storage",
            "settings",
            "events",
            "component",
            "request",
            "template",
            "activity",
            "player-hook",
            "maker",
          ])
          .describe(
            "Pattern to explain: iife-plugin | storage | settings | events | component | request | template | activity | player-hook | maker"
          ),
      },
    },
    async ({ pattern }) => {
      type PatternMeta = {
        title: string;
        description: string;
        searchFor: string;
        searchIn: string;
        keyPoints: string[];
      };

      const patterns: Record<string, PatternMeta> = {
        "iife-plugin": {
          title: "IIFE Plugin Pattern",
          description:
            "All Lampa plugins must be self-contained IIFEs that bootstrap via the `appready` DOM event. This prevents global scope pollution and ensures Lampa APIs are ready before use.",
          searchFor: "(function()",
          searchIn: "plugins",
          keyPoints: [
            "- Wrap the entire plugin: `(function() { 'use strict'; ... })()`",
            "- Define an `init()` function for all startup logic",
            "- Bootstrap: `if (window.appready) init(); else $(document).on('appready', init);`",
            "- Never call Lampa APIs outside of `init()` or event handlers",
            "- Use `var` (not `let`/`const`) for maximum TV browser compatibility unless transpiling",
          ],
        },
        storage: {
          title: "Lampa.Storage Pattern",
          description:
            "Lampa.Storage is the primary key-value persistence API, backed by localStorage. Use it for all user preferences and plugin state that should survive across sessions.",
          searchFor: "Lampa.Storage.get(",
          searchIn: "plugins",
          keyPoints: [
            "- Read: `var val = Lampa.Storage.get('my_key', defaultValue);`",
            "- Write: `Lampa.Storage.set('my_key', value);`",
            "- Prefix keys with plugin name: `'myplugin_setting'` to avoid collisions",
            "- Watch changes: `Lampa.Storage.listener.follow('change', fn);`",
            "- Values must be JSON-serializable; use JSON.stringify/parse for objects",
            "- Default values are returned (not stored) when the key doesn't exist",
          ],
        },
        settings: {
          title: "Lampa.Settings + Lampa.SettingsApi Pattern",
          description:
            "The Settings API lets plugins register their own settings panels and individual controls (toggles, selects, inputs) that appear in the Lampa settings UI.",
          searchFor: "Lampa.Settings.add(",
          searchIn: "plugins",
          keyPoints: [
            "- Register a section: `Lampa.Settings.add('id', { component, name, icon })`",
            "- Add controls via `Lampa.SettingsApi.add({ component, param, field, onChange })`",
            "- param.type options: `'trigger'` (boolean toggle), `'select'`, `'input'`, `'button'`",
            "- `onChange(value)` is called immediately when user changes the setting",
            "- Read saved value: `Lampa.Storage.get(param.name, param.default)`",
            "- Always register settings inside `init()` after app is ready",
          ],
        },
        events: {
          title: "Lampa.Listener Event Pattern",
          description:
            "Lampa uses a pub/sub event bus via Lampa.Listener. Plugins should prefer hooking into events over patching core functions.",
          searchFor: "Lampa.Listener.follow(",
          searchIn: "plugins",
          keyPoints: [
            "- Listen: `Lampa.Listener.follow('event_name', function(e) { ... });`",
            "- Emit: `Lampa.Listener.send('event_name', { type: 'action', ...data });`",
            "- Always check `e.type` — events carry a typed payload, not just a name",
            "- Common events: `app` (types: start/ready), `full` (complite/destroy), `player`, `catalog`",
            "- Plugin-specific events should use unique prefixed names (e.g. `myplugin_done`)",
            "- Use `trace_event` tool to find all files that use a given event",
          ],
        },
        component: {
          title: "Lampa Component Lifecycle Pattern",
          description:
            "UI components follow a defined lifecycle managed by Lampa. Correct implementation of lifecycle methods is critical for back-navigation and memory management on TV hardware.",
          searchFor: "this.create",
          searchIn: "src/components",
          keyPoints: [
            "- `create()` → returns a jQuery DOM element (the component's root)",
            "- `render()` → populates the DOM after the element is attached",
            "- `start()` → called when the component gains focus; enable controllers here",
            "- `pause()` / `stop()` → component loses focus; stop timers",
            "- `destroy()` → MUST clean up ALL event listeners, timers, and DOM references",
            "- Register component: `Lampa.Component.add('name', ConstructorFn)`",
            "- Push to navigation: `Lampa.Activity.push({ component: 'name', ... })`",
          ],
        },
        request: {
          title: "Lampa.Reguest Network Pattern",
          description:
            "Lampa.Reguest is the recommended HTTP client for plugins. It handles TV-friendly error recovery, proxy routing, and request cancellation.",
          searchFor: "new Lampa.Reguest",
          searchIn: "plugins",
          keyPoints: [
            "- Create: `var network = new Lampa.Reguest();`",
            "- Fetch: `network.silent(url, onSuccess, onError, options);`",
            "- Always call `network.clear()` before a new request to cancel pending ones",
            "- Use `component.proxy('name')` to prepend the proxy URL for CORS bypass",
            "- `network.timeout(ms)` sets a custom timeout (default is generous for slow TVs)",
            "- Never use `fetch()` or `$.ajax()` directly — use Lampa.Reguest for proper proxy support",
          ],
        },
        template: {
          title: "Lampa.Template Pattern",
          description:
            "Templates are named HTML strings registered centrally. Plugins retrieve DOM elements via the template system, keeping HTML out of JS strings.",
          searchFor: "Lampa.Template.get(",
          searchIn: "plugins",
          keyPoints: [
            "- Register: `Lampa.Template.add('my_tpl', '<div class=\"...\">{title}</div>')`",
            "- Retrieve DOM: `var el = Lampa.Template.get('my_tpl', { title: movie.title });`",
            "- Placeholders use `{key}` syntax in the HTML string",
            "- Templates in src/templates/*.js are auto-registered by the app",
            "- Use `list_templates` with mode=html (or alias `extract_template_html`) to inspect existing template HTML",
            "- Register templates early (inside `init()`) before any component creates them",
          ],
        },
        activity: {
          title: "Lampa.Activity Navigation Pattern",
          description:
            "Lampa.Activity manages the navigation stack — the back-button history essential for TV remote control. Every screen push creates an activity entry.",
          searchFor: "Lampa.Activity.push",
          searchIn: "plugins",
          keyPoints: [
            "- Push screen: `Lampa.Activity.push({ url, title, component: 'name', object: data })`",
            "- The activity stack drives remote back-button behavior",
            "- Each activity gets `activity.view` (jQuery element) after creation",
            "- Go back: `Lampa.Activity.backward()`",
            "- Listen to changes: `Lampa.Activity.listener.follow('activity', fn)`",
            "- Never push multiple activities without user interaction — it breaks back-nav",
          ],
        },
        "player-hook": {
          title: "Player Hook Pattern",
          description:
            "Hooking into the player lifecycle allows plugins to extend playback, track watch time, inject overlay UI, or modify streams before they play.",
          searchFor: "Lampa.Listener.follow('player'",
          searchIn: "plugins",
          keyPoints: [
            "- `Lampa.Listener.follow('player', function(e) { ... })` — hook the player",
            "- Event types: `start`, `end`, `pause`, `resume`, `destroy`, `timeupdate`",
            "- Access the player instance via `e.object`",
            "- For UI injection: inject on `start`, clean up on `destroy`",
            "- Use `Lampa.Listener.follow('torrent_file', fn)` for torrent player events",
            "- Avoid heavy computation in `timeupdate` — it fires very frequently",
          ],
        },
        maker: {
          title: "Lampa.Maker Modular Component Pattern (3.0)",
          description:
            "Lampa 3.0 replaced monolithic Interaction* classes with composable Maker modules. Each UI class (Main, Card, Category, Line, etc.) has toggleable behavior modules controlled via MaskHelper bitmasks.",
          searchFor: "Lampa.Maker.make(",
          searchIn: "src",
          keyPoints: [
            "- Create: `Lampa.Maker.make('Main', data, (m) => m.toggle(m.MASK.base, 'Callback'))`",
            "- Get class: `Lampa.Maker.get('Main')` then `new classMain(data)`",
            "- Configure modules: `Lampa.Maker.module('Main').only('Create')` or `.toggle(MASK, 'Name')`",
            "- Override hooks: `Lampa.Maker.map('Main').Create.onCreateAndAppend = fn`",
            "- List classes: `Lampa.Maker.list()` — Card, Main, Category, Line, Episode, Season, Person, etc.",
            "- Deprecated: `Lampa.Card`, `Lampa.InteractionMain`, `InteractionCategory`, `InteractionLine`",
            "- Use `maker_module_map` and `upgrade_migration_checker` tools for full reference",
          ],
        },
      };

      const meta = patterns[pattern];
      if (!meta) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown pattern: ${pattern}. Valid options: ${Object.keys(patterns).join(", ")}`,
            },
          ],
        };
      }

      const hits = (await searchCode(config.fs, meta.searchFor, ["*.js"], false))
        .filter(
          (m) => m.file === meta.searchIn || m.file.startsWith(`${meta.searchIn}/`)
        )
        .slice(0, 10);

      const examples: string[] = [];
      const seenFiles = new Set<string>();
      for (const hit of hits) {
        if (seenFiles.size >= 3) break;
        if (seenFiles.has(hit.file)) continue;
        seenFiles.add(hit.file);

        const fileContent = await readFileSafe(config.fs, hit.file);
        if (!fileContent) continue;

        const fileLines = fileContent.split("\n");
        const start = Math.max(0, hit.line - 2);
        const end = Math.min(fileLines.length, hit.line + 12);
        const snippet = fileLines.slice(start, end).join("\n");

        examples.push(
          `### From \`${hit.file}\` (line ${hit.line})\n\`\`\`javascript\n${snippet}\n\`\`\``
        );
      }

      const out = [
        `# ${meta.title}`,
        ``,
        meta.description,
        ``,
        `## Key rules`,
        meta.keyPoints.join("\n"),
        ``,
        `## Live examples from Lampa source`,
        examples.length > 0
          ? examples.join("\n\n")
          : `No examples found searching for \`${meta.searchFor}\` in \`${meta.searchIn}\`.`,
        ``,
        `---`,
        `> Use \`search_code\` with query \`${meta.searchFor}\` for more instances.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );
}
