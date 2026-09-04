import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  EXTERNAL_API_PROVIDERS,
  PROXY_PATTERN_NOTES,
  findExternalApiProvider,
  searchExternalApiProviders,
  type ExternalApiProvider,
} from "../utils/external_api.js";
import { READ_ONLY_SNAPSHOT, fail, ok, reportOutput } from "./meta.js";

const PROVIDER_IDS = EXTERNAL_API_PROVIDERS.map((p) => p.id) as [string, ...string[]];

function formatProvider(p: ExternalApiProvider): string {
  return [
    `## ${p.name}  (\`${p.id}\`)`,
    `**Category:** ${p.category}`,
    `**Auth:** ${p.authType}`,
    `**Storage keys:** ${p.storageKeys.length > 0 ? p.storageKeys.map((k) => `\`${k}\``).join(", ") : "none"}`,
    `**Used by:** ${p.usedBy.join(", ")}`,
    ``,
    p.description,
  ].join("\n");
}

export function registerExternalApiTools(server: McpServer, _config: Config): void {
  server.registerTool(
    "guide_external_api",
    {
      title: "Guide to third-party content-provider APIs used by Lampa plugins",
      description:
        "Document the real-world content/ratings/torrent-indexer/media-server APIs that Lampa plugins call \u2014 TMDB, KinoPoisk (PoiskKino + Unofficial), Alloha, MDBList, Jackett/Prowlarr/JacRed, TorrServer, Jellyfin, TheIntroDB, and the CORS-proxy pattern that fronts them. This is curated from the separate lampa-plugins repository, not the Lampa app source \u2014 unlike `guide_cub` (Lampa\u2192CUB backend only) and unlike `list_catalog` (Lampa's own API/event/storage surface).\\nNever returns secret values (API keys, tokens, passwords) \u2014 only provider identity, auth mechanism, and the Lampa.Storage key names a plugin reads credentials from.\\n`topic=providers` lists all providers (`search` filters by id/name/category/description); `provider_detail` requires `provider`; `proxy_pattern` takes no parameters and explains the shared Worker-proxy design once for all providers.",
      inputSchema: {
        topic: z
          .enum(["providers", "provider_detail", "proxy_pattern"])
          .describe(
            "providers=list/search all providers; provider_detail=one provider's auth/storage/usage; proxy_pattern=shared CORS/credential-hiding Worker design."
          ),
        provider: z
          .enum(PROVIDER_IDS)
          .optional()
          .describe(
            "Required for topic=provider_detail, e.g. 'tmdb', 'kinopoisk_unofficial', 'alloha', 'mdblist', 'jackett', 'torrserver'. Ignored otherwise."
          ),
        search: z
          .string()
          .optional()
          .describe(
            "For topic=providers only: filter by id, name, category, or description substring."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    ({ topic, provider, search }) => {
      if (topic === "proxy_pattern") {
        return ok(PROXY_PATTERN_NOTES);
      }

      if (topic === "provider_detail") {
        if (!provider) {
          return fail(
            `topic=provider_detail requires provider. Known ids: ${PROVIDER_IDS.join(", ")}`
          );
        }
        const found = findExternalApiProvider(provider);
        if (!found) {
          return fail(`Unknown provider "${provider}". Known ids: ${PROVIDER_IDS.join(", ")}`);
        }
        return ok(formatProvider(found));
      }

      const list = search ? searchExternalApiProviders(search) : EXTERNAL_API_PROVIDERS;
      if (list.length === 0) {
        return ok(`No providers match "${search}".`);
      }
      return ok(
        [
          `# External content-provider APIs (${list.length})`,
          ``,
          ...list.map((p) => `- \`${p.id}\` \u2014 ${p.name} (${p.category})`),
          ``,
          `Call \`provider_detail\` with one \`provider\` id for auth/storage/usage detail.`,
        ].join("\n")
      );
    }
  );
}
