import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename, joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists, readSegment } from "../utils/fs.js";
import { searchCode, getImports, type SearchMatch } from "../utils/search.js";
import { extractLampaApiUsage, extractEvents, analyseComponentFile } from "../utils/lampa_deep.js";
import { findApiCallsInRepo, formatApiIndex } from "../utils/lampa.js";
import { checkDeprecatedApis } from "../utils/lampa_modern.js";
import { READ_ONLY_SNAPSHOT, fail, ok, reportOutput } from "./meta.js";

export function registerLampaDeepTools(server: McpServer, config: Config): void {
  server.registerTool(
    "analyze_plugin",
    {
      title: "Analyze one Lampa plugin folder",
      description:
        "Single-call report for one `plugins/<name>` folder: files, Lampa.* usage, Listener follow/send, settings, CSS, and an entry preview truncated to ~30 lines, plus how Lampa loads plugins (`src/core/plugins.js`).\nUnlike `list_catalog` this is scoped to one plugin, unlike `trace_symbol` it does not follow a single event/file across the repo, unlike `validate_code` it does not score conventions.\nEntry file is chosen as main.js, else `<plugin>.js`, else the first .js file found — `plugin` itself must be just the case-sensitive directory name (e.g. `online`, `iptv`, never a `plugins/` prefix or nested path), not a manifest id; omit it for load-path-only output; an unknown folder errors and lists available folders instead of guessing.",
      inputSchema: {
        plugin: z
          .string()
          .optional()
          .describe(
            "Case-sensitive plugins/ directory name (not a manifest id), e.g. 'online', 'iptv', 'collections'. Omit for load-path only."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ plugin }) => {
      const loadPath = await formatPluginLoadPath(config);
      if (!plugin) return ok(loadPath);

      const pluginDir = joinRepo("plugins", plugin);
      if (!(await fileExists(config.fs, pluginDir))) {
        const available = (await fileExists(config.fs, "plugins"))
          ? (await config.fs.listDir("plugins"))
              .filter((e) => e.type === "dir")
              .map((e) => e.name)
              .join(", ")
          : "plugins/ directory not found";
        return fail(`Plugin "${plugin}" not found.\nAvailable plugins: ${available}`);
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
        // Matches the "~30 lines" cap stated in analyze_plugin's tool description.
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

      return ok(
        [
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
          ``,
          `---`,
          loadPath,
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "trace_symbol",
    {
      title: "Trace one Lampa symbol through code",
      description:
        "Follow one event, component, file, or provider through the snapshot graph — not a full catalog (`list_catalog`) and not raw grep (`search_code`). Examples: `mode=event` target=`app`; `lifecycle` target=`src/components/full.js`; `deps` a file path; `upgrade` a repo-relative file path (not an API name); omit `target` only for `api_calls` (optional `target` is a provider keyword). Missing `target` otherwise → error; unknown event → markdown note (not a crash); `deps` reverse-refs cap at 20.",
      inputSchema: {
        mode: z
          .enum(["event", "lifecycle", "deps", "api_calls", "upgrade"])
          .describe(
            "event=Listener bus; lifecycle=component contract; deps=import blast radius; api_calls=external fetches; upgrade=scan a file for 2.x→Maker APIs."
          ),
        target: z
          .string()
          .optional()
          .describe(
            "Required except api_calls. event: name e.g. 'app'/'player'; lifecycle: component name or path e.g. 'src/components/full.js'; deps/upgrade: repo-relative file path; api_calls: optional provider keyword."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ mode, target }) => {
      if (mode === "event") {
        if (!target)
          return fail("mode=event requires target (event name, e.g. 'app' or 'player').");
        return ok(await traceEvent(config, target));
      }
      if (mode === "lifecycle") {
        if (!target) return fail("mode=lifecycle requires target (component name or file path).");
        return lifecycle(config, target);
      }
      if (mode === "deps") {
        if (!target) return fail("mode=deps requires target (repo-relative file path).");
        return deps(config, target);
      }
      if (mode === "upgrade") {
        if (!target) return fail("mode=upgrade requires target (repo-relative file path).");
        return upgradeCheck(config, target);
      }
      return apiCalls(config, target);
    }
  );
}

async function formatPluginLoadPath(config: Config): Promise<string> {
  const pluginsFile = "src/core/plugins.js";
  const gulpFile = "gulpfile.js";
  const sections: string[] = [
    `# Plugin load path`,
    ``,
    `Runtime plugins are **script-injected IIFEs** that talk to \`window.Lampa\` — there is no bundler import into the app.`,
    `Bootstrap with \`Lampa.Listener.follow('app', … ready)\`, not jQuery \`appready\`.`,
    ``,
  ];

  if (!(await fileExists(config.fs, pluginsFile))) {
    sections.push(`\`${pluginsFile}\` not found in the repository.`);
  } else {
    const content = (await readFileSafe(config.fs, pluginsFile)) ?? "";
    const lines = content.split("\n");
    const fnHits = lines
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter((l) => /function\s+\w+|exports\.|module\.exports/.test(l.text))
      .slice(0, 12);
    sections.push(
      `## ${pluginsFile} (${lines.length} lines)`,
      ``,
      `### Key symbols`,
      fnHits.map((h) => `- L${h.line}: \`${h.text.trim()}\``).join("\n") || "None found.",
      ``,
      `- Plugins are listed via Settings → Plugins and persisted in Storage.`,
      `- \`${pluginsFile}\` injects remote/local plugin scripts at runtime.`
    );
  }

  if (await fileExists(config.fs, gulpFile)) {
    const gulpContent = (await readFileSafe(config.fs, gulpFile)) ?? "";
    const gulpLines = gulpContent.split("\n");
    const pluginTaskLines = gulpLines
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter((l) => /plugin/i.test(l.text));
    sections.push(
      ``,
      `## ${gulpFile} — plugin-related lines`,
      pluginTaskLines
        .slice(0, 25)
        .map((l) => `${l.line}: ${l.text.trim()}`)
        .join("\n") || "No plugin mentions in gulpfile.js."
    );
    if (pluginTaskLines.length > 0) {
      const first = pluginTaskLines[0].line;
      const seg = await readSegment(
        config.fs,
        gulpFile,
        Math.max(1, first - 2),
        Math.min(gulpLines.length, first + 20)
      );
      sections.push(``, `### Sample segment`, "```javascript", seg, "```");
    }
  }

  return sections.join("\n");
}

async function traceEvent(config: Config, event: string): Promise<string> {
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
    if (pat.includes(".send(")) allSends.push(...hits);
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
      ? `\n> Event \`${event}\` not found. Common: \`app\`, \`full\`, \`player\`, \`catalog\`, \`settings\`, \`torrent_file\`.`
      : "";
  return [
    `# Event trace: \`${event}\``,
    ``,
    `## Files that LISTEN to \`${event}\` (${follows.length})`,
    followBlock,
    ``,
    `## Files that EMIT \`${event}\` (${sends.length})`,
    sendBlock,
    notFound,
  ].join("\n");
}

async function lifecycle(config: Config, component: string) {
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
    return fail(
      `Component "${component}" not found. Try a path like 'src/components/episodes.js' or find_files mode=ui.`
    );
  }
  const summary = await analyseComponentFile(config.fs, targetFile);
  const lifecycleBlock =
    Object.entries(summary.methods)
      .filter(([, lns]) => lns.length > 0)
      .map(([name, lns]) => `- **${name}** → line${lns.length > 1 ? "s" : ""} ${lns.join(", ")}`)
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
  return ok(
    [
      `# Component lifecycle: ${summary.file}`,
      `**Lines:** ${summary.lineCount}`,
      ``,
      `## Official contract`,
      `- create() must return the root DOM synchronously; use this.activity.loader(true|false).`,
      `- start() when the screen gains focus — Controller.add + toggle here.`,
      `- stop() means another screen is on top — do not destroy resources.`,
      `- destroy() on pop: inited=false, network.clear(), remove named listeners.`,
      ``,
      `## Lifecycle methods`,
      lifecycleBlock,
      ``,
      `## Event hooks`,
      `### Listens`,
      followBlock,
      `### Emits`,
      sendBlock,
      ``,
      `## Lampa APIs used (${summary.lampaApis.length})`,
      summary.lampaApis.length > 0
        ? summary.lampaApis.map((a) => `- Lampa.${a}`).join("\n")
        : "None.",
      ``,
      `## Storage reads`,
      fmtHits(summary.storageReads),
      ``,
      `## Storage writes`,
      fmtHits(summary.storageWrites),
      ``,
      `## Templates`,
      fmtHits(summary.templateUsages),
      ``,
      `## Settings`,
      fmtHits(summary.settingsUsages),
      ``,
      `## Source preview (first 35 lines)`,
      `\`\`\`javascript`,
      summary.preview,
      `\`\`\``,
    ].join("\n")
  );
}

async function deps(config: Config, file: string) {
  if (!(await fileExists(config.fs, file))) {
    return fail(`File not found: ${file}`);
  }
  const imports = await getImports(config.fs, file);
  const base = basename(file).replace(/\.[^.]+$/, "");
  const reverseMatches = (await searchCode(config.fs, base, ["*.js", "*.ts"], false))
    .filter((m) => m.text.includes("require") || m.text.includes("import"))
    .filter((m) => m.file !== file)
    // Matches the "reverse-refs cap at 20" stated in trace_symbol's tool description.
    .slice(0, 20);
  return ok(
    [
      `## Dependency map: ${file}`,
      ``,
      `### Direct imports (${imports.length})`,
      imports.join("\n") || "None.",
      ``,
      `### Likely imported by (reverse, by filename match)`,
      reverseMatches.map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n") || "None found.",
      ``,
      reverseMatches.length > 5
        ? `This module is referenced in ${reverseMatches.length}+ places. Changes here are high-impact.`
        : `This module has ${reverseMatches.length} known reverse dependencies.`,
    ].join("\n")
  );
}

async function apiCalls(config: Config, provider?: string) {
  const indexed = await config.fs.readIndex?.("api-integrations");
  if (indexed != null && !provider) {
    return ok(formatApiIndex(indexed));
  }
  return ok(await findApiCallsInRepo(config.fs, provider));
}

async function upgradeCheck(config: Config, file: string) {
  if (!(await fileExists(config.fs, file))) {
    return fail(`File not found: ${file}`);
  }
  const hits = await checkDeprecatedApis(config.fs, file);
  if (hits.length === 0) {
    return ok(
      `No deprecated 2.x APIs found in \`${file}\`. File appears compatible with Lampa 3.0 Maker.`
    );
  }
  const rows = hits.map(
    (h) =>
      `- **Line ${h.line}** — \`${h.api}\`\n  \`${h.text}\`\n  → Replace with: \`${h.replacement}\``
  );
  const upgradeExists = await fileExists(config.fs, "UPGRADE.md");
  return ok(
    [
      `# Migration Check: ${file}`,
      ``,
      `Found **${hits.length}** deprecated API usage(s):`,
      ``,
      ...rows,
      ``,
      upgradeExists
        ? `See UPGRADE.md and explain_docs mode=pattern pattern=maker.`
        : `UPGRADE.md not found in repo.`,
      ``,
      `Version gate: \`if (Lampa.Manifest.app_digital >= 300) { /* use Maker */ }\``,
    ].join("\n")
  );
}
