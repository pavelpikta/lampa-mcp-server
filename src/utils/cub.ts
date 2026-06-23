import path from "node:path";
import { listFilesRecursive, readFileSafe, fileExists } from "./fs.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CubApiCategory =
  | "account"
  | "bookmarks"
  | "timeline"
  | "notifications"
  | "notice"
  | "person"
  | "ai"
  | "discuss"
  | "reactions"
  | "collections"
  | "content"
  | "extensions"
  | "storage"
  | "services"
  | "media"
  | "tmdb_proxy"
  | "advert";

export interface LampaCubEndpoint {
  path: string;
  method: "GET" | "POST" | "GET|POST";
  category: CubApiCategory;
  base: "api" | "tmdb_proxy" | "websocket";
  auth: "token+profile" | "token_optional" | "public" | "websocket";
  description: string;
  files: Array<{ file: string; line: number; context: string }>;
  featureGate?: string;
  premium?: boolean;
}

// ── Category inference ───────────────────────────────────────────────────────

function inferCategory(apiPath: string): CubApiCategory {
  const p = apiPath.toLowerCase();
  if (p.startsWith("bookmarks")) return "bookmarks";
  if (p.startsWith("timeline")) return "timeline";
  if (p.startsWith("notifications")) return "notifications";
  if (p.startsWith("notice")) return "notice";
  if (p.startsWith("person")) return "person";
  if (p.startsWith("profiles")) return "account";
  if (p.startsWith("users")) return "account";
  if (p.startsWith("device")) return "account";
  if (p.startsWith("plugins") || p.startsWith("extensions")) return "extensions";
  if (p.startsWith("ai/")) return "ai";
  if (p.startsWith("discuss")) return "discuss";
  if (p.startsWith("reactions")) return "reactions";
  if (p.startsWith("collections")) return "collections";
  if (p.startsWith("feed") || p.startsWith("trailers")) return "content";
  if (p.startsWith("storage")) return "storage";
  if (
    p.startsWith("metric") ||
    p.startsWith("remote-configuration") ||
    p.startsWith("lampa/logs") ||
    p === "checker"
  )
    return "services";
  if (p.startsWith("iptv") || p.startsWith("shots")) return "media";
  if (p.startsWith("ad/")) return "advert";
  return "account";
}

/** Curated descriptions for endpoints discovered in Lampa source. */
const ENDPOINT_META: Record<string, Partial<LampaCubEndpoint>> = {
  "device/add": {
    method: "POST",
    description: "Exchange 6-digit code from cub.rip/add for account token and profile",
    auth: "public",
  },
  "users/get": {
    method: "GET",
    description: "Fetch current user info (device_name query param)",
    auth: "token+profile",
  },
  "users/backup/import": {
    method: "GET",
    description: "Restore account from cloud backup",
    auth: "token+profile",
  },
  "users/backup/export": {
    method: "GET",
    description: "Export account backup",
    auth: "token+profile",
  },
  "profiles/all": {
    method: "GET",
    description: "List all profiles for account",
    auth: "token+profile",
  },
  "profiles/create": { method: "POST", description: "Create new profile", auth: "token+profile" },
  "plugins/all": { method: "GET", description: "Plugin store catalog", auth: "token+profile" },
  "plugins/status": {
    method: "POST",
    description: "Enable/disable bundled plugin",
    auth: "token+profile",
  },
  "plugins/blacklist": {
    method: "GET",
    description: "Plugin blacklist for moderation",
    auth: "public",
  },
  "extensions/status": {
    method: "POST",
    description: "Enable/disable third-party extension",
    auth: "token+profile",
  },
  "extensions/list": {
    method: "GET",
    description: "Extension store catalog",
    auth: "token_optional",
  },
  "bookmarks/{method}": {
    method: "POST",
    description: "Add or remove bookmark (method: add|remove). Queued via push_queue",
    auth: "token+profile",
  },
  "bookmarks/dump": {
    method: "GET",
    description: "Full bookmark export for profile sync (text response)",
    auth: "token+profile",
  },
  "bookmarks/changelog": {
    method: "GET",
    description: "Incremental bookmark changes since version (since=ms)",
    auth: "token+profile",
  },
  "bookmarks/clear": {
    method: "POST",
    description: "Clear all bookmarks for profile",
    auth: "token+profile",
  },
  "timeline/dump": {
    method: "GET",
    description: "Full watch-progress export (Premium, text JSON)",
    auth: "token+profile",
    premium: true,
  },
  "timeline/changelog": {
    method: "GET",
    description: "Incremental timeline changes since version (since=ms, Premium)",
    auth: "token+profile",
    premium: true,
  },
  "notifications/all": {
    method: "GET",
    description: "Translation/voice release subscriptions",
    auth: "token+profile",
  },
  "notifications/add": {
    method: "POST",
    description: "Subscribe to episode voice release",
    auth: "token+profile",
  },
  "notice/all": { method: "GET", description: "In-app notices for account", auth: "token+profile" },
  "person/list": {
    method: "GET",
    description: "Actor subscription list",
    auth: "token+profile",
    featureGate: "disable_features.persons",
  },
  "person/subscribe": {
    method: "GET",
    description: "Subscribe to actor updates",
    auth: "token+profile",
  },
  "person/unsubscribe": {
    method: "GET",
    description: "Unsubscribe from actor",
    auth: "token+profile",
  },
  "ai/generate/facts/{id}/{type}": {
    method: "GET",
    description: "AI-generated card facts",
    auth: "token+profile",
    featureGate: "disable_features.ai",
  },
  "ai/generate/recommend/{id}/{type}": {
    method: "GET",
    description: "AI recommendations for card",
    auth: "token+profile",
    featureGate: "disable_features.ai",
  },
  "ai/search/{query}": {
    method: "GET",
    description: "AI-powered search assistant",
    auth: "token+profile",
    featureGate: "disable_features.ai",
  },
  "discuss/get/{type}_{id}/{page}/{lang}": {
    method: "GET",
    description: "Read discussion comments for card",
    auth: "public",
    featureGate: "disable_features.discuss",
  },
  "discuss/add": {
    method: "POST",
    description: "Post discussion comment",
    auth: "token+profile",
    featureGate: "disable_features.discuss",
  },
  "discuss/voite": {
    method: "POST",
    description: "Vote on discussion comment",
    auth: "token+profile",
    featureGate: "disable_features.discuss",
  },
  "reactions/get/{type}_{id}": {
    method: "GET",
    description: "Get card reaction counts",
    auth: "public",
    featureGate: "disable_features.reactions",
  },
  "reactions/add/{type}_{id}/{reaction}": {
    method: "GET",
    description: "Add reaction (fire, nice, think, bore, shit)",
    auth: "public",
    featureGate: "disable_features.reactions",
  },
  "collections/list": {
    method: "GET",
    description: "List public/user collections",
    auth: "token_optional",
  },
  "collections/saved-list": {
    method: "GET",
    description: "Saved collections for user",
    auth: "token+profile",
  },
  "collections/view/{id}": {
    method: "GET",
    description: "Cards inside a collection",
    auth: "token_optional",
  },
  "collections/liked": {
    method: "POST",
    description: "Like/unlike collection",
    auth: "token+profile",
  },
  "collections/save": {
    method: "POST",
    description: "Save collection to favorites",
    auth: "token+profile",
  },
  "collections/save-status": {
    method: "GET",
    description: "Check if collection is saved",
    auth: "token+profile",
  },
  "feed/all": {
    method: "GET",
    description: "Social activity feed",
    auth: "public",
    featureGate: "feed",
  },
  "trailers/short/trailers/{type}": {
    method: "GET",
    description: "Short trailer rows (added type)",
    auth: "public",
    featureGate: "disable_features.trailers",
  },
  "storage/data/{field}/{class_type}": {
    method: "GET",
    description: "Premium cloud storage sync for arrays/objects (search history etc.)",
    auth: "token+profile",
    premium: true,
  },
  "metric/unic": { method: "GET", description: "Unique device metric ping", auth: "public" },
  "metric/stat": { method: "GET", description: "Analytics event counter", auth: "public" },
  "metric/histogram": { method: "GET", description: "Analytics histogram value", auth: "public" },
  "remote-configuration/": {
    method: "GET",
    description: "Remote app configuration",
    auth: "public",
    featureGate: "disable_features.remote_configuration",
  },
  "lampa/logs/write": {
    method: "POST",
    description: "Upload client logs to CUB",
    auth: "token_optional",
  },
  checker: { method: "GET", description: "Mirror health check (cub_alive)", auth: "public" },
  "iptv/*": {
    method: "GET|POST",
    description: "IPTV playlist/time API (plugin)",
    auth: "token+profile",
  },
  "shots/*": {
    method: "GET|POST",
    description: "Short-form shots feed API (plugin)",
    auth: "token+profile",
  },
  "ad/get/{api}": {
    method: "GET",
    description: "VAST preroll ad fetch",
    auth: "public",
    featureGate: "disable_features.ads",
  },
};

const TMDB_PROXY_META: Array<{ path: string; description: string }> = [
  {
    path: "tmdb.{domain}/*",
    description: "CUB TMDB catalog proxy (sorts: now_playing, latest, top, collections/{id})",
  },
  { path: "tmdb.{domain}/3/{method}/{id}", description: "TMDB v3 detail proxy for full cards" },
  { path: "tmdb.{domain}/search/{type}", description: "CUB search proxy (movie, tv, anime)" },
  { path: "tmdb.{domain}?sort=releases", description: "Release calendar" },
  { path: "tmdb.{domain}/watch", description: "Watch-party / viewed tracking" },
  { path: "tmdb.{domain}/blocked", description: "DMCA blocked cards list" },
  { path: "tmdb.{domain}/lgbt.json", description: "LGBT content filter list" },
  { path: "apitmdb.{domain}/3/", description: "TMDB API proxy (Premium, tmdb_proxy plugin)" },
  { path: "imagetmdb.{domain}/", description: "TMDB image proxy (Premium)" },
];

// ── Scanner ──────────────────────────────────────────────────────────────────

function addHit(
  map: Map<string, LampaCubEndpoint>,
  apiPath: string,
  file: string,
  line: number,
  context: string,
  base: LampaCubEndpoint["base"] = "api"
): void {
  const pathKey = apiPath.replace(/\{id\}/g, "{id}").replace(/\s+/g, "");
  if (!pathKey || pathKey.length < 2) return;

  const category = base === "tmdb_proxy" ? "tmdb_proxy" : inferCategory(pathKey);
  const metaKey = Object.keys(ENDPOINT_META).find(
    (k) => pathKey === k || pathKey.startsWith(k.replace("{method}", "").replace("*", ""))
  );
  const meta = metaKey ? ENDPOINT_META[metaKey] : {};

  const existing = map.get(pathKey);
  if (existing) {
    if (!existing.files.some((f) => f.file === file && f.line === line)) {
      existing.files.push({ file, line, context: context.trim().slice(0, 120) });
    }
    return;
  }

  map.set(pathKey, {
    path: pathKey,
    method: meta.method ?? (context.includes("POST") || context.includes("post") ? "POST" : "GET"),
    category,
    base,
    auth:
      meta.auth ?? (category === "services" || category === "content" ? "public" : "token+profile"),
    description: meta.description ?? `CUB API endpoint used in Lampa source`,
    files: [{ file, line, context: context.trim().slice(0, 120) }],
    featureGate: meta.featureGate,
    premium: meta.premium,
  });
}

export function extractLampaCubApi(repoPath: string): LampaCubEndpoint[] {
  const map = new Map<string, LampaCubEndpoint>();
  const srcRoot = path.join(repoPath, "src");
  const pluginsRoot = path.join(repoPath, "plugins");
  const roots = [srcRoot, pluginsRoot].filter((r) => fileExists(r));

  for (const root of roots) {
    const files = listFilesRecursive(root, [".js"]);
    for (const abs of files) {
      const content = readFileSafe(abs);
      if (!content) continue;
      const rel = path.relative(repoPath, abs);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Api.load / Account.Api.load / bare load() in account modules
        const loadMatch =
          line.match(/(?:Account\.)?Api\.load\(\s*['"]([^'"]+)['"]/) ??
          (rel.includes("account/") ? line.match(/\bload\(\s*['"]([^'"]+)['"]/) : null);
        if (loadMatch) {
          let p = loadMatch[1].split("?")[0];
          if (p.endsWith("/")) p = p.slice(0, -1);
          if (
            p.includes("bookmarks/") &&
            !p.includes("bookmarks/dump") &&
            !p.includes("changelog") &&
            !p.includes("clear")
          ) {
            p = "bookmarks/{method}";
          }
          if (p.startsWith("ai/generate/facts")) p = "ai/generate/facts/{id}/{type}";
          else if (p.startsWith("ai/generate/recommend")) p = "ai/generate/recommend/{id}/{type}";
          else if (p.startsWith("ai/search")) p = "ai/search/{query}";
          addHit(map, p, rel, i + 1, line);
        }

        // Api.url() + 'device/add'
        const urlConcat = line.match(/Api\.url\(\)\s*\+\s*['"]([^'"]+)['"]/);
        if (urlConcat) addHit(map, urlConcat[1], rel, i + 1, line);

        // cub_domain + '/api/...'
        const apiUrl = line.match(/cub_domain\s*\+\s*['"]\/api\/([^'"]+)['"]/);
        if (apiUrl) {
          let p = apiUrl[1]
            .split("?")[0]
            .replace(/\+[^'"]+/g, "")
            .replace(/['"]/g, "");
          if (p.includes("discuss/get/")) p = "discuss/get/{type}_{id}/{page}/{lang}";
          if (p.includes("reactions/get/")) p = "reactions/get/{type}_{id}";
          if (p.includes("reactions/add/")) p = "reactions/add/{type}_{id}/{reaction}";
          if (p.includes("trailers/short/trailers/")) p = "trailers/short/trailers/{type}";
          if (p.includes("ad/get/")) p = "ad/get/{api}";
          if (p.includes("collections/view/")) p = "collections/view/{id}";
          addHit(map, p, rel, i + 1, line);
        }

        // api() + 'storage/data/...'
        const storageMatch = line.match(/api\(\)\s*\+\s*['"]storage\/([^'"]+)['"]/);
        if (storageMatch) addHit(map, `storage/${storageMatch[1]}`, rel, i + 1, line);

        // api_url + method (plugins)
        if (line.includes("api_url +") || line.includes("this.api_url +")) {
          const plugMatch = line.match(/\+\s*['"]([^'"]+)['"]/);
          if (
            plugMatch &&
            (rel.includes("collections/") || rel.includes("iptv/") || rel.includes("shots/"))
          ) {
            const prefix = rel.includes("iptv")
              ? "iptv"
              : rel.includes("shots")
                ? "shots"
                : "collections";
            addHit(map, `${prefix}/${plugMatch[1].split("?")[0]}`, rel, i + 1, line);
          }
        }

        // /api/checker
        if (line.includes("'/api/checker'") || line.includes('"/api/checker"')) {
          addHit(map, "checker", rel, i + 1, line);
        }
      }
    }
  }

  // TMDB proxy endpoints (curated — not /api/ but CUB infrastructure)
  for (const tmdb of TMDB_PROXY_META) {
    const key = tmdb.path;
    if (!map.has(key)) {
      map.set(key, {
        path: key,
        method: "GET",
        category: "tmdb_proxy",
        base: "tmdb_proxy",
        auth: "public",
        description: tmdb.description,
        files: [
          { file: "src/core/api/sources/cub.js", line: 0, context: "tmdb.{cub_domain} proxy" },
        ],
      });
    }
  }

  // WebSocket sync (not REST but part of CUB cloud sync in Lampa)
  map.set("websocket:timeline", {
    path: "websocket:timeline",
    method: "GET|POST",
    category: "timeline",
    base: "websocket",
    auth: "websocket",
    description: "Real-time watch progress sync via Socket.send('timeline') — Premium",
    files: [
      {
        file: "src/interaction/timeline.js",
        line: 109,
        context: "Socket.send('timeline',{params})",
      },
    ],
    premium: true,
  });
  map.set("websocket:bookmarks", {
    path: "websocket:bookmarks",
    method: "GET|POST",
    category: "bookmarks",
    base: "websocket",
    auth: "websocket",
    description: "Trigger bookmark refresh on other devices via Socket.send('bookmarks')",
    files: [
      { file: "src/core/account/bookmarks.js", line: 50, context: "Socket.send('bookmarks',{})" },
    ],
  });
  map.set("websocket:storage", {
    path: "websocket:storage",
    method: "GET|POST",
    category: "storage",
    base: "websocket",
    auth: "websocket",
    description: "Premium array/object cloud storage sync via Socket.send('storage')",
    files: [
      {
        file: "src/core/storage/workers.js",
        line: 170,
        context: "Socket.send('storage',{params})",
      },
    ],
    premium: true,
  });

  return [...map.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path)
  );
}

export function findLampaCubEndpoint(
  repoPath: string,
  query: string
): LampaCubEndpoint | undefined {
  const all = extractLampaCubApi(repoPath);
  const lower = query.toLowerCase();
  return all.find(
    (e) =>
      e.path.toLowerCase() === lower ||
      e.path.toLowerCase().includes(lower) ||
      lower.includes(e.path.toLowerCase().split("/")[0])
  );
}

export const CUB_DATA_MODELS = {
  baseUrl: "{protocol}://{Manifest.cub_domain}/api/",
  headers: {
    token: "Account.Permit.token — from Storage.account after device/add",
    profile: "Account.Permit.account.profile.id — scopes bookmarks/timeline",
  },
  deviceFlow: [
    "User opens cub.rip/add (or QR in Lampa settings)",
    "POST device/add { code: 6-digit }",
    "Storage.set('account', result) → page reload",
    "Implementation: src/core/account/device.js",
  ],
  bookmarkTypes: {
    public: ["book", "history", "like", "wath"],
    internal: ["viewed", "scheduled", "look", "thrown", "continued"],
    source: "src/core/favorite.js",
  },
  bookmarkRecord: {
    id: "bookmark row ID",
    type: "book | history | like | wath | viewed | ...",
    card_id: "card ID",
    data: "JSON string (Utils.clearCard)",
    profile: "profile ID",
    time: "timestamp ms",
  },
  timeline: {
    localKey: "file_view_{profileId}",
    dump: { version: "ms", timelines: "{ hash: { time, duration, percent } }" },
    socket: "Socket.send('timeline', {params}) when Account.hasPremium()",
    hash: "Utils.hash(hash_string) — see episodes_parser.js",
  },
  sync: {
    bookmarks: "dump (10d+) → changelog (incremental) → push_queue add/remove",
    timeline: "dump (10d+) → changelog (incremental) → WebSocket push",
    storage: "storage/data/{field} REST + WebSocket storage events (Premium)",
  },
};
