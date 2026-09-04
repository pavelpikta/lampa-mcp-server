// Static, hand-curated knowledge extracted from the separate lampa-plugins repo's
// knowledge/ directory (pavelpikta-api-inventory.md, kinopoisk/, alloha/, mdblist/).
// Intentionally contains NO secret values (API keys, tokens, passwords) — only
// provider identity, category, auth *mechanism*, and the Storage key names plugins
// use to hold user-supplied credentials. Never add a literal secret to this file.

export type ExternalApiCategory =
  "content_metadata" | "ratings" | "torrent_indexer" | "media_server" | "proxy";

export interface ExternalApiProvider {
  id: string;
  name: string;
  category: ExternalApiCategory;
  /** How a real plugin authenticates — mechanism only, never a value. */
  authType: string;
  /** Lampa.Storage key names (not secrets) a plugin reads the credential/URL from. */
  storageKeys: string[];
  /** Representative real plugin file names in lampa-plugins/plugins/pavelpikta. */
  usedBy: string[];
  description: string;
}

export const EXTERNAL_API_PROVIDERS: ExternalApiProvider[] = [
  {
    id: "tmdb",
    name: "TMDB (The Movie Database)",
    category: "content_metadata",
    authType: "API key via Worker proxy path (/api/3/*, /img/*), or user-supplied key as fallback",
    storageKeys: ["tmdb_api_key", "tmdb_api_mirror", "tmdb_img_mirror", "proxy_tmdb"],
    usedBy: ["dso-proxy.js", "dso-proxy-tmdb.js", "tmdb-proxy.js", "dso-cards-style.js"],
    description:
      "Primary content metadata source. Lampa.TMDB.api()/.image() route through whichever proxy plugin (dso-proxy*, tmdb-proxy*) is active, which forwards to a Worker that hides the real TMDB key from the client.",
  },
  {
    id: "kinopoisk_poiskkino",
    name: "KinoPoisk — PoiskKino (official-style)",
    category: "content_metadata",
    authType: "header X-API-KEY via Worker proxy",
    storageKeys: ["dso_kp_api_key"],
    usedBy: ["dso-kp-source.js"],
    description:
      "Catalog source using PoiskKino's v1.4 API (filters, Top 250, lists) with TMDB id handoff. Paginated, small per-page caps.",
  },
  {
    id: "kinopoisk_unofficial",
    name: "KinoPoisk — Unofficial API",
    category: "content_metadata",
    authType: "header X-API-KEY via Worker proxy",
    storageKeys: ["dso_kp_tech_api_key", "dso_ratings_kp_api_key"],
    usedBy: ["dso-kp-tech-source.js", "ratings.js"],
    description:
      "Full KP card data (v2.2 films/{id}, collections, filters) and KP ratings. Same proxy host as PoiskKino, different path segment.",
  },
  {
    id: "alloha",
    name: "Alloha",
    category: "content_metadata",
    authType: "Bearer token, or query token= on the mirror host",
    storageKeys: ["dso_alloha_token", "dso_alloha_base", "dso_alloha_cors_proxy"],
    usedBy: ["dso-alloha-source.js", "dso-alloha-latest.js", "dso-cards-style.js"],
    description: "Catalog + multi-source ratings (IMDb/KP/TMDB) provider, CORS-proxied.",
  },
  {
    id: "mdblist",
    name: "MDBList",
    category: "ratings",
    authType: "query apikey= via Worker proxy",
    storageKeys: ["dso_ratings_mdblist_api_key"],
    usedBy: ["ratings.js", "dso-mdblist-lists.js"],
    description: "Aggregated ratings and curated list catalog.",
  },
  {
    id: "jackett",
    name: "Jackett",
    category: "torrent_indexer",
    authType: "query apikey= against a self-hosted or shared instance URL",
    storageKeys: ["jackett_url", "jackett_key", "jackett_url_two", "jackett_key_two"],
    usedBy: ["catalog-parsers.js", "personal-settings.js"],
    description: "Torrent indexer aggregator; primary/secondary instance pair for failover.",
  },
  {
    id: "prowlarr",
    name: "Prowlarr",
    category: "torrent_indexer",
    authType: "header X-Api-Key",
    storageKeys: ["prowlarr_key"],
    usedBy: ["catalog-parsers.js"],
    description: "Jackett-compatible indexer aggregator, alternate backend for the same UI.",
  },
  {
    id: "jacred",
    name: "JacRed",
    category: "torrent_indexer",
    authType: "query apikey= (preset)",
    storageKeys: [],
    usedBy: ["catalog-parsers.js"],
    description: "Lightweight torrent search aggregator, often paired with Jackett/Prowlarr.",
  },
  {
    id: "torrserver",
    name: "TorrServer",
    category: "torrent_indexer",
    authType: "HTTP Basic against a self-hosted instance URL",
    storageKeys: [
      "torrserver_url",
      "torrserver_login",
      "torrserver_password",
      "torrserver_url_two",
    ],
    usedBy: ["catalog-torrservers.js", "personal-settings.js"],
    description: "Torrent-to-stream backend; primary/secondary instance pair for failover.",
  },
  {
    id: "jellyfin",
    name: "Jellyfin",
    category: "media_server",
    authType: "query + Emby-Authorization header, API key against a self-hosted instance URL",
    storageKeys: ["jellyfinUrl", "jellyfinKey"],
    usedBy: ["jellyfin.js"],
    description: "Personal media server integration exposed as a Lampa content source.",
  },
  {
    id: "theintrodb",
    name: "TheIntroDB",
    category: "content_metadata",
    authType: "Bearer token (read) / separate submit-only key (write)",
    storageKeys: ["dso_skip_api_key", "dso_skip_introdb_api_key"],
    usedBy: ["dso-skip-segments.js"],
    description: "Skip-intro/recap segment timestamps for episodes.",
  },
  {
    id: "cors_proxy",
    name: "CORS reverse proxy",
    category: "proxy",
    authType: "none — plain reverse proxy, upstream auth (if any) stays server-side",
    storageKeys: ["dso_alloha_cors_proxy", "dso_cards_style_qualityCorsProxyUrl"],
    usedBy: ["dso-online-filmix.js", "dso-alloha-source.js", "dso-speed-test.js"],
    description:
      "Generic Worker that forwards requests to hosts without CORS headers (Filmix, KinoPub, Alloha, speed tests) so browser-side Lampa can call them directly.",
  },
];

export function findExternalApiProvider(id: string): ExternalApiProvider | undefined {
  return EXTERNAL_API_PROVIDERS.find((p) => p.id === id);
}

export function searchExternalApiProviders(query: string): ExternalApiProvider[] {
  const q = query.toLowerCase();
  return EXTERNAL_API_PROVIDERS.filter(
    (p) =>
      p.id.includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.category.includes(q) ||
      p.description.toLowerCase().includes(q)
  );
}

export const PROXY_PATTERN_NOTES = `Real plugins never call most of these providers directly from the browser. A small
family of Cloudflare Workers (named like \`<service>.devsecops.stream\` in the
lampa-plugins deployment) sits in front of each provider and:

1. Hides the real credential server-side — the client only needs a Worker URL, not
   the upstream API key, unless the plugin explicitly exposes a "use your own key"
   setting (KinoPoisk, MDBList, Alloha all support this fallback).
2. Adds CORS headers so browser-side \`Lampa.Reguest\`/\`fetch\` calls succeed against
   hosts that do not support cross-origin requests natively (Filmix, KinoPub, Alloha).
3. Applies caching (content responses cached briefly, images cached long) to reduce
   upstream load and speed up repeat lookups.

This is the same shape as Lampa's own CUB proxy pattern (see \`guide_cub\`), just for
third-party content/ratings/indexer providers instead of the CUB backend.`;
