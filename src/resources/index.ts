import type { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import { joinRepo } from "../fs/paths.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import { findSettingsInRepo, findApiCallsInRepo } from "../utils/lampa.js";
import { extractLampaCubApi } from "../utils/cub.js";

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

function indexText(indexed: unknown): string {
  return typeof indexed === "string" ? indexed : JSON.stringify(indexed, null, 2);
}

export function registerResources(server: McpServer, config: Config): void {
  // resource://repo/overview
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

  // resource://repo/scripts
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

  // resource://docs/index
  server.registerResource(
    "docs-index",
    "docs://index",
    {
      description: "Generated documentation index (requires npm run doc first).",
    },
    async (uri) => {
      const docsIndex = joinRepo(config.docsPath, "index.html");
      if (!(await fileExists(config.fs, docsIndex))) {
        return {
          contents: [
            { uri: uri.href, text: "Docs not generated. Run `npm run doc` in the repo." },
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

  // resource://settings/catalog
  server.registerResource(
    "settings-catalog",
    "settings://catalog",
    { description: "All settings registrations found in the repo." },
    async (uri) => {
      const indexed = await config.fs.readIndex?.("settings-catalog");
      if (indexed != null) {
        return { contents: [{ uri: uri.href, text: indexText(indexed) }] };
      }
      const result = await findSettingsInRepo(config.fs);
      return { contents: [{ uri: uri.href, text: result }] };
    }
  );

  // resource://api/integrations
  server.registerResource(
    "api-integrations",
    "api://integrations",
    { description: "All external API call sites found in the repo." },
    async (uri) => {
      const indexed = await config.fs.readIndex?.("api-integrations");
      if (indexed != null) {
        return { contents: [{ uri: uri.href, text: indexText(indexed) }] };
      }
      const result = await findApiCallsInRepo(config.fs);
      return { contents: [{ uri: uri.href, text: result }] };
    }
  );

  // resource://cub/lampa-api
  server.registerResource(
    "cub-lampa-api",
    "cub://lampa-api",
    {
      description: "CUB API endpoints catalog extracted from Lampa source.",
    },
    async (uri) => {
      const indexed = await config.fs.readIndex?.("cub-api");
      if (indexed != null) {
        return { contents: [{ uri: uri.href, text: indexText(indexed) }] };
      }
      const endpoints = await extractLampaCubApi(config.fs);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(endpoints, null, 2) }],
      };
    }
  );
}
