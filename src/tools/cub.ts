import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { Config } from "../config.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import {
  extractLampaCubApi,
  findLampaCubEndpoint,
  CUB_DATA_MODELS,
  type LampaCubEndpoint,
} from "../utils/cub.js";

function formatEndpointDetail(ep: LampaCubEndpoint, repoPath: string): string {
  const lines = [
    `# ${ep.path}`,
    ``,
    `| Property | Value |`,
    `|----------|-------|`,
    `| Base | \`${ep.base}\` |`,
    `| Method | ${ep.method} |`,
    `| Category | ${ep.category} |`,
    `| Auth | ${ep.auth} |`,
    `| Premium | ${ep.premium ? "yes" : "no"} |`,
    ep.featureGate ? `| Feature gate | \`lampa_settings.${ep.featureGate}\` |` : "",
    ``,
    `## Description`,
    ep.description,
    ``,
    `## Used in Lampa (${ep.files.length} location${ep.files.length > 1 ? "s" : ""})`,
    ...ep.files.map((f) => `- \`${f.file}:${f.line}\`  \`${f.context}\``),
  ].filter(Boolean);

  // Show source preview from first file
  const first = ep.files[0];
  if (first && first.line > 0) {
    const abs = path.join(repoPath, first.file);
    const content = readFileSafe(abs);
    if (content) {
      const fileLines = content.split("\n");
      const start = Math.max(0, first.line - 4);
      const end = Math.min(fileLines.length, first.line + 8);
      lines.push(
        ``,
        `## Source context (\`${first.file}\`)`,
        "```javascript",
        fileLines.slice(start, end).join("\n"),
        "```"
      );
    }
  }

  lines.push(
    ``,
    `**Base URL:** \`Utils.protocol() + Manifest.cub_domain + '/api/'\``,
    `**Account client:** \`src/core/account/api.js\` — \`Api.load(path, params, post)\``,
    `**Official docs:** https://cub.rip/developer/`
  );

  return lines.join("\n");
}

export function registerCubTools(server: McpServer, config: Config): void {
  // ── cub_api_catalog ────────────────────────────────────────────────────────
  server.tool(
    "cub_api_catalog",
    "Complete catalog of CUB cloud API endpoints used by Lampa source: account, bookmarks, timeline, AI, collections, TMDB proxy, IPTV, metrics, and WebSocket sync. Extracted from lampa-source only.",
    {
      category: z
        .enum([
          "all",
          "account",
          "bookmarks",
          "timeline",
          "notifications",
          "notice",
          "person",
          "ai",
          "discuss",
          "reactions",
          "collections",
          "content",
          "extensions",
          "storage",
          "services",
          "media",
          "tmdb_proxy",
          "advert",
        ])
        .optional()
        .describe("Filter by API category. Default: all."),
      search: z.string().optional().describe("Filter by path substring."),
    },
    async ({ category = "all", search }) => {
      if (!fileExists(config.repoPath)) {
        return {
          content: [{ type: "text" as const, text: `Lampa repo not found: ${config.repoPath}` }],
        };
      }

      let endpoints = extractLampaCubApi(config.repoPath);

      if (category !== "all") {
        endpoints = endpoints.filter((e) => e.category === category);
      }
      if (search) {
        const lower = search.toLowerCase();
        endpoints = endpoints.filter(
          (e) => e.path.toLowerCase().includes(lower) || e.description.toLowerCase().includes(lower)
        );
      }

      const byCategory: Record<string, LampaCubEndpoint[]> = {};
      for (const ep of endpoints) {
        if (!byCategory[ep.category]) byCategory[ep.category] = [];
        byCategory[ep.category].push(ep);
      }

      const sections = Object.entries(byCategory)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cat, eps]) => {
          const rows = eps.map(
            (e) =>
              `| \`${e.path}\` | ${e.method} | ${e.auth} | ${e.premium ? "Premium" : "—"} | ${e.files[0]?.file ?? "—"} |`
          );
          return `### ${cat} (${eps.length})\n| Path | Method | Auth | Notes | Source |\n|------|--------|------|-------|--------|\n${rows.join("\n")}`;
        });

      const out = [
        `# Lampa CUB API Catalog  (${endpoints.length} endpoints)`,
        ``,
        `Extracted from: \`${config.repoPath}\``,
        `**REST base:** \`{protocol}://{Manifest.cub_domain}/api/\``,
        `**TMDB proxy:** \`tmdb.{cub_domain}/\` (catalog, not under /api/)`,
        `**Auth:** \`token\` + \`profile\` headers via Account.Permit`,
        `**Docs:** https://cub.rip/developer/`,
        ``,
        ...sections,
        ``,
        `Use \`cub_endpoint_detail\` for params and source context on a specific path.`,
      ].join("\n\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── cub_endpoint_detail ──────────────────────────────────────────────────────
  server.tool(
    "cub_endpoint_detail",
    "Detailed view of a single CUB API endpoint as used in Lampa: auth, feature gates, source file locations, and code context.",
    {
      path: z
        .string()
        .describe(
          "Endpoint path, e.g. 'bookmarks/dump', 'timeline/changelog', 'ai/search/{query}', 'device/add'."
        ),
    },
    async ({ path: endpointPath }) => {
      const ep = findLampaCubEndpoint(config.repoPath, endpointPath);
      if (!ep) {
        const all = extractLampaCubApi(config.repoPath);
        const sample = all
          .slice(0, 15)
          .map((e) => e.path)
          .join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Endpoint "${endpointPath}" not found in Lampa source.\n\nSample paths: ${sample}\n\nUse cub_api_catalog to list all.`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: formatEndpointDetail(ep, config.repoPath) }],
      };
    }
  );

  // ── cub_auth_guide ───────────────────────────────────────────────────────────
  server.tool(
    "cub_auth_guide",
    "CUB authentication as implemented in Lampa: device/add flow, token/profile headers, Account.Permit gating, Premium checks, and mirror resolution.",
    {
      topic: z
        .enum(["overview", "device", "headers", "permit", "premium", "mirrors"])
        .optional()
        .describe("Focus area. Default: overview."),
    },
    async ({ topic = "overview" }) => {
      const m = CUB_DATA_MODELS;
      const sections: string[] = [
        `# CUB Authentication in Lampa`,
        ``,
        `Implementation: \`src/core/account/\` — api.js, device.js, permit.js, account.js`,
        `Official API docs: https://cub.rip/developer/`,
      ];

      if (topic === "overview" || topic === "device") {
        sections.push(
          ``,
          `## Device login (device/add)`,
          ...m.deviceFlow.map((s, i) => `${i + 1}. ${s}`),
          ``,
          `**UI entry:** Settings → Account → Add device`,
          `**Code URL:** https://cub.rip/add`,
          `**Storage keys:** \`account\`, \`account_email\``
        );
      }

      if (topic === "overview" || topic === "headers") {
        sections.push(
          ``,
          `## Request headers`,
          `Set in \`Account.Api.load()\` (\`src/core/account/api.js\`):`,
          `| Header | Source |`,
          `|--------|--------|`,
          `| \`token\` | \`${m.headers.token}\` |`,
          `| \`profile\` | \`${m.headers.profile}\` |`,
          ``,
          `Returns 403 (\`decode_code: 403\`) when \`Permit.token\` is missing.`
        );
      }

      if (topic === "overview" || topic === "permit") {
        sections.push(
          ``,
          `## Account.Permit gating`,
          `- \`Permit.token\` — API access allowed`,
          `- \`Permit.access\` — account features enabled`,
          `- \`Permit.sync\` — bookmark/timeline sync (\`account_sync\` setting)`,
          `- Disabled when: \`iptv\` mode, \`read_only\`, \`account_use: false\``,
          ``,
          `**Settings:** \`window.lampa_settings.account_use\`, \`account_sync\``
        );
      }

      if (topic === "overview" || topic === "premium") {
        sections.push(
          ``,
          `## Premium features`,
          `- Timeline sync (dump/changelog + WebSocket)`,
          `- Cloud storage workers (\`storage/data/*\`)`,
          `- TMDB image/API proxy (\`tmdb_proxy\` plugin)`,
          `- Check: \`Account.hasPremium()\``,
          ``,
          `**Error code 555** on some bookmark operations without Premium.`
        );
      }

      if (topic === "overview" || topic === "mirrors") {
        sections.push(
          ``,
          `## Mirrors`,
          `- \`Manifest.cub_mirrors\` — cub.rip, durex.monster, cubnotrip.top + user-added`,
          `- \`Manifest.cub_domain\` — active mirror from localStorage or first mirror`,
          `- \`Manifest.cub_alive\` — health check via \`/api/checker\``,
          `- RU may need VPN — noted at https://cub.rip/developer/`,
          ``,
          `Use \`manifest_mirrors_map\` for full mirror resolution logic.`
        );
      }

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // ── cub_data_models ──────────────────────────────────────────────────────────
  server.tool(
    "cub_data_models",
    "CUB data schemas as used in Lampa: bookmark types, timeline storage, favorite categories, and sync payload shapes.",
    {
      model: z
        .enum(["all", "bookmarks", "timeline", "favorites", "account", "sync"])
        .optional()
        .describe("Which model to show. Default: all."),
    },
    async ({ model = "all" }) => {
      const m = CUB_DATA_MODELS;
      const sections: string[] = ["# CUB Data Models (Lampa)"];

      if (model === "all" || model === "bookmarks") {
        sections.push(
          ``,
          `## Bookmarks`,
          `**Source:** \`src/core/account/bookmarks.js\`, \`src/core/favorite.js\``,
          `**Public types:** ${m.bookmarkTypes.public.map((t) => `\`${t}\``).join(", ")}`,
          `**Internal types (sync):** ${m.bookmarkTypes.internal.map((t) => `\`${t}\``).join(", ")}`,
          ``,
          `**Record:**`,
          "```json",
          JSON.stringify(m.bookmarkRecord, null, 2),
          "```",
          `**Sync:** push_queue → \`bookmarks/add|remove\` → dump/changelog`
        );
      }

      if (model === "all" || model === "timeline") {
        sections.push(
          ``,
          `## Timeline (Premium)`,
          `**Local storage key:** \`${m.timeline.localKey}\``,
          `**Cloud dump shape:**`,
          "```json",
          JSON.stringify(m.timeline.dump, null, 2),
          "```",
          `**Push:** ${m.timeline.socket}`,
          `**Hash:** ${m.timeline.hash}`
        );
      }

      if (model === "all" || model === "favorites") {
        sections.push(
          ``,
          `## Favorite categories`,
          `Mapped 1:1 to bookmark types. Use \`favorite_category_schema\` for full list.`,
          `Lampa.Favorite → Account.Bookmarks sync on add/remove.`
        );
      }

      if (model === "all" || model === "account") {
        sections.push(
          ``,
          `## Account object (Storage.account)`,
          `Set by device/add response: token, profile (id + name), email, user id.`,
          `Profiles partitioned via \`profile\` header on every API call.`
        );
      }

      if (model === "all" || model === "sync") {
        sections.push(
          ``,
          `## Sync architecture`,
          `| Data | REST | WebSocket |`,
          `|------|------|-----------|`,
          `| Bookmarks | ${m.sync.bookmarks} | websocket:bookmarks |`,
          `| Timeline | ${m.sync.timeline} | websocket:timeline |`,
          `| Storage arrays | ${m.sync.storage} | websocket:storage |`,
          ``,
          `Use \`cub_sync_guide\` and \`socket_protocol_map\` for full flow.`
        );
      }

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );

  // ── cub_sync_guide ───────────────────────────────────────────────────────────
  server.tool(
    "cub_sync_guide",
    "How Lampa syncs CUB cloud data: bookmark dump/changelog, timeline dump/changelog, WebSocket push, and Premium storage workers. Maps REST endpoints to sync code paths.",
    {},
    async () => {
      const out = [
        `# CUB Sync Architecture in Lampa`,
        ``,
        `## Bookmarks (\`src/core/account/bookmarks.js\`)`,
        `1. User adds/removes favorite → \`push_queue\` → \`Api.load('bookmarks/add|remove')\``,
        `2. On success → \`Socket.send('bookmarks')\` notifies other devices`,
        `3. Full sync every 10+ days → \`bookmarks/dump\``,
        `4. Incremental → \`bookmarks/changelog?since={version}\``,
        `5. Clear all → \`bookmarks/clear\``,
        ``,
        `## Timeline (\`src/core/account/timeline.js\`, \`src/interaction/timeline.js\`)`,
        `1. Local progress in \`file_view_{profileId}\` localStorage`,
        `2. On update → \`Socket.send('timeline', {params})\` if Premium`,
        `3. Full sync every 10+ days → \`timeline/dump\` (text JSON)`,
        `4. Incremental → \`timeline/changelog?since={version}\``,
        `5. Inbound WebSocket \`timeline\` → \`Timeline.update()\` if same profile`,
        ``,
        `## Cloud storage workers (\`src/core/storage/workers.js\`, Premium)`,
        `- REST: \`GET storage/data/{field}/{class_type}?full=true\``,
        `- WebSocket: \`Socket.send('storage', {params})\` for live sync`,
        `- Fields: search history, etc. (WorkerArray / WorkerObject)`,
        ``,
        `## WebSocket (\`src/core/socket.js\`)`,
        `| Inbound | Action |`,
        `|---------|--------|`,
        `| timeline | Update local watch progress |`,
        `| bookmarks | Trigger Account.Bookmarks.update() |`,
        `| storage | Update cloud storage field |`,
        `| open | Activity.push remote navigation |`,
        ``,
        `**Gated by:** \`lampa_settings.socket_use\`, \`socket_methods\`, \`Account.Permit.sync\``,
        ``,
        `Use \`cub_api_catalog\` with category=timeline or category=bookmarks for all endpoints.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text: out }] };
    }
  );

  // ── cub_timeline_hash_guide ──────────────────────────────────────────────────
  server.tool(
    "cub_timeline_hash_guide",
    "Timeline hash algorithm in Lampa: Utils.hash() and episodes_parser hash_string — keys for watch progress sync.",
    {
      example: z.enum(["movie", "tv"]).optional().describe("Show worked example."),
    },
    async ({ example }) => {
      const out = [
        `# Timeline Hash in Lampa`,
        ``,
        `**Implementation:** \`src/utils/utils.js\` → \`Utils.hash(input)\``,
        `**String builder:** \`src/utils/episodes_parser.js\` → \`hash_string\``,
        ``,
        `## Algorithm`,
        "```javascript",
        "function hash(input) {",
        "  let hash = 0;",
        "  for (let i = 0; i < str.length; i++) {",
        "    hash = ((hash << 5) - hash) + str.charCodeAt(i);",
        "    hash = hash & hash; // 32-bit",
        "  }",
        "  return Math.abs(hash);",
        "}",
        "```",
        ``,
        `## hash_string rules (episodes_parser.js)`,
        `- **Movie:** \`original_title\``,
        `- **TV:** \`season + (':' if season > 10 else '') + episode + original_title\``,
        `- **File:** \`data.path\` for local files`,
        ``,
        `## Usage`,
        `- Stored as key in \`file_view_{profileId}\` object`,
        `- Sent via \`Socket.send('timeline', {params})\` with hash, time, duration, percent`,
        `- Synced from cloud via \`timeline/dump\` and \`timeline/changelog\``,
      ];

      if (example === "movie") {
        out.push(
          ``,
          `## Example: movie`,
          `hash_string = card.original_title`,
          `hash = Utils.hash(hash_string)`
        );
      }
      if (example === "tv") {
        out.push(
          ``,
          `## Example: S01E03 "Severance"`,
          `hash_string = "1" + "" + "3" + "Severance" = "13Severance"`,
          `hash = Utils.hash("13Severance")`
        );
      }

      return { content: [{ type: "text" as const, text: out.join("\n") }] };
    }
  );
}
