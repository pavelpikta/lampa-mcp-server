import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists } from "../utils/fs.js";
import { findSettingsInRepo, formatSettingsIndex } from "../utils/lampa.js";
import { extractProviderInfo } from "../utils/lampa_deep.js";
import {
  extractMakerClasses,
  extractSocketProtocol,
  extractComponentRegistry,
  extractLampaSettingsFlags,
  extractContentRows,
  extractFavoriteCategories,
  extractManifestMirrors,
} from "../utils/lampa_modern.js";
import { READ_ONLY_SNAPSHOT, fail, ok, reportOutput } from "./meta.js";

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

const MAP_TOPICS = [
  "api_surface",
  "events",
  "storage",
  "network",
  "settings",
  "providers",
  "maker",
  "socket",
  "activity",
  "flags",
  "content_rows",
  "favorites",
  "mirrors",
] as const;

export function registerAnalysisTools(server: McpServer, config: Config): void {
  server.registerTool(
    "list_catalog",
    {
      title: "Catalog Lampa APIs and indexes",
      description:
        "Dump one static catalog from the Lampa snapshot per call. Returns markdown text, not JSON, with no performance cost beyond one tree walk. Not a query (`search_code`), not a single-symbol walk (`trace_symbol`), not written docs (`explain_docs`), and not a live CUB client (`guide_cub`).\n`scope` applies only to api_surface/events/storage (default all); `detail=true` only affects events; `query` is a plain substring filter (module name, event name, storage key, component name, flag keyword, or network folder) within the chosen topic — never a repo-wide search.\nExample: `topic=events` `query='player'` `detail=true`. Empty catalog → markdown, not an error; on R2, full-tree events/storage need a prebuilt index — pass `query` or a narrower topic (e.g. maker, socket, flags, content_rows, favorites, mirrors) if the index is missing.",
      inputSchema: {
        topic: z
          .enum(MAP_TOPICS)
          .describe(
            "Which catalog: api_surface | events | storage | network | settings | providers | maker | socket | activity | flags | content_rows | favorites | mirrors."
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Filter the chosen catalog only (not a repo-wide search): API module, event name, storage key, component name, flag keyword, or folder (for network)."
          ),
        scope: z
          .enum(["all", "plugins", "src"])
          .optional()
          .describe("For api_surface, events, storage: limit the tree. Default all."),
        detail: z
          .boolean()
          .optional()
          .describe("For topic=events: include per-file listener/emitter lists. Default false."),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ topic, query, scope = "all", detail = false }) => {
      switch (topic) {
        case "settings":
          return mapSettings(config, query);
        case "api_surface":
          return mapApiSurface(config, query, scope);
        case "events":
          return mapEvents(config, scope, detail, query);
        case "storage":
          return mapStorage(config, scope, query);
        case "network":
          return mapNetwork(config, query);
        case "providers":
          return mapProviders(config);
        case "maker":
          return mapMaker(config, query);
        case "socket":
          return mapSocket(config);
        case "activity":
          return mapActivity(config, query);
        case "flags":
          return mapFlags(config, query);
        case "content_rows":
          return mapContentRows(config);
        case "favorites":
          return mapFavorites(config);
        case "mirrors":
          return mapMirrors(config);
        default:
          return fail(`Unknown topic. Use one of: ${MAP_TOPICS.join(", ")}`);
      }
    }
  );
}

async function mapSettings(config: Config, keyword?: string) {
  const indexed = await config.fs.readIndex?.("settings-catalog");
  if (indexed != null && !keyword) {
    return ok(formatSettingsIndex(indexed));
  }
  return ok(await findSettingsInRepo(config.fs, keyword));
}

async function mapApiSurface(config: Config, mod?: string, scope = "all") {
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
    return ok(
      mod
        ? `No usage of Lampa.${mod} found in scope "${scope}".`
        : `No Lampa.* usage found in scope "${scope}".`
    );
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
    return `## Lampa.${modName}  *(${files.size} file${files.size > 1 ? "s" : ""})*\n${methodList}`;
  });
  return ok([header, "", ...sections].join("\n"));
}

async function mapEvents(config: Config, scope = "all", detail = false, query?: string) {
  const indexed = await config.fs.readIndex?.("events");
  if (indexed != null && scope === "all" && !detail && !query) {
    return ok(indexText(indexed));
  }
  if (indexed == null && isR2Backend(config) && scope === "all") {
    return ok(
      [
        `# Events index missing`,
        ``,
        `Full-tree event scans are disabled on R2 backends without a prebuilt index.`,
        `Pass scope=src or scope=plugins, or use trace_symbol mode=event for one event.`,
      ].join("\n")
    );
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

  let sorted = Object.entries(events).sort(([, a], [, b]) => {
    const ta = a.listeners.length + a.emitters.length;
    const tb = b.listeners.length + b.emitters.length;
    return tb - ta;
  });
  if (query) {
    const q = query.toLowerCase();
    sorted = sorted.filter(([evt]) => evt.toLowerCase().includes(q));
  }
  const rows = [
    `# Lampa Event Bus  (scope: ${scope}, ${sorted.length} distinct event${sorted.length > 1 ? "s" : ""})`,
    ``,
    `| Event | Listeners | Emitters | Status |`,
    `|-------|-----------|---------|--------|`,
    ...sorted.map(([evt, { listeners, emitters }]) => {
      const status =
        emitters.length === 0
          ? "no emitter found"
          : listeners.length === 0
            ? "no listener found"
            : "ok";
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
  return ok(rows.join("\n"));
}

async function mapStorage(config: Config, scope = "all", key?: string) {
  const indexed = await config.fs.readIndex?.("storage-schema");
  if (indexed != null && scope === "all" && !key) {
    return ok(indexText(indexed));
  }
  if (indexed == null && isR2Backend(config) && scope === "all" && !key) {
    return ok(
      [
        `# Storage schema index missing`,
        ``,
        `Full-tree Storage scans are disabled on R2 without a prebuilt index.`,
        `Pass scope=src or scope=plugins, or query=<storage_key>.`,
      ].join("\n")
    );
  }

  const searchRoot = scope === "plugins" ? "plugins" : scope === "src" ? "src" : "";
  const jsFiles = await listFilesRecursive(config.fs, searchRoot, [".js"]);
  const schema: Record<string, { defaults: Set<string>; readers: string[]; writers: string[] }> =
    {};

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
    return ok(
      key
        ? `Storage key '${key}' not found in scope '${scope}'.`
        : `No Lampa.Storage usage found in scope '${scope}'.`
    );
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
  return ok(rows.join("\n"));
}

async function mapNetwork(config: Config, scope?: string) {
  const searchRoot = scope ?? "plugins";
  if (!(await fileExists(config.fs, searchRoot))) {
    return fail(`Path not found: ${searchRoot}. Check with summarize_repo.`);
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
      if (!entry.urls.includes(m[1])) entry.urls.push(m[1]);
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
    return ok(`No URLs or network patterns found in: ${searchRoot}`);
  }
  const sections = entries.map(([file, { urls, proxies, embedVars }]) => {
    const lines = [`## ${file}`];
    if (embedVars.length > 0) lines.push(`**Base URL (embed):** \`${embedVars.join("`, `")}\``);
    if (proxies.length > 0) lines.push(`**Proxy names:** \`${proxies.join("`, `")}\``);
    if (urls.length > 0) lines.push(`**Other URLs:**`, ...urls.map((u) => `- \`${u}\``));
    return lines.join("\n");
  });
  return ok(
    [`# Network Map  (scope: ${searchRoot}, ${entries.length} files)`, ``, ...sections].join("\n\n")
  );
}

async function mapProviders(config: Config) {
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
    return ok(
      "No streaming providers found in plugins/online/ or plugins/online_prestige/balansers/."
    );
  }
  const providers = [];
  for (const f of providerFiles) {
    providers.push(await extractProviderInfo(config.fs, f));
  }
  const sections = providers.map((p) =>
    [
      `## ${p.name}`,
      `**File:** ${p.path}`,
      `**Base URL:** ${p.baseUrl ?? "*(not found — may use proxy or dynamic URL)*"}`,
      `**Public methods:** ${p.methods.length > 0 ? p.methods.join(", ") : "none detected"}`,
      `**Lampa APIs:** ${p.lampaApis.length > 0 ? p.lampaApis.join(", ") : "none"}`,
    ].join("\n")
  );
  return ok(
    [
      `# Lampa Streaming Providers (${providers.length})`,
      ``,
      sections.join("\n\n"),
      ``,
      `Use analyze_plugin with plugin=online or plugin=online_prestige for source analysis.`,
    ].join("\n")
  );
}

async function mapMaker(config: Config, className?: string) {
  const classes = await extractMakerClasses(config.fs);
  const filtered = className
    ? classes.filter((c) => c.name.toLowerCase() === className.toLowerCase())
    : classes;
  if (filtered.length === 0) {
    return ok(
      className
        ? `Maker class "${className}" not found. Available: ${classes.map((c) => c.name).join(", ")}`
        : "Maker system not found. Ensure src/interaction/maker.js exists."
    );
  }
  const maskPreview =
    (await readFileSafe(config.fs, "src/utils/mask.js"))?.split("\n").slice(0, 25).join("\n") ?? "";
  return ok(
    [
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
      ``,
      `## MaskHelper (src/utils/mask.js)`,
      `\`\`\`javascript`,
      maskPreview,
      `\`\`\``,
    ].join("\n")
  );
}

async function mapSocket(config: Config) {
  const proto = await extractSocketProtocol(config.fs);
  return ok(
    [
      `# Lampa WebSocket Protocol`,
      ``,
      `**URL pattern:** ${proto.urlPattern}`,
      `**Mirrors (soc_mirrors):** ${proto.mirrors.join(", ")}`,
      `**Gated by:** \`window.lampa_settings.socket_use\` and \`socket_methods\``,
      ``,
      `## Inbound methods (server → client)`,
      proto.inbound.map((m) => `- \`${m.method}\` — ${m.description}`).join("\n"),
      ``,
      `## Outbound methods (client → server)`,
      proto.outbound.map((m) => `- \`${m.method}\` — ${m.context}`).join("\n"),
      ``,
      `Every outbound message includes: device_id, name, method, version, account, premium, terminal.`,
    ].join("\n")
  );
}

async function mapActivity(config: Config, name?: string) {
  let registry = await extractComponentRegistry(config.fs);
  if (name) {
    const lower = name.toLowerCase();
    registry = registry.filter((r) => r.name.toLowerCase().includes(lower));
  }
  if (registry.length === 0) {
    return ok(
      name ? `No components/routes matching "${name}".` : "No component registrations found."
    );
  }
  const components = registry.filter((r) => r.type === "component");
  const routes = registry.filter((r) => r.type === "router");
  const fmt = (items: typeof registry) =>
    items.map((r) => `| \`${r.name}\` | ${r.type} | \`${r.file}\` | ${r.line} |`).join("\n");
  return ok(
    [
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
      `Navigate: \`Lampa.Activity.push({ component: 'name', ... })\` or \`Lampa.Router.call('route', data)\``,
    ].join("\n")
  );
}

async function mapFlags(config: Config, filter?: string) {
  let flags = await extractLampaSettingsFlags(config.fs);
  if (filter) {
    const lower = filter.toLowerCase();
    flags = flags.filter((f) => f.key.toLowerCase().includes(lower));
  }
  if (flags.length === 0) {
    return ok("lampa_settings not found in src/app.js.");
  }
  const rows = flags.map(
    (f) =>
      `| \`${f.key}\` | \`${f.defaultValue}\` | ${f.gates ?? (f.nested ? "disable_features sub-flag" : "—")} |`
  );
  return ok(
    [
      `# lampa_settings Feature Flags  (${flags.length})`,
      ``,
      `Defined in \`src/app.js\` via \`Arrays.extend(window.lampa_settings, {...})\``,
      ``,
      `| Flag | Default | Notes |`,
      `|------|---------|-------|`,
      ...rows,
    ].join("\n")
  );
}

async function mapContentRows(config: Config) {
  const rows = await extractContentRows(config.fs);
  if (rows.length === 0) return ok("No ContentRows.add registrations found.");
  const table = rows.map(
    (r) =>
      `| \`${r.name}\` | ${r.title ?? "—"} | ${r.screen.join(", ") || "—"} | \`${r.file}\`:${r.line} |`
  );
  return ok(
    [
      `# ContentRows Extension Points  (${rows.length})`,
      ``,
      `| name | title | screens | source |`,
      `|------|-------|---------|--------|`,
      ...table,
    ].join("\n")
  );
}

async function mapFavorites(config: Config) {
  const info = await extractFavoriteCategories(config.fs);
  if (!info) return fail("src/core/favorite.js not found.");
  return ok(
    [
      `# Favorite Category Schema`,
      ``,
      `**Source:** \`${info.file}\``,
      ``,
      `## All categories (${info.categories.length})`,
      info.categories.map((c) => `- \`${c}\``).join("\n"),
      ``,
      `## Timeline marks (${info.marks.length})`,
      info.marks.map((m) => `- \`${m}\``).join("\n"),
    ].join("\n")
  );
}

async function mapMirrors(config: Config) {
  const mirrors = await extractManifestMirrors(config.fs);
  return ok(
    [
      `# Lampa Manifest & Mirrors`,
      ``,
      `| Property | Value / logic |`,
      `|----------|--------------|`,
      ...Object.entries(mirrors).map(([k, v]) => `| \`${k}\` | ${v} |`),
      ``,
      `- cub_domain: localStorage.cub_domain or first cub_mirrors entry`,
      `- cub_mirrors: built-in list + user-added mirrors`,
      `- soc_mirrors: WebSocket hosts (may differ from HTTP)`,
    ].join("\n")
  );
}
