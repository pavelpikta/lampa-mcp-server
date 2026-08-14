import type { RepoFs } from "../fs/types.js";
import { joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe } from "./fs.js";
import { searchCode } from "./search.js";

/** Correct landmark paths for Lampa v3 (edit src/ + plugins/, not public/build). */
export const LAMPA_FEATURE_MAP: Record<string, string[]> = {
  player: [
    "src/interaction/player.js",
    "src/interaction/player",
    "src/components/full.js",
    "plugins/tracks",
    "plugins/record",
  ],
  catalog: [
    "src/components/main.js",
    "src/components/category.js",
    "src/components/feed.js",
    "src/core/content_rows.js",
  ],
  search: ["src/interaction/search", "src/components/main.js"],
  settings: [
    "src/interaction/settings/settings.js",
    "src/interaction/settings/api.js",
    "src/interaction/settings/params.js",
    "plugins/iptv/settings.js",
  ],
  cards: [
    "src/interaction/card",
    "src/interaction/maker.js",
    "src/templates",
    "src/components/full.js",
  ],
  parser: ["plugins/online", "plugins/online_prestige", "plugins/etor"],
  bookmarks: [
    "src/core/favorite.js",
    "src/core/account/bookmarks.js",
    "src/components/bookmarks.js",
    "src/components/favorite.js",
  ],
  torrents: ["src/components/torrents.js", "src/components/mytorrents.js", "plugins/dlna"],
  iptv: ["plugins/iptv", "src/interaction/player/iptv.js"],
  episodes: ["src/components/episodes.js", "spec/episodes_parser.spec.js"],
  seasons: ["src/components", "spec/seasons_parser.spec.js"],
  translations: ["src/lang", "src/lang/meta.js"],
  styles: ["src/sass", "plugins"],
  plugins: ["plugins", "src/core/plugins.js"],
  api: ["src/core/api", "src/core/api/sources", "plugins/tmdb_proxy", "plugins/online"],
  ui: ["src/templates", "src/core/component.js", "src/interaction"],
  navigation: [
    "src/interaction/activity/activity.js",
    "src/core/controller.js",
    "src/core/router.js",
  ],
  notifications: ["src/interaction/notice", "src/core"],
  maker: ["src/interaction/maker.js", "src/utils/mask.js", "src/utils/emit.js", "UPGRADE.md"],
  account: ["src/core/account", "src/core/socket.js", "src/core/manifest.js"],
  sync: ["src/core/socket.js", "src/core/account/bookmarks.js", "src/core/account/timeline.js"],
  content_rows: ["src/core/content_rows.js", "src/core/favorite.js"],
  mirrors: ["src/core/manifest.js", "src/core/mirrors.js"],
  ai: ["src/core/api/sources/ai.js"],
  router: ["src/core/router.js", "src/interaction/activity"],
  full: ["src/components/full.js"],
  template: ["src/interaction/template.js", "src/templates"],
};

export const LAMPA_LANDMARKS: { path: string; role: string }[] = [
  { path: "docs/en/README.md", role: "Official plugin development guide (TOC + cheatsheet)" },
  { path: "docs/en/11-pitfalls.md", role: "Plugin anti-patterns agents must not emit" },
  { path: "src/app.js", role: "Bootstrap, window.Lampa export, boot sequence" },
  { path: "UPGRADE.md", role: "v3 Maker/params migration bible" },
  { path: "src/core/manifest.js", role: "Version, CUB domains/mirrors" },
  { path: "src/core/component.js", role: "Screen registry + Component.add" },
  { path: "src/core/router.js", role: "Named navigation → Activity" },
  { path: "src/core/plugins.js", role: "Plugin load/cache/blacklist" },
  { path: "src/core/storage/storage.js", role: "Persistence API" },
  { path: "src/core/platform.js", role: "Platform detection" },
  { path: "src/core/account/account.js", role: "CUB account surface" },
  { path: "src/core/socket.js", role: "Live sync WebSocket" },
  { path: "src/core/api/api.js", role: "API facade" },
  { path: "src/core/content_rows.js", role: "Plugin-injectable home rows" },
  { path: "src/interaction/maker.js", role: "Modular Maker class factory" },
  { path: "src/utils/emit.js", role: "Emit composition primitives" },
  { path: "src/utils/mask.js", role: "Maker module bitmasks" },
  { path: "src/utils/subscribe.js", role: "Subscribe event bus primitive" },
  { path: "src/interaction/activity/activity.js", role: "Navigation stack + activity events" },
  { path: "src/interaction/settings/settings.js", role: "Settings system" },
  { path: "src/interaction/settings/api.js", role: "SettingsApi for plugins" },
  { path: "src/interaction/template.js", role: "Template registry" },
  { path: "src/interaction/player.js", role: "Playback entry + Player.listener" },
  { path: "src/components/full.js", role: "Full-card UI; full event for plugins" },
  { path: "src/lang/meta.js", role: "Locale metadata" },
  { path: "src/lang/en.js", role: "English translation source of truth" },
  { path: "gulpfile.js", role: "Build pipeline and pack tasks" },
  { path: "plugins/online/online.js", role: "Canonical plugin: Component + full + settings" },
  { path: "plugins/tracks/tracks.js", role: "Canonical Player.listener plugin" },
];

export const LAMPA_EDIT_RULES = `# Lampa edit rules

## Edit these (source of truth)
- \`src/**\` — app JS, templates, lang, sass, core, interaction, components
- \`plugins/<name>/**\` — plugin IIFE sources (and plugin css/scss)
- \`index/{web,webos,tizen,github}/**\` — platform packaging overlays only when packaging
- \`gulpfile.js\`, \`package.json\` — build config

## Do NOT edit (generated / copies / outputs)
- \`public/lang/**\` — copied from \`src/lang\` by gulp
- \`public/css/**\` — compiled from \`src/sass\`
- \`dest/**\`, \`build/**\` — gulp outputs (often gitignored)
- Vendored \`public/vender/**\` unless intentionally updating a vendor

## Plugin conventions
- Plugins are runtime-loaded scripts using global \`Lampa.*\` (not ES imports into the app)
- Guard: \`window.<plugin>_ready\` + \`if (!window.<plugin>_ready) start…()\`
- Bootstrap: \`if (window.appready) init(); else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })\`
- Settings: \`SettingsApi.addComponent\` / \`addParam\`; read with \`Storage.field()\`
- Prefer v3: \`Maker\`, \`SettingsApi\`, \`ContentRows\`, \`Listener.follow\`
- Avoid: \`$(document).on('appready')\`, \`Lampa.Settings.add\`, \`InteractionMain\` / \`InteractionCategory\` / \`InteractionLine\`, flat \`Lampa.Card\` (see UPGRADE.md and \`docs/en/11-pitfalls.md\`)
`;

export const LAMPA_API_SURFACE_KEYS = [
  "Listener",
  "Lang",
  "Subscribe",
  "Storage",
  "Platform",
  "Utils",
  "Params",
  "Menu",
  "Head",
  "Notice",
  "Background",
  "Favorite",
  "Select",
  "Controller",
  "Activity",
  "Keypad",
  "Template",
  "Component",
  "Reguest",
  "Filter",
  "Files",
  "Explorer",
  "Scroll",
  "Empty",
  "Arrays",
  "Noty",
  "Player",
  "PlayerVideo",
  "PlayerInfo",
  "PlayerPanel",
  "PlayerFooter",
  "PlayerIPTV",
  "PlayerPlaylist",
  "Timeline",
  "Modal",
  "Api",
  "Settings",
  "SettingsApi",
  "Android",
  "Card",
  "Info",
  "Account",
  "Socket",
  "Input",
  "Screensaver",
  "Recomends",
  "TimeTable",
  "Broadcast",
  "Helper",
  "InteractionMain",
  "InteractionCategory",
  "InteractionLine",
  "Status",
  "Plugins",
  "Extensions",
  "Tizen",
  "Layer",
  "Console",
  "Iframe",
  "Parser",
  "Manifest",
  "TMDB",
  "Base64",
  "Loading",
  "YouTube",
  "WebOSLauncher",
  "Event",
  "Search",
  "DeviceInput",
  "Worker",
  "DB",
  "NavigationBar",
  "Endless",
  "Color",
  "Cache",
  "Torrent",
  "Torserver",
  "Speedtest",
  "Processing",
  "ParentalControl",
  "VPN",
  "Bell",
  "StorageMenager",
  "RemoteHelper",
  "Network",
  "Maker",
  "MaskHelper",
  "ContentRows",
  "Emit",
  "Router",
  "Timer",
];

export type EditPathKind =
  "lang" | "sass" | "template" | "component" | "plugin" | "core" | "interaction" | "settings";

export function resolveEditPath(
  kind: EditPathKind,
  name?: string
): { authoritative: string[]; avoid: string[]; notes: string } {
  switch (kind) {
    case "lang":
      return {
        authoritative: name
          ? [`src/lang/${name}.js`, "src/lang/meta.js"]
          : ["src/lang/", "src/lang/meta.js"],
        avoid: ["public/lang/", "build/"],
        notes: "Edit src/lang only. public/lang is a gulp copy.",
      };
    case "sass":
      return {
        authoritative: ["src/sass/"],
        avoid: ["public/css/", "build/"],
        notes: "Edit src/sass; CSS is compiled to public/css.",
      };
    case "template":
      return {
        authoritative: name
          ? [`src/templates/${name}.js`, "src/interaction/template.js"]
          : ["src/templates/", "src/interaction/template.js"],
        avoid: ["public/", "build/"],
        notes: "Core templates live under src/templates. Plugins use Template.add at runtime.",
      };
    case "component":
      return {
        authoritative: name
          ? [`src/components/${name}.js`, "src/core/component.js"]
          : ["src/components/", "src/core/component.js"],
        avoid: ["build/", "dest/"],
        notes: "Screens are src/components/* registered via Component.add.",
      };
    case "plugin":
      return {
        authoritative: name
          ? [`plugins/${name}/`, `plugins/${name}/${name}.js`]
          : ["plugins/", "src/core/plugins.js"],
        avoid: ["public/", "build/", "dest/"],
        notes: "Plugin sources under plugins/<id>/. Loaded at runtime by core/plugins.js.",
      };
    case "core":
      return {
        authoritative: name ? [`src/core/${name}`] : ["src/core/"],
        avoid: ["public/", "build/"],
        notes: "Core platform, API, account, storage, plugins loader.",
      };
    case "interaction":
      return {
        authoritative: name ? [`src/interaction/${name}`] : ["src/interaction/"],
        avoid: ["public/", "build/"],
        notes: "UI runtime: Activity, Player, Settings, Maker, Template, Card.",
      };
    case "settings":
      return {
        authoritative: [
          "src/interaction/settings/settings.js",
          "src/interaction/settings/api.js",
          "src/interaction/settings/params.js",
        ],
        avoid: ["src/components/settings", "src/core/settings", "public/"],
        notes: "Modern settings live in src/interaction/settings/*. Use SettingsApi from plugins.",
      };
    default:
      return {
        authoritative: ["src/", "plugins/"],
        avoid: ["public/lang", "public/css", "build/", "dest/"],
        notes: "Prefer src/ and plugins/.",
      };
  }
}

export const LAMPA_RISKY_PATTERNS = [
  {
    pattern: "Lampa.Storage",
    reason: "Persisted user storage — changes can break saved user data",
  },
  {
    pattern: "Lampa.Listener",
    reason: "Global event bus — removing/renaming events breaks decoupled modules",
  },
  {
    pattern: "Lampa.Template",
    reason: "Shared UI templates — visual regressions across all views",
  },
  { pattern: "Lampa.Lang", reason: "Translation keys — missing keys cause blank UI text" },
  {
    pattern: "Lampa.Settings",
    reason: "Settings registration — order and key naming must stay stable",
  },
  {
    pattern: "Lampa.Activity",
    reason: "Navigation stack — wrong activity pushes break back-navigation",
  },
  {
    pattern: "Lampa.Controller",
    reason: "Input controller — remotes and key bindings depend on this",
  },
  {
    pattern: "Lampa.Scroll",
    reason: "Shared scroll logic — affects focus and navigation in every list",
  },
  {
    pattern: "Lampa.Api",
    reason: "Central API facade — provider contracts depend on this interface",
  },
  {
    pattern: "Lampa.Player",
    reason: "Video playback core — regressions here affect every playback path",
  },
];

export async function inferFeatureFiles(fs: RepoFs, featureName: string): Promise<string[]> {
  const lower = featureName.toLowerCase();
  const hits: string[] = [];

  for (const [key, paths] of Object.entries(LAMPA_FEATURE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) {
      for (const p of paths) {
        hits.push(p);
      }
    }
  }

  const allFiles = await listFilesRecursive(fs, "", [".js", ".ts", ".scss", ".css"]);
  for (const rel of allFiles) {
    if (rel.toLowerCase().includes(lower) && !hits.includes(rel)) {
      hits.push(rel);
    }
  }

  // Prefer existing paths only when they are real files/dirs
  const existing: string[] = [];
  for (const h of hits) {
    if (await fs.exists(h)) existing.push(h);
    else existing.push(h); // keep map hints even if prefix dirs
  }

  return [...new Set(existing)];
}

export async function detectRisks(fs: RepoFs, files: string[]): Promise<string[]> {
  const warnings: string[] = [];

  for (const relFile of files) {
    const content = await readFileSafe(fs, relFile);
    if (!content) continue;

    for (const { pattern, reason } of LAMPA_RISKY_PATTERNS) {
      if (content.includes(pattern)) {
        warnings.push(`${relFile} uses ${pattern} — ${reason}`);
      }
    }
  }

  return [...new Set(warnings)];
}

export async function findSettingsInRepo(fs: RepoFs, keyword?: string): Promise<string> {
  const patterns = [
    "Lampa.Settings.add",
    "SettingsApi.addComponent",
    "SettingsApi.addParam",
    "Lampa.SettingsApi.add",
    "Lampa.Settings.get",
    "Lampa.Storage.get",
    "Lampa.Storage.set",
    "settings_default",
  ];

  const lines: string[] = [];
  for (const pat of patterns) {
    if (keyword && !pat.toLowerCase().includes(keyword.toLowerCase())) continue;
    const matches = await searchCode(fs, pat, ["*.js"], false, "src");
    const pluginMatches = await searchCode(fs, pat, ["*.js"], false, "plugins");
    for (const m of [...matches, ...pluginMatches].slice(0, 10)) {
      lines.push(`${m.file}:${m.line}  ${m.text}`);
    }
  }
  if (keyword) {
    const keyed = await searchCode(fs, keyword, ["*.js"], false, "src");
    for (const m of keyed.slice(0, 10)) {
      lines.push(`${m.file}:${m.line}  ${m.text}`);
    }
  }
  return lines.join("\n") || "No settings patterns found.";
}

export async function findApiCallsInRepo(fs: RepoFs, provider?: string): Promise<string> {
  const patterns = ["Lampa.Api", "Lampa.Network", "new Reguest", "fetch(", "$.ajax"];
  const providerPrefix = provider ? joinRepo("plugins", provider).toLowerCase() : null;

  const lines: string[] = [];
  for (const pat of patterns) {
    const matches = await searchCode(fs, pat, ["*.js"], false, providerPrefix ? undefined : "src");
    const more = providerPrefix
      ? await searchCode(fs, pat, ["*.js"], false, "plugins")
      : await searchCode(fs, pat, ["*.js"], false, "plugins");
    for (const m of [...matches, ...more].slice(0, 8)) {
      if (
        !providerPrefix ||
        m.file.toLowerCase().startsWith(providerPrefix) ||
        m.file.toLowerCase().includes(provider!.toLowerCase())
      ) {
        lines.push(`${m.file}:${m.line}  ${m.text}`);
      }
    }
  }
  return lines.join("\n") || "No API call patterns found.";
}

export function formatSettingsIndex(indexed: unknown): string {
  if (typeof indexed === "string") return indexed;
  if (indexed && typeof indexed === "object" && "hits" in indexed) {
    const hits = (indexed as { hits: { file: string; component?: string; key?: string }[] }).hits;
    return hits
      .slice(0, 200)
      .map((h) => `${h.file}  ${h.component ?? h.key ?? ""}`)
      .join("\n");
  }
  return JSON.stringify(indexed, null, 2);
}

export function formatApiIndex(indexed: unknown): string {
  if (typeof indexed === "string") return indexed;
  if (indexed && typeof indexed === "object" && "hits" in indexed) {
    const hits = (indexed as { hits: { file: string; line?: number; text?: string }[] }).hits;
    return hits
      .slice(0, 200)
      .map((h) => `${h.file}${h.line ? `:${h.line}` : ""}  ${h.text ?? ""}`)
      .join("\n");
  }
  return JSON.stringify(indexed, null, 2);
}
