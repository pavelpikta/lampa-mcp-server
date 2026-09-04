// Static reference for the real-world plugin catalog/publishing pipeline in the
// separate lampa-plugins repository (Cloudflare Pages: functions/, scripts/,
// plugins/extension.json, plugins/_routes.json). Curated, not live-scanned —
// this describes the pipeline shape, not the current live catalog contents.

export type PluginCatalogTopic =
  "manifest" | "obfuscation" | "routing" | "functions_api" | "publishing_checklist";

export const MANIFEST_SCHEMA_NOTES = `\`plugins/extension.json\` is the source catalog: categories, each with a \`results\`
array of plugin entries \`{ name, author, link, descr, description, version }\`.
\`link\` is the full download URL (e.g. \`https://lampa-plugins.devsecops.stream/pavelpikta/store.js\`);
its path becomes the plugin's catalog key.

\`scripts/generate-plugin-manifest.mjs\` derives \`plugin-manifest.json\` (served to
clients) by:
1. Scanning \`plugins/**/*.js\` on disk (folder name = category if extension.json
   has no matching entry).
2. Cross-referencing each file's path against \`extension.json\` by URL pathname to
   pull \`label\`, \`description\`, \`version\`, \`author\`, \`category\`, \`categoryTitle\`.
3. Falling back to folder-derived defaults (title-cased folder name as category)
   when a file has no \`extension.json\` entry.
Non-\`.js\` files and \`extension.json\`/\`plugin-manifest.json\` themselves are ignored
by the scanner.`;

export const OBFUSCATION_NOTES = `\`scripts/obfuscate-plugin.mjs\` wraps javascript-obfuscator with 3 presets
(low | medium | high, default medium) applied on top of shared base options
(compact output, hexadecimal identifier names, shuffled string array).

\`selfDefending\` and \`debugProtection\` are always OFF, even at "high" strength —
they break or hang on many Smart TV browsers, which is a hard requirement for
any Lampa plugin (Lampa runs on Samsung/LG/Android TV WebViews as well as desktop).

- low: no control-flow flattening, no dead-code injection, base64 string encoding.
- medium (default): control-flow flattening + dead-code injection at moderate
  thresholds, still base64/no rc4.
- high: denser flattening/dead-code, rc4 string encoding — larger and slower to
  parse, only worth it for plugins with logic worth protecting from copying.

Output defaults to \`<name>-obs.js\` next to the input.`;

export const ROUTING_NOTES = `Cloudflare Pages routes Functions only for the prefixes listed in
\`plugins/_routes.json\` \`include\`: \`/api/*\`, \`/plugin/*\`, \`/tmdb/*\`. Everything
else (\`/assets/*\`, \`/extension.json\`, \`/plugin-manifest.json\`, \`/index.html\`,
\`/404.html\`) is served as a static asset and explicitly excluded from Functions
routing for lower latency and cost.

\`plugins/_headers\` sets long-lived immutable caching on hashed \`/assets/*\` output
and \`no-cache, must-revalidate\` on the SPA shell (\`index.html\`, \`404.html\`) so
deploys are picked up immediately while static assets cache aggressively.`;

export const FUNCTIONS_API_NOTES = `Three Cloudflare Pages Functions back the catalog site (all under \`functions/\`):

- \`api/dynamic.js\` → \`/api/dynamic\` — merges \`plugin-manifest.json\` with
  \`extension.json\`, dedupes, groups by category, returns a unified catalog with an
  \`X-Data-Source\` response header indicating which source won for each entry.
- \`[plugin]/[[path]].js\` → \`/plugin/*\` — static plugin asset proxy/router with
  path-traversal guards (rejects \`..\`, reserved paths), MIME detection by
  extension, and \`Cache-Control: public, max-age=300, s-maxage=3600\`.
- \`tmdb/[[path]].js\` → \`/tmdb/*\` — dual-mode TMDB reverse proxy: API responses are
  fetched fresh, image responses get a 1-year cache; both handle CORS/OPTIONS
  preflight and strip hop-by-hop headers.

Shared helpers live in \`functions/lib/shared/\`: \`logger.js\` (structured levels),
\`http-utils.js\` (CORS/response builders), \`mime-utils.js\` (extension → Content-Type),
\`env-utils.js\`/\`catalog-utils.js\` (env access, catalog merge/normalize).`;

export const PUBLISHING_CHECKLIST = `Publishing a new plugin into the real catalog (lampa-plugins repo), in order:

1. Write the plugin under \`plugins/<owner>/<name>.js\` following the guard +
   \`appready\`/Listener pattern (see \`scaffold_plugin\` in this MCP server for a
   Lampa-source-accurate boilerplate).
2. Add or update its entry in \`plugins/extension.json\` (name, author, link, descr,
   description, version) under the right category.
3. Run \`node scripts/generate-plugin-manifest.mjs\` to refresh
   \`plugin-manifest.json\` from the new \`extension.json\` + on-disk scan.
4. Optionally obfuscate before publishing:
   \`node scripts/obfuscate-plugin.mjs plugins/<owner>/<name>.js --strength medium\`.
5. Verify \`plugins/_routes.json\`/\`_headers\` do not need changes (only touch these
   for new top-level route prefixes, not for new plugins).
6. Deploy via the site's normal Cloudflare Pages build; the \`/api/dynamic\`
   endpoint will serve the merged catalog immediately after deploy.

This tool documents the pipeline only — it never writes files or triggers a
deploy.`;
