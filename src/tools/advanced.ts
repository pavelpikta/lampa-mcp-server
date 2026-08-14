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
        "Validate a Lampa plugin against official plugin-docs pitfalls: double-load guard, Listener appready, PlayerVideo cleanup, SettingsApi, storage prefixes, and more.",
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

      const jqueryAppready = /\$\(\s*document\s*\)\.on\(\s*['"]appready['"]/.test(content);
      const listenerReady =
        /Listener\.follow\(\s*['"]app['"]/.test(content) && /e\.type\s*==\s*['"]ready['"]/.test(content);
      const hasAppreadyFlag = /\bwindow\.appready\b/.test(content) || /\bappready\b/.test(content);
      const hasGuard = /window\.\w+_ready/.test(content) && /if\s*\(\s*!window\.\w+_ready/.test(content);
      const usesSettingsAdd = /Lampa\.Settings\.add\s*\(/.test(content);
      const usesSettingsApi = /SettingsApi\.add(Component|Param)\s*\(/.test(content);
      const overwritesLampaSettings = /window\.lampa_settings\s*=\s*\{/.test(content);
      const addEventListenerHover = /addEventListener\(\s*['"]hover:/.test(content);
      const jqueryHover = /\.on\(\s*['"]hover:(enter|focus|long|hover|touch)['"]/.test(content);
      const playerVideoFollow = /PlayerVideo\.listener\.follow/.test(content);
      const playerVideoRemove = /PlayerVideo\.listener\.remove/.test(content);
      const hasNetwork = /new\s+Lampa\.Reguest\s*\(/.test(content);
      const hasInited = /\binited\b/.test(content);
      const hasNetworkClear = /network\.clear\s*\(/.test(content);
      const cssAppend = /\$\(\s*['"]body['"]\s*\)\.append/.test(content);
      const cssInInit = /function\s+init\s*\([^)]*\)\s*\{[\s\S]{0,2500}append/.test(content);

      const pluginBase = basename(rel, ".js").split(/[/_-]/)[0] ?? plugin;
      const storageKeys: string[] = [];
      const storagePat = /Lampa\.Storage\.(get|set|field|add)\(\s*['"]([^'"]+)['"]/g;
      let sm: RegExpExecArray | null;
      while ((sm = storagePat.exec(content)) !== null) storageKeys.push(sm[2]);
      const storagePrefixed =
        storageKeys.length === 0 ||
        storageKeys.every(
          (k) =>
            k.startsWith(pluginBase) ||
            k.startsWith(`${plugin}_`) ||
            k.startsWith("video_") ||
            k.startsWith("online_")
        );

      const langHasRuEn =
        !content.includes("Lampa.Lang.add") ||
        (/Lang\.add\s*\(/.test(content) &&
          /(?:ru\s*:)/.test(content) &&
          /(?:en\s*:)/.test(content));

      const checks: Array<{
        name: string;
        pass: boolean;
        severity: "error" | "warn" | "info";
        fix: string;
      }> = [
        {
          name: "IIFE or named start function wrapper",
          pass: /\(function\s*\(/.test(content) || /function\s+start\w+\s*\(/.test(content),
          severity: "error",
          fix: "Wrap the plugin in a uniquely named start function (official docs) or an IIFE.",
        },
        {
          name: "Double-load guard (`window.<plugin>_ready`)",
          pass: hasGuard,
          severity: "error",
          fix: "Set `window.my_plugin_ready = true` inside start, then `if (!window.my_plugin_ready) startMyPlugin()`.",
        },
        {
          name: "Bootstraps on Listener app:ready (not jQuery appready)",
          pass: listenerReady || (hasAppreadyFlag && /window\.appready/.test(content) && !jqueryAppready),
          severity: "error",
          fix: "Use `if (window.appready) init(); else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })`.",
        },
        {
          name: "Does not use outdated `$(document).on('appready')`",
          pass: !jqueryAppready,
          severity: "error",
          fix: "Replace jQuery appready with Lampa.Listener.follow('app', … e.type == 'ready').",
        },
        {
          name: "No hardcoded `localhost` URLs",
          pass: !content.includes("localhost"),
          severity: "error",
          fix: "Remove localhost URLs. Store the server URL via SettingsApi + Storage.field().",
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
          name: "Does not overwrite `window.lampa_settings`",
          pass: !overwritesLampaSettings,
          severity: "error",
          fix: "Extend with `Lampa.Arrays.extend(window.lampa_settings, { … })` or set individual keys.",
        },
        {
          name: "PlayerVideo listeners are removed",
          pass: !playerVideoFollow || playerVideoRemove,
          severity: "error",
          fix: "Store named handlers and `PlayerVideo.listener.remove(type, fn)` inside Player:destroy.",
        },
        {
          name: "Network callbacks guarded (`inited` + `network.clear`)",
          pass: !hasNetwork || (hasInited && hasNetworkClear),
          severity: "warn",
          fix: "Set `inited = false` in destroy(), ignore late responses, call `network.clear()`.",
        },
        {
          name: "TV events via jQuery `.on('hover:enter')` not addEventListener",
          pass: !addEventListenerHover && (jqueryHover || !content.includes("hover:enter")),
          severity: "warn",
          fix: "Use `$(el).on('hover:enter', handler)` — native addEventListener does not receive hover:* events.",
        },
        {
          name: "Uses SettingsApi (not Lampa.Settings.add)",
          pass: !usesSettingsAdd || usesSettingsApi,
          severity: "warn",
          fix: "Prefer `Lampa.SettingsApi.addComponent` / `addParam`. Read values with `Lampa.Storage.field(key)`.",
        },
        {
          name: "Lang.add includes ru and en",
          pass: langHasRuEn,
          severity: "warn",
          fix: "Always pass at least `ru` and `en` in Lampa.Lang.add({ key: { ru, en } }).",
        },
        {
          name: "CSS injection happens inside init()",
          pass: !cssAppend || cssInInit,
          severity: "warn",
          fix: "Append plugin `<style>` templates inside init() after app:ready so app CSS is already loaded.",
        },
        {
          name: "Storage keys use plugin prefix",
          pass: storagePrefixed,
          severity: "info",
          fix: `Prefix storage keys with the plugin name (e.g. '${pluginBase}_token').`,
        },
        {
          name: "Uses `Lampa.Lang` for UI strings",
          pass: content.includes("Lampa.Lang"),
          severity: "info",
          fix: "Replace hardcoded UI strings with Lampa.Lang.translate('key').",
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
            "controller",
            "manifest-menu",
          ])
          .describe(
            "Pattern: iife-plugin | storage | settings | events | component | request | template | activity | player-hook | maker | controller | manifest-menu"
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
          title: "Plugin start + app:ready Pattern",
          description:
            "Plugins are script-injected IIFEs/start functions using window.Lampa. Official bootstrap is Lampa.Listener app:ready, plus a unique global double-load guard.",
          searchFor: "Listener.follow('app'",
          searchIn: "plugins",
          keyPoints: [
            "- Unique guard: `window.my_plugin_ready = true` then `if (!window.my_plugin_ready) startMyPlugin()`",
            "- Bootstrap: `if (window.appready) init(); else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })`",
            "- Do NOT use `$(document).on('appready', init)` — outdated and not in official docs",
            "- Never call Activity.push, SettingsApi, or read `.menu__list` outside init()",
            "- Folder name must match the entry filename: `plugins/my_plugin/my_plugin.js`",
          ],
        },
        storage: {
          title: "Lampa.Storage Pattern",
          description:
            "Storage wraps localStorage with an IndexedDB cache. Prefix every key. Use Storage.field() for SettingsApi params.",
          searchFor: "Lampa.Storage.get(",
          searchIn: "plugins",
          keyPoints: [
            "- Plugin state: `Lampa.Storage.get('myplugin_token', '')` / `Storage.set(...)`",
            "- SettingsApi params: `Lampa.Storage.field('myplugin_quality')` (applies default)",
            "- Prefix keys: `myplugin_token` — never generic `token` / `url` / `quality`",
            "- Watch: `Lampa.Storage.listener.follow('change', fn)` payload `{name, value}`",
            "- Arrays: `Storage.add` / `Storage.remove`; bounded maps: `Storage.cache(key, maxSize, {})`",
          ],
        },
        settings: {
          title: "Lampa.SettingsApi Pattern",
          description:
            "Plugins add a Settings section with SettingsApi.addComponent + addParam. Values persist automatically.",
          searchFor: "SettingsApi.addComponent",
          searchIn: "plugins",
          keyPoints: [
            "- Section: `Lampa.SettingsApi.addComponent({ component, name, icon, before/after })`",
            "- Param: `SettingsApi.addParam({ component, param: { name, type, default }, field, onChange })`",
            "- param.type: `'trigger'` (toggle), `'select'` (values map), `'input'`",
            "- Read: `Lampa.Storage.field(param.name)` — not Settings.add({ items })",
            "- Built-in section ids for before/after: interface, player, parser, server, more, account, plugins, tmdb",
            "- Register inside init() after app:ready",
          ],
        },
        events: {
          title: "Event buses (Listener, Player, Storage, Favorite, Keypad)",
          description:
            "Subscribe with .follow(type, namedFn) and always .remove(type, namedFn). See resource lampa://events.",
          searchFor: "Lampa.Listener.follow(",
          searchIn: "plugins",
          keyPoints: [
            "- App-wide: `Lampa.Listener.follow('app'|'activity'|'full'|'line'|'torrent_file', fn)`",
            "- Player: `Lampa.Player.listener.follow('create'|'start'|'ready'|'destroy', fn)` — not Listener.follow('player')",
            "- PlayerVideo: subscribe on start, remove on destroy (module is recreated each open)",
            "- Store handlers in named variables — anonymous functions cannot be removed",
            "- Private bus: `var bus = Lampa.Subscribe()`",
          ],
        },
        component: {
          title: "Component lifecycle contract",
          description:
            "Activity calls create (must return DOM), start (focus), stop (covered), destroy (cleanup), render. Optional empty().",
          searchFor: "this.create",
          searchIn: "src/components",
          keyPoints: [
            "- `create()` must return a DOM/jQuery root synchronously; show loader with `this.activity.loader(true)`",
            "- `start()` — screen gained focus; register Controller.add('content', …) and toggle here",
            "- `stop()` — another screen on top; do not destroy resources",
            "- `destroy()` — pop: `inited=false`, `network.clear()`, `scroll.destroy()`, remove listeners",
            "- `render()` returns the root; `empty()` uses `this.activity.empty()`",
            "- Register: `Lampa.Component.add('name', Ctor)` then `Activity.push({ component: 'name', … })`",
          ],
        },
        request: {
          title: "Lampa.Reguest Network Pattern",
          description:
            "jQuery-ajax wrapper with loading overlay, cancel, and error helpers. One instance per component.",
          searchFor: "new Lampa.Reguest",
          searchIn: "plugins",
          keyPoints: [
            "- `var network = new Lampa.Reguest(); network.timeout(15000)`",
            "- `get` shows overlay and cancels previous get; `silent` / `quiet` / `last` / `native` variants",
            "- Guard late callbacks with `inited`; `network.clear()` in destroy()",
            "- Errors: `network.errorDecode(jqXHR, exception)` + Noty",
            "- Note the class name is `Reguest` (historical spelling)",
          ],
        },
        template: {
          title: "Lampa.Template + Lang Pattern",
          description:
            "Named HTML strings with `{key}` data placeholders and `#{lang_key}` i18n. CSS via a <style> template appended in init().",
          searchFor: "Lampa.Template.add(",
          searchIn: "plugins",
          keyPoints: [
            "- `Lampa.Template.add('my_card', '<div>{title} #{my_label}</div>')`",
            "- `Template.get(name, data)` → jQuery clone; third arg `true` → raw HTML string",
            "- `Lampa.Lang.add({ my_key: { ru: '…', en: '…' } })` — always include ru and en",
            "- Inject CSS inside init(): `$('body').append(Template.get('my_css', {}, true))`",
            "- Built-in plugins may `@@include('../plugins/name/css/style.css')` at Gulp time",
          ],
        },
        activity: {
          title: "Lampa.Activity Navigation Pattern",
          description:
            "Stack navigation. Activity.push adds a screen; back pops. Extra keys on the object become the component constructor argument.",
          searchFor: "Lampa.Activity.push",
          searchIn: "plugins",
          keyPoints: [
            "- `Activity.push({ url, title, component, page, …custom })`",
            "- `Activity.replace(params)` updates current without a new history entry",
            "- `Activity.backward()` / `Activity.active()`",
            "- Listen: `Lampa.Listener.follow('activity', fn)` — not Activity.listener",
            "- Named routes: `Lampa.Router.call('full'|'category'|'actor', data)`",
          ],
        },
        "player-hook": {
          title: "Player + PlayerVideo Hook Pattern",
          description:
            "Use Player.listener for lifecycle and PlayerVideo.listener for the media element. Clean up on destroy.",
          searchFor: "Player.listener.follow",
          searchIn: "plugins",
          keyPoints: [
            "- `Lampa.Player.listener.follow('start', onStart)` — not Listener.follow('player')",
            "- `create` can `data.abort()`; `destroy` must remove all PlayerVideo handlers",
            "- PlayerVideo events: canplay, timeupdate, ended, error, tracks, subs, levels, webos_*",
            "- Enriched tracks: `Lampa.PlayerPanel.setTracks` / `setSubs`",
            "- Torrent playback: `data.torrent_hash` and `data.id` on start",
          ],
        },
        maker: {
          title: "Lampa.Maker Modular Component Pattern (3.0)",
          description:
            "Lampa 3.0 replaced monolithic Interaction* classes with composable Maker modules. See UPGRADE.md and maker_module_map.",
          searchFor: "Lampa.Maker.make(",
          searchIn: "src",
          keyPoints: [
            "- Create: `Lampa.Maker.make('Main', data, (m) => m.toggle(m.MASK.base, 'Callback'))`",
            "- Guard: `if (Lampa.Manifest.app_digital >= 300)` before Maker APIs",
            "- Deprecated: `Lampa.Card`, `InteractionMain`, `InteractionCategory`, `InteractionLine`",
            "- Use `maker_module_map` and `upgrade_migration_checker` for full reference",
          ],
        },
        controller: {
          title: "Controller & TV navigation",
          description:
            "One named controller owns the remote at a time. Elements with class selector are focusable. Source: docs/en/13-controller.md.",
          searchFor: "Controller.add(",
          searchIn: "src",
          keyPoints: [
            "- Register in start(): `Lampa.Controller.add('content', { toggle, left, right, up, down, back })`",
            "- `toggle` should `collectionSet(html)` and `collectionFocus(last || false, html)`",
            "- Then `Lampa.Controller.toggle('content')`",
            "- Use jQuery `el.on('hover:enter'|'hover:focus'|'hover:long', …)` — not addEventListener",
            "- After Select/Modal onBack: `Controller.toggle('content')` to restore focus",
            "- Global hotkeys: `Lampa.Keypad.listener.follow` — remove in destroy()",
          ],
        },
        "manifest-menu": {
          title: "Manifest context menu & sidebar",
          description:
            "type:'video' manifests appear on long-press card menus. Sidebar items are appended to .menu__list.",
          searchFor: "Manifest.plugins",
          searchIn: "plugins",
          keyPoints: [
            "- `Lampa.Manifest.plugins = { type:'video', onContextMenu, onContextLauch }`",
            "- Setter appends; multiple plugins each get a menu entry",
            "- IMDb id is fetched before onContextLauch when registered via the setter",
            "- Sidebar: `$('.menu .menu__list').eq(0).append(btn)` with `hover:enter` → Activity.push",
            "- Re-add component if needed: `if (!Component.get(name)) Component.add(name, Ctor)`",
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
        .filter((m) => m.file === meta.searchIn || m.file.startsWith(`${meta.searchIn}/`))
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
