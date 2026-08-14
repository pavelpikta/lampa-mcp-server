import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename, joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists, readSegment } from "../utils/fs.js";
import { searchCode, type SearchMatch } from "../utils/search.js";
import {
  extractLampaApiUsage,
  extractEvents,
  extractProviderInfo,
  analyseComponentFile,
  formatI18nCoverage,
  formatTemplates,
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

  // ── translation_coverage (alias of i18n_check mode=coverage) ───────────────
  server.registerTool(
    "translation_coverage",
    {
      description:
        "Alias of i18n_check mode=coverage. Compare all language files against English reference.",
      inputSchema: {
        show_missing: z
          .boolean()
          .optional()
          .describe("Include the list of missing keys for each language. Default: true."),
      },
    },
    async ({ show_missing = true }) => {
      const text = await formatI18nCoverage(config.fs, show_missing);
      return {
        content: [
          {
            type: "text" as const,
            text: `> Prefer \`i18n_check\` with mode=coverage.\n\n${text}`,
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
        "List Lampa UI templates in src/templates/. Use mode=list (default), mode=html (extracted markup), or mode=raw (source JS). name is required for html/raw.",
      inputSchema: {
        mode: z
          .enum(["list", "html", "raw"])
          .optional()
          .describe("list = catalog; html = extract markup; raw = source JS. Default: list."),
        name: z
          .string()
          .optional()
          .describe(
            "Template name or partial name, e.g. 'card', 'modal', 'player', 'settings'. Required for mode=html/raw."
          ),
      },
    },
    async ({ mode = "list", name }) => {
      const text = await formatTemplates(config.fs, mode, name);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── generate_plugin_boilerplate (redirect) ─────────────────────────────────
  server.registerTool(
    "generate_plugin_boilerplate",
    {
      description:
        "Deprecated: use scaffold_plugin_integration instead. Thin redirect to the preferred scaffold tool.",
      inputSchema: {
        plugin_name: z.string().describe("Plugin folder/id in snake_case, e.g. 'my_plugin'."),
        display_name: z
          .string()
          .optional()
          .describe("Human-readable name (ignored — use scaffold_plugin_integration)."),
        features: z
          .array(z.string())
          .optional()
          .describe("Ignored — use scaffold_plugin_integration."),
      },
    },
    async ({ plugin_name, display_name }) => {
      const desc = display_name ?? plugin_name.replace(/_/g, " ");
      const text = [
        `# Use scaffold_plugin_integration`,
        ``,
        `\`generate_plugin_boilerplate\` is deprecated to avoid duplicated scaffolds.`,
        ``,
        `Call:`,
        `\`\`\``,
        `scaffold_plugin_integration({`,
        `  plugin_name: "${plugin_name}",`,
        `  description: "${desc}"`,
        `})`,
        `\`\`\``,
        ``,
        `That tool returns the preferred main.js + CSS scaffold under plugins/${plugin_name}/.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── plugin_load_path ───────────────────────────────────────────────────────
  server.registerTool(
    "plugin_load_path",
    {
      description:
        "Explain how Lampa discovers, loads, caches, and blacklists plugins. Reads src/core/plugins.js and gulpfile.js plugin-related tasks with line-numbered segments.",
      inputSchema: {},
    },
    async () => {
      const pluginsFile = "src/core/plugins.js";
      const gulpFile = "gulpfile.js";
      const sections: string[] = [
        `# Plugin load path`,
        ``,
        `Runtime plugins are **script-injected IIFEs** that talk to \`window.Lampa\` — there is no bundler import into the app.`,
        `Official authoring guide: resource \`lampa://plugin-guide\` (docs/en). Bootstrap with \`Lampa.Listener.follow('app', … ready)\`, not jQuery \`appready\`.`,
        ``,
      ];

      if (!(await fileExists(config.fs, pluginsFile))) {
        sections.push(`\`${pluginsFile}\` not found in the repository.`);
      } else {
        const content = (await readFileSafe(config.fs, pluginsFile)) ?? "";
        const lines = content.split("\n");

        const topicHints: Array<{ title: string; needles: string[] }> = [
          { title: "Discovery / install", needles: ["install", "push", "add", "url"] },
          { title: "Load / inject", needles: ["load", "script", "createElement", "append"] },
          { title: "Cache", needles: ["cache", "Storage", "localStorage"] },
          { title: "Blacklist", needles: ["black", "block", "ban", "deny"] },
        ];

        sections.push(`## ${pluginsFile} (${lines.length} lines)`, ``);

        const explained: string[] = [];
        for (const topic of topicHints) {
          const hits = await searchCode(config.fs, topic.needles[0], ["*.js"], false, "src/core");
          const inFile = hits.filter((h) => h.file === pluginsFile).slice(0, 3);
          if (inFile.length === 0) continue;
          explained.push(`### ${topic.title}`);
          for (const h of inFile) {
            const start = Math.max(1, h.line - 2);
            const end = Math.min(lines.length, h.line + 6);
            const seg = await readSegment(config.fs, pluginsFile, start, end);
            explained.push(`Hit at line ${h.line}: \`${h.text}\``, "```javascript", seg, "```", ``);
          }
        }

        // Also surface key function definitions
        const fnHits = lines
          .map((l, i) => ({ line: i + 1, text: l }))
          .filter((l) => /function\s+\w+|exports\.|module\.exports/.test(l.text))
          .slice(0, 12);

        sections.push(
          `### Key symbols`,
          fnHits.map((h) => `- L${h.line}: \`${h.text.trim()}\``).join("\n") || "None found.",
          ``,
          explained.length > 0
            ? explained.join("\n")
            : "No discovery/cache/blacklist keywords matched; see key symbols and full file via read_file.",
          ``,
          `### Overview (heuristic)`,
          `- Plugins are typically listed via Settings → Plugins and persisted in Storage.`,
          `- \`src/core/plugins.js\` injects remote/local plugin scripts at runtime.`,
          `- Cache / blacklist logic (when present) lives in the same module — see hits above.`,
          `- Prefer \`plugin_deep_dive\` for analysing an individual plugin folder.`,
          ``
        );
      }

      if (!(await fileExists(config.fs, gulpFile))) {
        sections.push(`\`${gulpFile}\` not found.`);
      } else {
        const gulpContent = (await readFileSafe(config.fs, gulpFile)) ?? "";
        const gulpLines = gulpContent.split("\n");
        const pluginTaskLines = gulpLines
          .map((l, i) => ({ line: i + 1, text: l }))
          .filter((l) => /plugin/i.test(l.text));

        const taskNames = [
          ...new Set(
            pluginTaskLines
              .map((l) => {
                const m =
                  l.text.match(/exports\.(\w*plugin\w*)/i) ||
                  l.text.match(/function\s+(\w*plugin\w*)/i) ||
                  l.text.match(/['"](\w*plugin\w*)['"]/i);
                return m?.[1];
              })
              .filter((x): x is string => Boolean(x))
          ),
        ];

        sections.push(
          `## ${gulpFile} — plugin-related tasks`,
          taskNames.length > 0
            ? taskNames.map((t) => `- \`${t}\``).join("\n")
            : "- No task names matched; see line hits below.",
          ``,
          `### Matching lines`,
          pluginTaskLines
            .slice(0, 40)
            .map((l) => `${l.line}: ${l.text.trim()}`)
            .join("\n") || "No plugin mentions in gulpfile.js.",
          ``
        );

        // Show a representative segment around the first plugin hit
        if (pluginTaskLines.length > 0) {
          const first = pluginTaskLines[0].line;
          const start = Math.max(1, first - 2);
          const end = Math.min(gulpLines.length, first + 20);
          const seg = await readSegment(config.fs, gulpFile, start, end);
          sections.push(`### Sample segment`, "```javascript", seg, "```");
        }
      }

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
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
        `## Official contract (docs/en/02-lifecycle.md + 13-controller.md)`,
        `- \`create()\` must return the root DOM/jQuery element synchronously; use \`this.activity.loader(true|false)\`.`,
        `- \`start()\` runs when the screen gains focus — register \`Controller.add('content', …)\` and \`Controller.toggle('content')\` here.`,
        `- \`stop()\` means another screen is on top — do not destroy resources.`,
        `- \`destroy()\` on pop: \`inited = false\`, \`network.clear()\`, \`scroll.destroy()\`, remove named listeners.`,
        `- \`render()\` returns the root; optional \`empty()\` calls \`this.activity.empty()\`.`,
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
