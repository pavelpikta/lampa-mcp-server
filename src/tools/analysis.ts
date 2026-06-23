import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { Config } from "../config.js";
import { listFilesRecursive, readFileSafe, fileExists } from "../utils/fs.js";
import { searchCode, getImports } from "../utils/search.js";
import { parseLangFile } from "../utils/lampa_deep.js";
import {
  findSettingsInRepo,
  findApiCallsInRepo,
  inferFeatureFiles,
  LAMPA_FEATURE_MAP,
} from "../utils/lampa.js";

export function registerAnalysisTools(server: McpServer, config: Config): void {
  // ── find_settings ──────────────────────────────────────────────────────────
  server.tool(
    "find_settings",
    "Locate Lampa settings registrations, storage reads/writes, and default configs. Optionally filter by keyword.",
    {
      keyword: z.string().optional().describe("Filter settings by key name or module keyword."),
    },
    async ({ keyword }) => {
      const result = findSettingsInRepo(config.repoPath, keyword);
      return { content: [{ type: "text", text: result }] };
    }
  );

  // ── find_api_calls ─────────────────────────────────────────────────────────
  server.tool(
    "find_api_calls",
    "Locate external API calls, fetch wrappers, and provider integrations in the Lampa source.",
    {
      provider: z
        .string()
        .optional()
        .describe("Narrow to a specific provider or plugin, e.g. 'filmix', 'rezka', 'tmdb_proxy'."),
    },
    async ({ provider }) => {
      const result = findApiCallsInRepo(config.repoPath, provider);
      return { content: [{ type: "text", text: result }] };
    }
  );

  // ── find_ui_component ─────────────────────────────────────────────────────
  server.tool(
    "find_ui_component",
    "Find Lampa UI component files (templates, components, views) by name.",
    {
      name: z
        .string()
        .describe("Component or template name to search for, e.g. 'card', 'player', 'modal'."),
    },
    async ({ name }) => {
      const lower = name.toLowerCase();
      const files = listFilesRecursive(config.repoPath, [".js", ".html", ".scss", ".css"]);
      const byFilename = files
        .filter((f) => path.basename(f).toLowerCase().includes(lower))
        .map((f) => path.relative(config.repoPath, f));

      const byContent = searchCode(config.repoPath, name, ["*.js", "*.html"], false)
        .filter(
          (m) =>
            m.text.toLowerCase().includes("template") ||
            m.text.toLowerCase().includes("component") ||
            m.text.toLowerCase().includes("render") ||
            m.text.toLowerCase().includes("create")
        )
        .slice(0, 20)
        .map((m) => `${m.file}:${m.line}  ${m.text}`);

      const out = [
        `## Files matching "${name}"`,
        byFilename.join("\n") || "None.",
        ``,
        `## Code references (template/component/render context)`,
        byContent.join("\n") || "None.",
      ].join("\n");

      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── find_translation_keys ──────────────────────────────────────────────────
  server.tool(
    "find_translation_keys",
    "Find translation key definitions and usages across all supported languages.",
    {
      key: z
        .string()
        .optional()
        .describe("Specific translation key to look up, e.g. 'settings_language'."),
    },
    async ({ key }) => {
      const srcLangDir = path.join(config.repoPath, "src", "lang");
      const pubLangDir = path.join(config.repoPath, "public", "lang");
      const langDir = fileExists(srcLangDir)
        ? srcLangDir
        : fileExists(pubLangDir)
          ? pubLangDir
          : null;

      if (!langDir) {
        return {
          content: [
            { type: "text", text: "No lang directory found (checked src/lang/ and public/lang/)." },
          ],
        };
      }

      const langFiles = listFilesRecursive(langDir, [".js"]).filter((f) => !f.endsWith("meta.js"));

      if (key) {
        const results: string[] = [];
        for (const lf of langFiles) {
          const content = readFileSafe(lf);
          if (!content) continue;
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(key)) {
              results.push(`${path.basename(lf)}:${i + 1}  ${lines[i].trim()}`);
            }
          }
        }
        const usages = searchCode(config.repoPath, `Lang.translate('${key}'`, ["*.js"], false)
          .concat(searchCode(config.repoPath, `Lang.translate("${key}"`, ["*.js"], false))
          .slice(0, 10)
          .map((m) => `${m.file}:${m.line}  ${m.text.trim()}`);

        const out = [
          results.length > 0 ? results.join("\n") : `Key "${key}" not found in lang files.`,
          usages.length > 0 ? `\n## Usages\n${usages.join("\n")}` : "",
        ].join("\n");

        return { content: [{ type: "text", text: out }] };
      }

      const enFile = path.join(langDir, "en.js");
      const keys = parseLangFile(enFile);
      const langFilenames = langFiles.map((f) => path.basename(f));
      const relDir = path.relative(config.repoPath, langDir);

      return {
        content: [
          {
            type: "text",
            text: `Language directory: ${relDir}/\nFiles: ${langFilenames.join(", ")}\n\nKeys in en.js (${keys.length}):\n${keys.join(", ")}`,
          },
        ],
      };
    }
  );

  // ── find_styles_for_module ─────────────────────────────────────────────────
  server.tool(
    "find_styles_for_module",
    "Find CSS/SCSS style files related to a module or feature name.",
    {
      module: z.string().describe("Module or feature name, e.g. 'iptv', 'player', 'card'."),
    },
    async ({ module: mod }) => {
      const lower = mod.toLowerCase();
      const cssFiles = listFilesRecursive(config.repoPath, [".css", ".scss"]);
      const direct = cssFiles
        .filter((f) => {
          const rel = path.relative(config.repoPath, f).toLowerCase();
          return rel.includes(lower);
        })
        .map((f) => path.relative(config.repoPath, f));

      const byContent = searchCode(config.repoPath, mod, ["*.css", "*.scss"], false)
        .slice(0, 15)
        .map((m) => `${m.file}:${m.line}  ${m.text}`);

      const out = [
        `## CSS/SCSS files for "${mod}"`,
        direct.join("\n") || "None.",
        ``,
        `## Style references mentioning "${mod}"`,
        byContent.join("\n") || "None.",
      ].join("\n");

      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── module_dependency_map ──────────────────────────────────────────────────
  server.tool(
    "module_dependency_map",
    "Map imports/requires for a file. Returns direct imports, inferred reverse dependencies, and change blast radius.",
    {
      file: z.string().describe("Repo-relative path, e.g. 'src/components/episodes.js'."),
    },
    async ({ file }) => {
      const abs = path.join(config.repoPath, file);
      if (!fileExists(abs)) {
        return { content: [{ type: "text", text: `File not found: ${file}` }] };
      }

      const imports = getImports(abs, config.repoPath);

      // Reverse: find who imports this file
      const basename = path.basename(file, path.extname(file));
      const reverseMatches = searchCode(config.repoPath, basename, ["*.js", "*.ts"], false)
        .filter((m) => m.text.includes("require") || m.text.includes("import"))
        .filter((m) => m.file !== file)
        .slice(0, 20);

      const out = [
        `## Dependency map: ${file}`,
        ``,
        `### Direct imports (${imports.length})`,
        imports.join("\n") || "None.",
        ``,
        `### Likely imported by (reverse, by filename match)`,
        reverseMatches.map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n") || "None found.",
        ``,
        `### Blast radius note`,
        reverseMatches.length > 5
          ? `⚠ This module is referenced in ${reverseMatches.length}+ places. Changes here are high-impact.`
          : `This module has ${reverseMatches.length} known reverse dependencies. Changes are relatively contained.`,
      ].join("\n");

      return { content: [{ type: "text", text: out }] };
    }
  );

  // ── find_feature ──────────────────────────────────────────────────────────
  server.tool(
    "find_feature",
    "Infer all files relevant to a named Lampa feature: player, catalog, search, settings, cards, parser, bookmarks, iptv, etc.",
    {
      feature_name: z
        .string()
        .describe("Feature name, e.g. 'player', 'catalog', 'iptv', 'search'."),
    },
    async ({ feature_name }) => {
      const files = inferFeatureFiles(config.repoPath, feature_name);

      const knownKeys = Object.keys(LAMPA_FEATURE_MAP).filter(
        (k) => feature_name.toLowerCase().includes(k) || k.includes(feature_name.toLowerCase())
      );

      const out = [
        `## Feature: "${feature_name}"`,
        ``,
        `### Matched feature categories: ${knownKeys.join(", ") || "none (generic filename match only)"}`,
        ``,
        `### Relevant files (${files.length})`,
        files.join("\n") || "No files found.",
        ``,
        `### Next steps`,
        `- Use \`read_file_segment\` to inspect any file above`,
        `- Use \`module_dependency_map\` to understand blast radius`,
        `- Use \`plan_feature_change\` before making edits`,
      ].join("\n");

      return { content: [{ type: "text", text: out }] };
    }
  );
}
