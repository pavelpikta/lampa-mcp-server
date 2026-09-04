import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RepoFs } from "../fs/types.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import {
  extractLampaCubApi,
  findLampaCubEndpoint,
  CUB_DATA_MODELS,
  type LampaCubEndpoint,
} from "../utils/cub.js";
import { READ_ONLY_SNAPSHOT, fail, ok, reportOutput } from "./meta.js";

async function formatEndpointDetail(ep: LampaCubEndpoint, fs: RepoFs): Promise<string> {
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

  const first = ep.files[0];
  if (first && first.line > 0) {
    const content = await readFileSafe(fs, first.file);
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

function indexText(indexed: unknown): string {
  return typeof indexed === "string" ? indexed : JSON.stringify(indexed, null, 2);
}

const CUB_CATEGORIES = [
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
] as const;

export function registerCubTools(server: McpServer, config: Config): void {
  server.registerTool(
    "guide_cub",
    {
      title: "Guide to CUB cloud APIs in Lampa",
      description:
        "Document how Lampa talks to CUB from source — this makes no network calls of its own (pure snapshot read, no auth needed to call this tool), and is not a substitute for cub.rip/developer. Returns markdown text (see output schema), never raw JSON. Unlike `list_catalog` topic=mirrors/socket, this is CUB-specific.\n`topic=catalog` lists REST paths (`category`/`search` filter the catalog only, no effect on other topics); `endpoint` requires `path` (e.g. `bookmarks/dump`) and ignores `category`/`search`; `auth` reads `auth_focus` only (device/add, headers, Permit, Premium, mirrors); `models` reads `model` only (bookmark/timeline/favorite shapes); `sync` takes no parameters and maps dump/changelog/WebSocket; `timeline_hash` reads `example` only and explains Utils.hash. Passing any parameter that does not apply to the chosen `topic` is silently ignored, never an error.",
      inputSchema: {
        topic: z
          .enum(["catalog", "endpoint", "auth", "models", "sync", "timeline_hash"])
          .describe(
            "catalog=endpoint table; endpoint=one path; auth=login/headers; models=schemas; sync=dump/changelog; timeline_hash=hash algorithm."
          ),
        path: z
          .string()
          .optional()
          .describe("For topic=endpoint: path such as 'bookmarks/dump' or 'device/add'."),
        category: z
          .enum(CUB_CATEGORIES)
          .optional()
          .describe("For topic=catalog: filter by API category. Default all."),
        search: z.string().optional().describe("For topic=catalog: filter by path substring."),
        auth_focus: z
          .enum(["overview", "device", "headers", "permit", "premium", "mirrors"])
          .optional()
          .describe("For topic=auth: focus area. Default overview."),
        model: z
          .enum(["all", "bookmarks", "timeline", "favorites", "account", "sync"])
          .optional()
          .describe("For topic=models: which schema. Default all."),
        example: z
          .enum(["movie", "tv"])
          .optional()
          .describe("For topic=timeline_hash: worked example."),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async (args) => {
      if (!(await fileExists(config.fs))) {
        return fail(`Lampa repo not found: ${config.label}`);
      }
      switch (args.topic) {
        case "catalog":
          return cubCatalog(config, args.category ?? "all", args.search);
        case "endpoint":
          if (!args.path) return fail("topic=endpoint requires path, e.g. 'bookmarks/dump'.");
          return cubEndpoint(config, args.path);
        case "auth":
          return cubAuth(args.auth_focus ?? "overview");
        case "models":
          return cubModels(args.model ?? "all");
        case "sync":
          return cubSync();
        case "timeline_hash":
          return cubTimelineHash(args.example);
        default:
          return fail("Unknown topic.");
      }
    }
  );
}

async function cubCatalog(config: Config, category: string, search?: string) {
  const indexed = await config.fs.readIndex?.("cub-api");
  let endpoints: LampaCubEndpoint[];
  if (Array.isArray(indexed)) {
    endpoints = indexed as LampaCubEndpoint[];
  } else if (indexed != null && category === "all" && !search) {
    return ok(indexText(indexed));
  } else {
    endpoints = await extractLampaCubApi(config.fs);
  }
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
  return ok(
    [
      `# Lampa CUB API Catalog  (${endpoints.length} endpoints)`,
      ``,
      `Extracted from: \`${config.label}\` — source only, not a live CUB call.`,
      `**REST base:** \`{protocol}://{Manifest.cub_domain}/api/\``,
      `**Auth:** \`token\` + \`profile\` headers via Account.Permit`,
      `**Docs:** https://cub.rip/developer/`,
      ``,
      ...sections,
      ``,
      `Use guide_cub topic=endpoint with path=… for params and source context.`,
    ].join("\n\n")
  );
}

async function cubEndpoint(config: Config, endpointPath: string) {
  const ep = await findLampaCubEndpoint(config.fs, endpointPath);
  if (!ep) {
    const all = await extractLampaCubApi(config.fs);
    const sample = all
      .slice(0, 15)
      .map((e) => e.path)
      .join(", ");
    return fail(
      `Endpoint "${endpointPath}" not found in Lampa source.\n\nSample paths: ${sample}\n\nUse guide_cub topic=catalog.`
    );
  }
  return ok(await formatEndpointDetail(ep, config.fs));
}

function cubAuth(topic: string) {
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
      `**Storage keys:** \`account\`, \`account_email\``
    );
  }
  if (topic === "overview" || topic === "headers") {
    sections.push(
      ``,
      `## Request headers`,
      `| Header | Source |`,
      `|--------|--------|`,
      `| \`token\` | \`${m.headers.token}\` |`,
      `| \`profile\` | \`${m.headers.profile}\` |`
    );
  }
  if (topic === "overview" || topic === "permit") {
    sections.push(
      ``,
      `## Account.Permit gating`,
      `- \`Permit.token\` — API access allowed`,
      `- \`Permit.access\` — account features enabled`,
      `- \`Permit.sync\` — bookmark/timeline sync`,
      `- Disabled when: iptv mode, read_only, account_use: false`
    );
  }
  if (topic === "overview" || topic === "premium") {
    sections.push(
      ``,
      `## Premium features`,
      `- Timeline sync, cloud storage workers, TMDB image/API proxy`,
      `- Check: \`Account.hasPremium()\``
    );
  }
  if (topic === "overview" || topic === "mirrors") {
    sections.push(
      ``,
      `## Mirrors`,
      `- \`Manifest.cub_mirrors\` — cub.rip plus user-added`,
      `- \`Manifest.cub_domain\` — active mirror`,
      `- Use list_catalog topic=mirrors for full resolution logic`
    );
  }
  return ok(sections.join("\n"));
}

function cubModels(model: string) {
  const m = CUB_DATA_MODELS;
  const sections: string[] = ["# CUB Data Models (Lampa)"];
  if (model === "all" || model === "bookmarks") {
    sections.push(
      ``,
      `## Bookmarks`,
      `**Public types:** ${m.bookmarkTypes.public.map((t) => `\`${t}\``).join(", ")}`,
      `**Internal types (sync):** ${m.bookmarkTypes.internal.map((t) => `\`${t}\``).join(", ")}`,
      ``,
      "```json",
      JSON.stringify(m.bookmarkRecord, null, 2),
      "```"
    );
  }
  if (model === "all" || model === "timeline") {
    sections.push(
      ``,
      `## Timeline (Premium)`,
      `**Local storage key:** \`${m.timeline.localKey}\``,
      "```json",
      JSON.stringify(m.timeline.dump, null, 2),
      "```",
      `**Hash:** ${m.timeline.hash}`
    );
  }
  if (model === "all" || model === "favorites") {
    sections.push(
      ``,
      `## Favorite categories`,
      `Mapped 1:1 to bookmark types. Use list_catalog topic=favorites for the full list.`
    );
  }
  if (model === "all" || model === "account") {
    sections.push(
      ``,
      `## Account object (Storage.account)`,
      `Set by device/add response: token, profile (id + name), email, user id.`
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
      `| Storage arrays | ${m.sync.storage} | websocket:storage |`
    );
  }
  return ok(sections.join("\n"));
}

function cubSync() {
  return ok(
    [
      `# CUB Sync Architecture in Lampa`,
      ``,
      `## Bookmarks (\`src/core/account/bookmarks.js\`)`,
      `1. User adds/removes favorite → push_queue → Api.load('bookmarks/add|remove')`,
      `2. On success → Socket.send('bookmarks') notifies other devices`,
      `3. Full sync every 10+ days → bookmarks/dump`,
      `4. Incremental → bookmarks/changelog?since={version}`,
      ``,
      `## Timeline (\`src/core/account/timeline.js\`)`,
      `1. Local progress in file_view_{profileId} localStorage`,
      `2. On update → Socket.send('timeline', {params}) if Premium`,
      `3. Full sync → timeline/dump; incremental → timeline/changelog`,
      ``,
      `## Cloud storage workers (Premium)`,
      `- REST: GET storage/data/{field}/{class_type}?full=true`,
      `- WebSocket: Socket.send('storage', {params})`,
      ``,
      `Gated by lampa_settings.socket_use, socket_methods, Account.Permit.sync`,
    ].join("\n")
  );
}

function cubTimelineHash(example?: "movie" | "tv") {
  const out = [
    `# Timeline Hash in Lampa`,
    ``,
    `**Implementation:** src/utils/utils.js → Utils.hash(input)`,
    `**String builder:** src/utils/episodes_parser.js → hash_string`,
    ``,
    `## hash_string rules`,
    `- Movie: original_title`,
    `- TV: season + (':' if season > 10 else '') + episode + original_title`,
    `- File: data.path for local files`,
  ];
  if (example === "movie") {
    out.push(``, `## Example: movie`, `hash_string = card.original_title`);
  }
  if (example === "tv") {
    out.push(
      ``,
      `## Example: S01E03 "Severance"`,
      `hash_string = "1" + "" + "3" + "Severance" = "13Severance"`
    );
  }
  return ok(out.join("\n"));
}
