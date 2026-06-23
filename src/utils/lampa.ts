import path from "node:path";
import { listFilesRecursive, readFileSafe } from "./fs.js";
import { searchCode } from "./search.js";

// Well-known Lampa structural patterns
export const LAMPA_FEATURE_MAP: Record<string, string[]> = {
  player: ["src/core/player", "src/components/full", "plugins/record", "public/youtube.html"],
  catalog: ["src/components/main.js", "src/components/feed.js", "src/components/recomend.js"],
  search: ["src/core", "src/components/main.js"],
  settings: ["src/components/settings", "src/core/settings", "plugins/iptv/settings.js"],
  cards: ["src/templates", "src/core/card", "src/components/full"],
  parser: ["plugins/online", "plugins/online_prestige", "plugins/etor"],
  bookmarks: ["src/components/bookmarks.js", "src/components/favorite.js"],
  torrents: ["src/components/torrents.js", "src/components/mytorrents.js", "plugins/dlna"],
  iptv: ["plugins/iptv"],
  episodes: ["src/components/episodes.js", "spec/episodes_parser.spec.js"],
  seasons: ["src/components", "spec/seasons_parser.spec.js"],
  translations: ["public/lang", "src/lang", "plugins/iptv/lang.js"],
  styles: ["src/sass", "public/css", "plugins"],
  plugins: ["plugins"],
  api: ["src/services", "plugins/online", "plugins/tmdb_proxy"],
  ui: ["src/templates", "src/core/component.js", "src/interaction"],
  navigation: ["public/vender/navigator", "src/core"],
  notifications: ["public/vender/notify", "src/core"],
  maker: ["src/interaction/maker.js", "src/utils/mask.js", "UPGRADE.md"],
  account: ["src/core/account", "src/core/socket.js"],
  sync: ["src/core/socket.js", "src/core/account/bookmarks.js", "src/core/account/timeline.js"],
  content_rows: ["src/core/content_rows.js", "src/core/favorite.js"],
  mirrors: ["src/core/manifest.js", "src/core/mirrors.js"],
  ai: ["src/core/api/sources/ai.js"],
  router: ["src/core/router.js", "src/interaction/activity"],
};

export const LAMPA_RISKY_PATTERNS = [
  {
    pattern: "Lampa.Storage",
    reason: "Persisted user storage — changes can break saved user data",
  },
  {
    pattern: "Lampa.Event",
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

export function inferFeatureFiles(repoPath: string, featureName: string): string[] {
  const lower = featureName.toLowerCase();
  const hits: string[] = [];

  for (const [key, paths] of Object.entries(LAMPA_FEATURE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) {
      for (const p of paths) {
        hits.push(p);
      }
    }
  }

  // Also do a live search for the feature name in filenames
  const allFiles = listFilesRecursive(repoPath, [".js", ".ts", ".scss", ".css"]);
  for (const f of allFiles) {
    const rel = path.relative(repoPath, f);
    if (rel.toLowerCase().includes(lower) && !hits.includes(rel)) {
      hits.push(rel);
    }
  }

  return [...new Set(hits)];
}

export function detectRisks(repoPath: string, files: string[]): string[] {
  const warnings: string[] = [];

  for (const relFile of files) {
    const content = readFileSafe(path.join(repoPath, relFile));
    if (!content) continue;

    for (const { pattern, reason } of LAMPA_RISKY_PATTERNS) {
      if (content.includes(pattern)) {
        warnings.push(`${relFile} uses ${pattern} — ${reason}`);
      }
    }
  }

  return [...new Set(warnings)];
}

export function findSettingsInRepo(repoPath: string, keyword?: string): string {
  const patterns = [
    "Lampa.Settings.add",
    "Lampa.Settings.get",
    "Lampa.Storage.get",
    "Lampa.Storage.set",
    "settings_default",
    "defaults:",
  ];

  const lines: string[] = [];
  for (const pat of patterns) {
    if (keyword && !pat.toLowerCase().includes(keyword.toLowerCase())) continue;
    const matches = searchCode(repoPath, pat, ["*.js"], false);
    for (const m of matches.slice(0, 10)) {
      lines.push(`${m.file}:${m.line}  ${m.text}`);
    }
  }
  return lines.join("\n") || "No settings patterns found.";
}

export function findApiCallsInRepo(repoPath: string, provider?: string): string {
  const patterns = ["fetch(", "Lampa.Api", "$.ajax", "XMLHttpRequest", "axios", ".get(", ".post("];

  const lines: string[] = [];
  for (const pat of patterns) {
    const searchPath = provider ? path.join(repoPath, "plugins", provider) : repoPath;
    const matches = searchCode(searchPath, pat, ["*.js"], false);
    for (const m of matches.slice(0, 8)) {
      if (!provider || m.file.toLowerCase().includes(provider.toLowerCase())) {
        lines.push(`${m.file}:${m.line}  ${m.text}`);
      }
    }
  }
  return lines.join("\n") || "No API call patterns found.";
}
