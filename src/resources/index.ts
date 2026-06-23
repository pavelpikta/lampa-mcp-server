import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import fs from "node:fs";
import type { Config } from "../config.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import { findSettingsInRepo, findApiCallsInRepo } from "../utils/lampa.js";

interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

export function registerResources(server: McpServer, config: Config): void {
  // resource://repo/overview
  server.resource(
    "repo-overview",
    "repo://overview",
    { mimeType: "text/plain", description: "High-level repo structure and entrypoints." },
    async () => {
      const repoPath = config.repoPath;
      if (!fileExists(repoPath)) {
        return { contents: [{ uri: "repo://overview", text: `Repo not found at ${repoPath}` }] };
      }
      const top = fs
        .readdirSync(repoPath, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n");
      return {
        contents: [{ uri: "repo://overview", text: `Lampa repo at ${repoPath}\n\n${top}` }],
      };
    }
  );

  // resource://repo/scripts
  server.resource(
    "repo-scripts",
    "repo://scripts",
    { mimeType: "application/json", description: "NPM scripts from package.json." },
    async () => {
      const pkg = readFileSafe(path.join(config.repoPath, "package.json"));
      const scripts = pkg ? ((JSON.parse(pkg) as PackageJson).scripts ?? {}) : {};
      return { contents: [{ uri: "repo://scripts", text: JSON.stringify(scripts, null, 2) }] };
    }
  );

  // resource://docs/index
  server.resource(
    "docs-index",
    "docs://index",
    {
      mimeType: "text/plain",
      description: "Generated documentation index (requires npm run doc first).",
    },
    async () => {
      const docsIndex = path.join(config.docsPath, "index.html");
      if (!fileExists(docsIndex)) {
        return {
          contents: [
            { uri: "docs://index", text: "Docs not generated. Run `npm run doc` in the repo." },
          ],
        };
      }
      const raw = (readFileSafe(docsIndex) ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { contents: [{ uri: "docs://index", text: raw.slice(0, 8000) }] };
    }
  );

  // resource://settings/catalog
  server.resource(
    "settings-catalog",
    "settings://catalog",
    { mimeType: "text/plain", description: "All settings registrations found in the repo." },
    async () => {
      const result = findSettingsInRepo(config.repoPath);
      return { contents: [{ uri: "settings://catalog", text: result }] };
    }
  );

  // resource://api/integrations
  server.resource(
    "api-integrations",
    "api://integrations",
    { mimeType: "text/plain", description: "All external API call sites found in the repo." },
    async () => {
      const result = findApiCallsInRepo(config.repoPath);
      return { contents: [{ uri: "api://integrations", text: result }] };
    }
  );
}
