import type { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import { joinRepo } from "../fs/paths.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import {
  findSettingsInRepo,
  findApiCallsInRepo,
  formatSettingsIndex,
  formatApiIndex,
  LAMPA_LANDMARKS,
  LAMPA_EDIT_RULES,
  LAMPA_API_SURFACE_KEYS,
} from "../utils/lampa.js";
import { extractLampaCubApi } from "../utils/cub.js";
import {
  formatPluginGuideToc,
  PLUGIN_EVENTS_CHEATSHEET,
  readPluginChapter,
} from "../utils/plugin_docs.js";

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

export function registerResources(server: McpServer, config: Config): void {
  server.registerResource(
    "repo-overview",
    "repo://overview",
    { description: "High-level repo structure and entrypoints." },
    async (uri) => {
      if (!(await fileExists(config.fs))) {
        return {
          contents: [{ uri: uri.href, text: `Repo not found at ${config.label}` }],
        };
      }
      const top = (await config.fs.listDir())
        .map((e) => `${e.type === "dir" ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n");
      return {
        contents: [{ uri: uri.href, text: `Lampa repo at ${config.label}\n\n${top}` }],
      };
    }
  );

  server.registerResource(
    "repo-scripts",
    "repo://scripts",
    { description: "NPM scripts from package.json." },
    async (uri) => {
      const pkg = await readFileSafe(config.fs, "package.json");
      const scripts = pkg ? ((JSON.parse(pkg) as PackageJson).scripts ?? {}) : {};
      return { contents: [{ uri: uri.href, text: JSON.stringify(scripts, null, 2) }] };
    }
  );

  server.registerResource(
    "docs-index",
    "docs://index",
    {
      description:
        "Official Lampa plugin-guide table of contents (docs/en). Falls back to generated JSDoc if plugin docs are missing.",
    },
    async (uri) => {
      const toc = await formatPluginGuideToc(config.fs, config.pluginDocsPath, "en");
      if (await fileExists(config.fs, joinRepo(config.pluginDocsPath, "en/README.md"))) {
        return { contents: [{ uri: uri.href, text: toc }] };
      }
      const docsIndex = joinRepo(config.docsPath, "index.html");
      if (!(await fileExists(config.fs, docsIndex))) {
        return {
          contents: [
            {
              uri: uri.href,
              text: "Plugin docs not found at docs/en. Generated JSDoc (npm run doc) is also missing.",
            },
          ],
        };
      }
      const raw = ((await readFileSafe(config.fs, docsIndex)) ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { contents: [{ uri: uri.href, text: raw.slice(0, 8000) }] };
    }
  );

  server.registerResource(
    "settings-catalog",
    "settings://catalog",
    { description: "All settings registrations found in the repo." },
    async (uri) => {
      const indexed = await config.fs.readIndex?.("settings-catalog");
      if (indexed != null) {
        return { contents: [{ uri: uri.href, text: formatSettingsIndex(indexed) }] };
      }
      const result = await findSettingsInRepo(config.fs);
      return { contents: [{ uri: uri.href, text: result }] };
    }
  );

  server.registerResource(
    "api-integrations",
    "api://integrations",
    { description: "All external API call sites found in the repo." },
    async (uri) => {
      const indexed = await config.fs.readIndex?.("api-integrations");
      if (indexed != null) {
        return { contents: [{ uri: uri.href, text: formatApiIndex(indexed) }] };
      }
      const result = await findApiCallsInRepo(config.fs);
      return { contents: [{ uri: uri.href, text: result }] };
    }
  );

  server.registerResource(
    "cub-lampa-api",
    "cub://lampa-api",
    {
      description: "CUB API endpoints catalog extracted from Lampa source.",
    },
    async (uri) => {
      const indexed = await config.fs.readIndex?.("cub-api");
      if (indexed != null) {
        return {
          contents: [
            {
              uri: uri.href,
              text: Array.isArray(indexed)
                ? JSON.stringify(indexed, null, 2)
                : typeof indexed === "string"
                  ? indexed
                  : JSON.stringify(indexed, null, 2),
            },
          ],
        };
      }
      const endpoints = await extractLampaCubApi(config.fs);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(endpoints, null, 2) }],
      };
    }
  );

  server.registerResource(
    "lampa-landmarks",
    "lampa://landmarks",
    {
      description:
        "Ordered landmark files agents should read first when working on Lampa (roles included).",
    },
    async (uri) => {
      const lines = LAMPA_LANDMARKS.map((l, i) => `${i + 1}. \`${l.path}\` — ${l.role}`);
      return {
        contents: [
          {
            uri: uri.href,
            text: `# Lampa landmarks\n\n${lines.join("\n")}`,
          },
        ],
      };
    }
  );

  server.registerResource(
    "lampa-edit-rules",
    "lampa://edit-rules",
    {
      description:
        "What to edit vs avoid (src/plugins vs public/build). Prevents agents from changing generated copies.",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: LAMPA_EDIT_RULES }],
    })
  );

  server.registerResource(
    "lampa-api-surface",
    "lampa://api-surface",
    {
      description: "Keys exported on window.Lampa from src/app.js initClass (plugin-visible API).",
    },
    async (uri) => {
      const text = [
        `# window.Lampa API surface`,
        ``,
        `Source: \`src/app.js\` → \`initClass()\`.`,
        `Deprecated for new work: InteractionMain, InteractionCategory, InteractionLine (see UPGRADE.md).`,
        ``,
        ...LAMPA_API_SURFACE_KEYS.map((k) => `- Lampa.${k}`),
      ].join("\n");
      return { contents: [{ uri: uri.href, text }] };
    }
  );

  server.registerResource(
    "lampa-plugin-guide",
    "lampa://plugin-guide",
    {
      description:
        "Official Lampa plugin development guide TOC, bootstrap snippet, and window.Lampa cheatsheet (docs/en).",
    },
    async (uri) => {
      const text = await formatPluginGuideToc(config.fs, config.pluginDocsPath, "en");
      return { contents: [{ uri: uri.href, text }] };
    }
  );

  server.registerResource(
    "lampa-pitfalls",
    "lampa://pitfalls",
    {
      description: "Official plugin pitfalls (docs/en/11-pitfalls.md) — anti-patterns not to emit.",
    },
    async (uri) => {
      const chapter = await readPluginChapter(config.fs, config.pluginDocsPath, "pitfalls", "en");
      return {
        contents: [
          {
            uri: uri.href,
            text: chapter?.text ?? "docs/en/11-pitfalls.md not found in the Lampa snapshot.",
          },
        ],
      };
    }
  );

  server.registerResource(
    "lampa-events",
    "lampa://events",
    {
      description:
        "Condensed plugin event catalog (Listener, Player, PlayerVideo, Storage, Favorite, Keypad).",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: PLUGIN_EVENTS_CHEATSHEET }],
    })
  );
}
