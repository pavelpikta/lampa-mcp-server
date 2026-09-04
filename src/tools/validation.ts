import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename, joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists, parseJsonSafe } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { findMissingLangKeys, extractPlatformTargets } from "../utils/lampa_modern.js";
import { formatI18nKeys, formatI18nCoverage } from "../utils/lampa_deep.js";
import {
  formatDocHits,
  formatPluginGuideToc,
  PLUGIN_DOC_CHAPTERS,
  readPluginChapter,
  resolveChapter,
  searchPluginDocs,
  type PluginDocsLang,
} from "../utils/plugin_docs.js";
import { READ_ONLY_SNAPSHOT, fail, ok, reportOutput } from "./meta.js";

export function registerValidationTools(server: McpServer, config: Config): void {
  server.registerTool(
    "validate_code",
    {
      title: "Validate Lampa plugin, grep, i18n, or build",
      description:
        "Run checks and hints, not catalogs (`list_catalog`) and not edit plans (`plan_change`). `mode=plugin` scores a plugin against official pitfalls; `grep` scans the snapshot for TODOs/console.log/undefined/lang/hardcoded HTML (not a shell); `i18n` looks up `key` or, if omitted, coverage vs en.js; `build` returns the npm/gulp command for a goal — it does not run it. `checks` only for mode=grep (default all); `show_missing` only for i18n coverage (ignored when `key` is set); `goal` only for mode=build; `target` is required for mode=plugin (folder or JS path); missing plugin → error listing folders.",
      inputSchema: {
        mode: z
          .enum(["plugin", "grep", "i18n", "build"])
          .describe(
            "plugin=convention score; grep=snapshot quality scans (not a shell); i18n=keys/coverage; build=command hint (does not run npm/gulp)."
          ),
        target: z
          .string()
          .optional()
          .describe(
            "Required for mode=plugin: plugin folder name or repo-relative JS path. Missing plugin → error listing folders."
          ),
        checks: z
          .array(
            z.enum([
              "todos",
              "console_logs",
              "undefined_refs",
              "missing_lang_keys",
              "hardcoded_strings",
            ])
          )
          .optional()
          .describe("For mode=grep: which checks. Defaults to all."),
        key: z
          .string()
          .optional()
          .describe("For mode=i18n: specific translation key. Omit for coverage report."),
        show_missing: z
          .boolean()
          .optional()
          .describe("For mode=i18n coverage: include missing/extra key lists. Default true."),
        goal: z
          .enum(["build", "dev", "test", "doc", "lint"])
          .optional()
          .describe("For mode=build: which command to hint (does not execute). Default build."),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async (args) => {
      if (args.mode === "plugin") {
        if (!args.target) return fail("mode=plugin requires target (plugin folder or .js path).");
        return validatePlugin(config, args.target);
      }
      if (args.mode === "grep") return grepChecks(config, args.checks);
      if (args.mode === "i18n") {
        const text = args.key
          ? await formatI18nKeys(config.fs, args.key)
          : await formatI18nCoverage(config.fs, args.show_missing ?? true);
        return ok(text);
      }
      return buildHint(config, args.goal ?? "build");
    }
  );

  server.registerTool(
    "explain_docs",
    {
      title: "Explain Lampa docs, patterns, or packaging",
      description:
        "Read written Lampa guides: official plugin chapters (`mode=plugin_docs`), a core development pattern with live snippets (`mode=pattern`), or gulp/npm packaging targets (`mode=packaging`). Not a live API catalog (`list_catalog`) and not grep (`search_code`). Example: `chapter=pitfalls` vs `query='SettingsApi'` when chapter is omitted; omit both for the TOC; `lang` is en (default) or ru; `pattern` requires the `pattern` enum; unknown chapter → error listing known ids. Snapshot-only; `packaging` reads gulpfile.js / package scripts — it does not execute gulp or npm.",
      inputSchema: {
        mode: z
          .enum(["plugin_docs", "pattern", "packaging"])
          .describe(
            "plugin_docs=docs/en|ru; pattern=guide+live examples; packaging=gulp/npm targets."
          ),
        chapter: z
          .string()
          .optional()
          .describe("For plugin_docs: chapter id or alias (pitfalls, settings, player, 01–13)."),
        query: z
          .string()
          .optional()
          .describe(
            "For plugin_docs: search headings/body when chapter is omitted. Also used as fallback topic."
          ),
        lang: z
          .enum(["en", "ru"])
          .optional()
          .describe("For plugin_docs: docs language. Default en."),
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
          .optional()
          .describe("For mode=pattern: which development pattern to explain."),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async (args) => {
      if (args.mode === "packaging") return packagingGuide(config);
      if (args.mode === "pattern") {
        if (!args.pattern) {
          return fail(
            "mode=pattern requires pattern (iife-plugin, storage, settings, events, component, request, template, activity, player-hook, maker, controller, manifest-menu)."
          );
        }
        return explainPattern(config, args.pattern);
      }
      return pluginDocs(config, args.chapter, args.query, args.lang ?? "en");
    }
  );
}

async function grepChecks(
  config: Config,
  checks?: Array<
    "todos" | "console_logs" | "undefined_refs" | "missing_lang_keys" | "hardcoded_strings"
  >
) {
  const all = [
    "todos",
    "console_logs",
    "undefined_refs",
    "missing_lang_keys",
    "hardcoded_strings",
  ] as const;
  const toRun = checks ?? [...all];
  const results: string[] = [];

  if (toRun.includes("todos")) {
    const hits = (await searchCode(config.fs, "TODO", ["*.js", "*.ts"], false)).slice(0, 20);
    results.push(
      `## TODOs (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
    );
  }
  if (toRun.includes("console_logs")) {
    const hits = (await searchCode(config.fs, "console.log", ["*.js", "*.ts"], false)).slice(0, 20);
    results.push(
      `## console.log (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
    );
  }
  if (toRun.includes("undefined_refs")) {
    const hits = (await searchCode(config.fs, "undefined", ["*.js"], false))
      .filter((h) => h.text.includes("=== undefined") || h.text.includes("== undefined"))
      .slice(0, 15);
    results.push(
      `## Loose undefined checks (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
    );
  }
  if (toRun.includes("missing_lang_keys")) {
    const { missing, enKeyCount, langDir } = await findMissingLangKeys(config.fs);
    const sample = missing.slice(0, 30);
    results.push(
      `## Missing translation keys (${missing.length} of ${enKeyCount} en.js keys used in code)\n` +
        `Reference: ${langDir}/en.js\n` +
        (sample.length > 0
          ? sample.map((k) => `- \`${k}\``).join("\n") +
            (missing.length > 30
              ? `\n… and ${missing.length - 30} more. Use mode=i18n without key for full coverage.`
              : "")
          : "All Lang.translate() keys found in en.js.")
    );
  }
  if (toRun.includes("hardcoded_strings")) {
    const hits = (await searchCode(config.fs, 'innerHTML = "', ["*.js"], false)).slice(0, 10);
    results.push(
      `## Hardcoded innerHTML strings (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
    );
  }
  return ok(results.join("\n\n"));
}

async function buildHint(config: Config, goal: "build" | "dev" | "test" | "doc" | "lint") {
  const pkg = await readFileSafe(config.fs, "package.json");
  if (!pkg) return fail("No package.json found.");
  const data = parseJsonSafe<{ scripts?: Record<string, string> }>(pkg) ?? {};
  const scripts: Record<string, string> = data.scripts ?? {};

  if (goal === "dev") {
    const lines = [
      `# Lampa local development (plugin docs ch.12)`,
      ``,
      `This returns a command hint only — it does not run the build.`,
      ``,
      scripts.start
        ? `- \`npm run start\` → ${scripts.start}  (watch + BrowserSync, typically http://localhost:3000)`
        : "- `npm run start` — not in package.json; check gulpfile.js",
      scripts.debug ? `- \`npm run debug\` → ${scripts.debug}` : "",
      scripts.watch ? `- \`npm run watch\` → ${scripts.watch}` : "",
      ``,
      `Platform browser is detected automatically. Load a remote plugin via Settings → Extensions.`,
    ].filter(Boolean);
    return ok(lines.join("\n"));
  }

  const candidates: Record<string, string[]> = {
    build: ["build", "compile", "bundle"],
    dev: ["dev", "start", "watch", "serve"],
    test: ["test", "spec"],
    doc: ["doc", "docs", "jsdoc"],
    lint: ["lint", "eslint"],
  };
  const matches = candidates[goal]
    .map((k) => (scripts[k] ? `npm run ${k}  →  ${scripts[k]}` : null))
    .filter((v): v is string => v !== null);

  if (matches.length === 0) {
    const gulpFile = await fileExists(config.fs, "gulpfile.js");
    if (gulpFile && goal === "build") {
      return ok("No npm build script found, but gulpfile.js is present. Try: gulp");
    }
    return ok(`No "${goal}" script found. Available scripts: ${Object.keys(scripts).join(", ")}`);
  }
  return ok(
    [`This returns a command hint only — it does not run the build.`, ``, ...matches].join("\n")
  );
}

async function validatePlugin(config: Config, plugin: string) {
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
    return fail(`Plugin "${plugin}" not found.\nAvailable: ${available}`);
  }

  const content = (await readFileSafe(config.fs, targetFile)) ?? "";
  const rel = targetFile;
  const lines = content.split("\n");
  const jqueryAppready = /\$\(\s*document\s*\)\.on\(\s*['"]appready['"]/.test(content);
  const listenerReady =
    /Listener\.follow\(\s*['"]app['"]/.test(content) &&
    /e\.type\s*==\s*['"]ready['"]/.test(content);
  const hasAppreadyFlag = /\bwindow\.appready\b/.test(content) || /\bappready\b/.test(content);
  const hasGuard =
    /window\.\w+_ready/.test(content) && /if\s*\(\s*!window\.\w+_ready/.test(content);
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
    (/Lang\.add\s*\(/.test(content) && /(?:ru\s*:)/.test(content) && /(?:en\s*:)/.test(content));

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
      fix: "Wrap the plugin in a uniquely named start function or an IIFE.",
    },
    {
      name: "Double-load guard (`window.<plugin>_ready`)",
      pass: hasGuard,
      severity: "error",
      fix: "Set `window.my_plugin_ready = true` inside start, then `if (!window.my_plugin_ready) startMyPlugin()`.",
    },
    {
      name: "Bootstraps on Listener app:ready (not jQuery appready)",
      pass:
        listenerReady || (hasAppreadyFlag && /window\.appready/.test(content) && !jqueryAppready),
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
      fix: "Extend with `Lampa.Arrays.extend(window.lampa_settings, { … })`.",
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
      fix: "Use `$(el).on('hover:enter', handler)`.",
    },
    {
      name: "Uses SettingsApi (not Lampa.Settings.add)",
      pass: !usesSettingsAdd || usesSettingsApi,
      severity: "warn",
      fix: "Prefer `Lampa.SettingsApi.addComponent` / `addParam`.",
    },
    {
      name: "Lang.add includes ru and en",
      pass: langHasRuEn,
      severity: "warn",
      fix: "Always pass at least `ru` and `en` in Lampa.Lang.add.",
    },
    {
      name: "CSS injection happens inside init()",
      pass: !cssAppend || cssInInit,
      severity: "warn",
      fix: "Append plugin `<style>` templates inside init() after app:ready.",
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

  return ok(
    [
      `# Plugin Validation: ${rel}`,
      `**Score:** ${score}% (${passed.length}/${checks.length} checks passed)`,
      `**Lines:** ${lines.length}`,
      ``,
      `## Results`,
      ...checks.map((c) => {
        const icon = c.pass
          ? "PASS"
          : c.severity === "error"
            ? "FAIL"
            : c.severity === "warn"
              ? "WARN"
              : "INFO";
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
      .join("\n")
  );
}

async function pluginDocs(
  config: Config,
  chapter: string | undefined,
  query: string | undefined,
  locale: PluginDocsLang
) {
  if (chapter) {
    const found = await readPluginChapter(config.fs, config.pluginDocsPath, chapter, locale);
    if (!found) {
      const aliases = PLUGIN_DOC_CHAPTERS.map((c) => `${c.id} (${c.aliases[0]})`).join(", ");
      return fail(`Chapter "${chapter}" not found under docs/${locale}. Known: ${aliases}`);
    }
    return ok(`# ${found.path}\n\n${found.text}`);
  }
  if (query) {
    const mapped = resolveChapter(query);
    if (mapped) {
      const found = await readPluginChapter(config.fs, config.pluginDocsPath, mapped.id, locale);
      if (found) return ok(`# ${found.path}\n\n${found.text}`);
    }
    const hits = await searchPluginDocs(config.fs, config.pluginDocsPath, query, locale);
    if (hits.length === 0) {
      const extras: string[] = [];
      for (const src of ["UPGRADE.md", "README.md"]) {
        if (!(await fileExists(config.fs, src))) continue;
        const content = (await readFileSafe(config.fs, src)) ?? "";
        const lines = content.split("\n");
        const extraHits: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            const ctx = lines
              .slice(Math.max(0, i - 1), i + 3)
              .join("\n")
              .trim();
            if (ctx.length > 5) extraHits.push(`L${i + 1}: ${ctx.slice(0, 200)}`);
          }
        }
        if (extraHits.length > 0)
          extras.push(`### ${basename(src)}\n${extraHits.slice(0, 6).join("\n")}`);
      }
      if (extras.length > 0) return ok(extras.join("\n\n"));
      return ok(
        `No plugin-docs hits for "${query}" in docs/${locale}. Try chapter=pitfalls or resource lampa://plugin-guide.`
      );
    }
    return ok(formatDocHits(hits));
  }
  return ok(await formatPluginGuideToc(config.fs, config.pluginDocsPath, locale));
}

async function packagingGuide(config: Config) {
  const targets = await extractPlatformTargets(config.fs);
  const pkg = await readFileSafe(config.fs, "package.json");
  let scripts = "";
  if (pkg) {
    const data = parseJsonSafe<{ scripts?: Record<string, string> }>(pkg) ?? {};
    scripts = Object.entries(data.scripts ?? {})
      .map(([k, v]) => `- \`npm run ${k}\` → ${v}`)
      .join("\n");
  }
  const rows = targets.map(
    (t) => `| \`${t.gulpTask}\` | \`${t.outputDir}\` | \`${t.indexShell}\` | ${t.description} |`
  );
  return ok(
    [
      `# Lampa Platform Packaging Guide`,
      ``,
      `Read-only: this does not run gulp.`,
      ``,
      `## NPM scripts`,
      scripts || "No package.json scripts found.",
      ``,
      `## Gulp targets`,
      `| Task | Output | Index shell | Description |`,
      `|------|--------|-------------|-------------|`,
      ...rows,
      ``,
      `Pipeline: src/app.js + plugins → Rollup/Babel → dest/ → uglify → build/{web,webos,tizen,github}/`,
    ].join("\n")
  );
}

type PatternId =
  | "iife-plugin"
  | "storage"
  | "settings"
  | "events"
  | "component"
  | "request"
  | "template"
  | "activity"
  | "player-hook"
  | "maker"
  | "controller"
  | "manifest-menu";

async function explainPattern(config: Config, pattern: PatternId) {
  const patterns: Record<
    PatternId,
    { title: string; description: string; searchFor: string; searchIn: string; keyPoints: string[] }
  > = {
    "iife-plugin": {
      title: "Plugin start + app:ready Pattern",
      description:
        "Plugins are script-injected IIFEs/start functions using window.Lampa. Official bootstrap is Lampa.Listener app:ready, plus a unique global double-load guard.",
      searchFor: "Listener.follow('app'",
      searchIn: "plugins",
      keyPoints: [
        "- Unique guard: `window.my_plugin_ready = true` then `if (!window.my_plugin_ready) startMyPlugin()`",
        "- Bootstrap: `if (window.appready) init(); else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })`",
        "- Do NOT use `$(document).on('appready', init)`",
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
        "- SettingsApi params: `Lampa.Storage.field('myplugin_quality')`",
        "- Prefix keys: `myplugin_token` — never generic `token`",
      ],
    },
    settings: {
      title: "Lampa.SettingsApi Pattern",
      description: "Plugins add a Settings section with SettingsApi.addComponent + addParam.",
      searchFor: "SettingsApi.addComponent",
      searchIn: "plugins",
      keyPoints: [
        "- Section: `Lampa.SettingsApi.addComponent({ component, name, icon })`",
        "- Param: `SettingsApi.addParam({ component, param: { name, type, default }, field, onChange })`",
        "- Read: `Lampa.Storage.field(param.name)`",
        "- Register inside init() after app:ready",
      ],
    },
    events: {
      title: "Event buses (Listener, Player, Storage, Favorite, Keypad)",
      description: "Subscribe with .follow(type, namedFn) and always .remove(type, namedFn).",
      searchFor: "Lampa.Listener.follow(",
      searchIn: "plugins",
      keyPoints: [
        "- App-wide: `Lampa.Listener.follow('app'|'activity'|'full'|'line'|'torrent_file', fn)`",
        "- Player: `Lampa.Player.listener.follow(...)` — not Listener.follow('player')",
        "- Store handlers in named variables — anonymous functions cannot be removed",
      ],
    },
    component: {
      title: "Component lifecycle contract",
      description:
        "Activity calls create (must return DOM), start (focus), stop (covered), destroy (cleanup), render.",
      searchFor: "this.create",
      searchIn: "src/components",
      keyPoints: [
        "- create() must return a DOM/jQuery root synchronously",
        "- start() — register Controller.add('content', …) and toggle",
        "- destroy() — inited=false, network.clear(), remove listeners",
      ],
    },
    request: {
      title: "Lampa.Reguest Network Pattern",
      description:
        "jQuery-ajax wrapper. One instance per component. Note the historical spelling Reguest.",
      searchFor: "new Lampa.Reguest",
      searchIn: "plugins",
      keyPoints: [
        "- `var network = new Lampa.Reguest(); network.timeout(15000)`",
        "- Guard late callbacks with `inited`; `network.clear()` in destroy()",
      ],
    },
    template: {
      title: "Lampa.Template + Lang Pattern",
      description: "Named HTML strings with {key} placeholders and #{lang_key} i18n.",
      searchFor: "Lampa.Template.add(",
      searchIn: "plugins",
      keyPoints: [
        "- `Lampa.Template.add('my_card', '<div>{title} #{my_label}</div>')`",
        "- Inject CSS inside init(): `$('body').append(Template.get('my_css', {}, true))`",
      ],
    },
    activity: {
      title: "Lampa.Activity Navigation Pattern",
      description: "Stack navigation. Activity.push adds a screen; back pops.",
      searchFor: "Lampa.Activity.push",
      searchIn: "plugins",
      keyPoints: [
        "- `Activity.push({ url, title, component, page, …custom })`",
        "- Listen: `Lampa.Listener.follow('activity', fn)` — not Activity.listener",
      ],
    },
    "player-hook": {
      title: "Player + PlayerVideo Hook Pattern",
      description:
        "Use Player.listener for lifecycle and PlayerVideo.listener for the media element.",
      searchFor: "Player.listener.follow",
      searchIn: "plugins",
      keyPoints: [
        "- `Lampa.Player.listener.follow('start', onStart)`",
        "- destroy must remove all PlayerVideo handlers",
      ],
    },
    maker: {
      title: "Lampa.Maker Modular Component Pattern (3.0)",
      description:
        "Lampa 3.0 replaced monolithic Interaction* classes with composable Maker modules.",
      searchFor: "Lampa.Maker.make(",
      searchIn: "src",
      keyPoints: [
        "- Create: `Lampa.Maker.make('Main', data, (m) => m.toggle(m.MASK.base, 'Callback'))`",
        "- Guard: `if (Lampa.Manifest.app_digital >= 300)`",
        "- Use list_catalog topic=maker and trace_symbol mode=upgrade",
      ],
    },
    controller: {
      title: "Controller & TV navigation",
      description: "One named controller owns the remote at a time.",
      searchFor: "Controller.add(",
      searchIn: "src",
      keyPoints: [
        "- Register in start(): `Lampa.Controller.add('content', { toggle, left, right, up, down, back })`",
        "- Use jQuery `el.on('hover:enter'|…)` — not addEventListener",
      ],
    },
    "manifest-menu": {
      title: "Manifest context menu & sidebar",
      description: "type:'video' manifests appear on long-press card menus.",
      searchFor: "Manifest.plugins",
      searchIn: "plugins",
      keyPoints: [
        "- `Lampa.Manifest.plugins = { type:'video', onContextMenu, onContextLauch }`",
        "- Sidebar: `$('.menu .menu__list').eq(0).append(btn)` with hover:enter → Activity.push",
      ],
    },
  };

  const meta = patterns[pattern];
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
    examples.push(
      `### From \`${hit.file}\` (line ${hit.line})\n\`\`\`javascript\n${fileLines.slice(start, end).join("\n")}\n\`\`\``
    );
  }
  return ok(
    [
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
      `Use search_code with query \`${meta.searchFor}\` for more instances.`,
    ].join("\n")
  );
}
