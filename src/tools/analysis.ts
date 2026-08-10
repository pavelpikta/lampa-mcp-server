import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename } from "../fs/paths.js";
import { listFilesRecursive, fileExists } from "../utils/fs.js";
import { searchCode, getImports } from "../utils/search.js";
import { formatI18nKeys, formatI18nCoverage } from "../utils/lampa_deep.js";
import {
  findSettingsInRepo,
  findApiCallsInRepo,
  inferFeatureFiles,
  LAMPA_FEATURE_MAP,
  formatSettingsIndex,
  formatApiIndex,
} from "../utils/lampa.js";

export function registerAnalysisTools(server: McpServer, config: Config): void {
  // ── find_settings ──────────────────────────────────────────────────────────
  server.registerTool(
    "find_settings",
    {
      description:
        "Locate Lampa settings registrations, storage reads/writes, and default configs. Optionally filter by keyword.",
      inputSchema: {
        keyword: z.string().optional().describe("Filter settings by key name or module keyword."),
      },
    },
    async ({ keyword }) => {
      const indexed = await config.fs.readIndex?.("settings-catalog");
      if (indexed != null && !keyword) {
        return {
          content: [{ type: "text" as const, text: formatSettingsIndex(indexed) }],
        };
      }
      const result = await findSettingsInRepo(config.fs, keyword);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // ── find_api_calls ─────────────────────────────────────────────────────────
  server.registerTool(
    "find_api_calls",
    {
      description:
        "Locate external API calls, fetch wrappers, and provider integrations in the Lampa source.",
      inputSchema: {
        provider: z
          .string()
          .optional()
          .describe(
            "Narrow to a specific provider or plugin, e.g. 'filmix', 'rezka', 'tmdb_proxy'."
          ),
      },
    },
    async ({ provider }) => {
      const indexed = await config.fs.readIndex?.("api-integrations");
      if (indexed != null && !provider) {
        return {
          content: [{ type: "text" as const, text: formatApiIndex(indexed) }],
        };
      }
      const result = await findApiCallsInRepo(config.fs, provider);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  // ── find_ui_component ─────────────────────────────────────────────────────
  server.registerTool(
    "find_ui_component",
    {
      description: "Find Lampa UI component files (templates, components, views) by name.",
      inputSchema: {
        name: z
          .string()
          .describe("Component or template name to search for, e.g. 'card', 'player', 'modal'."),
      },
    },
    async ({ name }) => {
      const lower = name.toLowerCase();
      const files = await listFilesRecursive(config.fs, "", [".js", ".html", ".scss", ".css"]);
      const byFilename = files.filter((f) => basename(f).toLowerCase().includes(lower));

      const byContent = (await searchCode(config.fs, name, ["*.js", "*.html"], false))
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

  // ── i18n_check ─────────────────────────────────────────────────────────────
  server.registerTool(
    "i18n_check",
    {
      description:
        "Unified i18n tool. mode=keys finds translation key definitions/usages; mode=coverage compares all lang files against en.js.",
      inputSchema: {
        mode: z
          .enum(["keys", "coverage"])
          .describe("keys = look up definitions/usages; coverage = per-language coverage report."),
        key: z
          .string()
          .optional()
          .describe("For mode=keys: specific translation key, e.g. 'settings_language'."),
        show_missing: z
          .boolean()
          .optional()
          .describe("For mode=coverage: include missing/extra key lists. Default: true."),
      },
    },
    async ({ mode, key, show_missing = true }) => {
      const text =
        mode === "coverage"
          ? await formatI18nCoverage(config.fs, show_missing)
          : await formatI18nKeys(config.fs, key);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── find_translation_keys (alias of i18n_check mode=keys) ──────────────────
  server.registerTool(
    "find_translation_keys",
    {
      description:
        "Alias of i18n_check mode=keys. Find translation key definitions and usages across languages.",
      inputSchema: {
        key: z
          .string()
          .optional()
          .describe("Specific translation key to look up, e.g. 'settings_language'."),
      },
    },
    async ({ key }) => {
      const text = await formatI18nKeys(config.fs, key);
      return {
        content: [
          {
            type: "text" as const,
            text: `> Prefer \`i18n_check\` with mode=keys.\n\n${text}`,
          },
        ],
      };
    }
  );

  // ── find_styles_for_module ─────────────────────────────────────────────────
  server.registerTool(
    "find_styles_for_module",
    {
      description: "Find CSS/SCSS style files related to a module or feature name.",
      inputSchema: {
        module: z.string().describe("Module or feature name, e.g. 'iptv', 'player', 'card'."),
      },
    },
    async ({ module: mod }) => {
      const lower = mod.toLowerCase();
      const cssFiles = await listFilesRecursive(config.fs, "", [".css", ".scss"]);
      const direct = cssFiles.filter((f) => f.toLowerCase().includes(lower));

      const byContent = (await searchCode(config.fs, mod, ["*.css", "*.scss"], false))
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
  server.registerTool(
    "module_dependency_map",
    {
      description:
        "Map imports/requires for a file. Returns direct imports, inferred reverse dependencies, and change blast radius.",
      inputSchema: {
        file: z.string().describe("Repo-relative path, e.g. 'src/components/episodes.js'."),
      },
    },
    async ({ file }) => {
      if (!(await fileExists(config.fs, file))) {
        return { content: [{ type: "text", text: `File not found: ${file}` }] };
      }

      const imports = await getImports(config.fs, file);

      const base = basename(file).replace(/\.[^.]+$/, "");
      const reverseMatches = (await searchCode(config.fs, base, ["*.js", "*.ts"], false))
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
  server.registerTool(
    "find_feature",
    {
      description:
        "Infer all files relevant to a named Lampa feature: player, catalog, search, settings, cards, parser, bookmarks, iptv, etc.",
      inputSchema: {
        feature_name: z
          .string()
          .describe("Feature name, e.g. 'player', 'catalog', 'iptv', 'search'."),
      },
    },
    async ({ feature_name }) => {
      const files = await inferFeatureFiles(config.fs, feature_name);

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
