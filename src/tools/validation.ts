import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename, joinRepo } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { findMissingLangKeys } from "../utils/lampa_modern.js";
import {
  formatDocHits,
  formatPluginGuideToc,
  PLUGIN_DOC_CHAPTERS,
  readPluginChapter,
  resolveChapter,
  searchPluginDocs,
} from "../utils/plugin_docs.js";

export function registerValidationTools(server: McpServer, config: Config): void {
  // ── run_grep_checks ────────────────────────────────────────────────────────
  server.registerTool(
    "run_grep_checks",
    {
      description:
        "Run a set of code-quality grep checks across the repo: undefined references, console.log leftovers, TODO markers, missing translations.",
      inputSchema: {
        checks: z
          .array(
            z.enum([
              "todos",
              "console_logs",
              "undefined_refs",
              "missing_lang_keys",
              "hardcoded_strings",
            ])
          )
          .optional()
          .describe("Which checks to run. Defaults to all."),
      },
    },
    async ({ checks }) => {
      const all = [
        "todos",
        "console_logs",
        "undefined_refs",
        "missing_lang_keys",
        "hardcoded_strings",
      ];
      const toRun = checks ?? all;
      const results: string[] = [];

      if (toRun.includes("todos")) {
        const hits = (await searchCode(config.fs, "TODO", ["*.js", "*.ts"], false)).slice(0, 20);
        results.push(
          `## TODOs (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      if (toRun.includes("console_logs")) {
        const hits = (await searchCode(config.fs, "console.log", ["*.js", "*.ts"], false)).slice(
          0,
          20
        );
        results.push(
          `## console.log (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      if (toRun.includes("undefined_refs")) {
        const hits = (await searchCode(config.fs, "undefined", ["*.js"], false))
          .filter((h) => h.text.includes("=== undefined") || h.text.includes("== undefined"))
          .slice(0, 15);
        results.push(
          `## Loose undefined checks (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      if (toRun.includes("missing_lang_keys")) {
        const { missing, enKeyCount, langDir } = await findMissingLangKeys(config.fs);
        const sample = missing.slice(0, 30);
        results.push(
          `## Missing translation keys (${missing.length} of ${enKeyCount} en.js keys used in code)\n` +
            `Reference: ${langDir}/en.js\n` +
            (sample.length > 0
              ? sample.map((k) => `- \`${k}\``).join("\n") +
                (missing.length > 30
                  ? `\n… and ${missing.length - 30} more. Use i18n_check mode=coverage for full report.`
                  : "")
              : "All Lang.translate() keys found in en.js.")
        );
      }

      if (toRun.includes("hardcoded_strings")) {
        const hits = (await searchCode(config.fs, 'innerHTML = "', ["*.js"], false)).slice(0, 10);
        results.push(
          `## Hardcoded innerHTML strings (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    }
  );

  // ── list_related_tests ─────────────────────────────────────────────────────
  server.registerTool(
    "list_related_tests",
    {
      description: "Find test/spec files related to a module or feature.",
      inputSchema: {
        module: z.string().describe("Module name or feature keyword."),
      },
    },
    async ({ module: mod }) => {
      const hasSpec = await fileExists(config.fs, "spec");
      const specFiles = hasSpec
        ? await listFilesRecursive(config.fs, "spec", [".js", ".ts", ".spec.js"])
        : [];

      const lower = mod.toLowerCase();
      const direct = specFiles.filter((f) => basename(f).toLowerCase().includes(lower));

      const byContent: string[] = [];
      for (const f of specFiles) {
        const content = (await readFileSafe(config.fs, f)) ?? "";
        if (content.toLowerCase().includes(lower)) byContent.push(f);
      }

      const all = [...new Set([...direct, ...byContent])];

      return {
        content: [
          {
            type: "text",
            text:
              all.length > 0
                ? `Related specs for "${mod}":\n${all.join("\n")}`
                : `No spec files found for "${mod}". Spec directory: ${hasSpec ? "exists (spec/)" : "not found"}.`,
          },
        ],
      };
    }
  );

  // ── run_build_hint ─────────────────────────────────────────────────────────
  server.registerTool(
    "run_build_hint",
    {
      description:
        "Return the correct build/dev/test command for the Lampa project based on package.json scripts.",
      inputSchema: {
        goal: z.enum(["build", "dev", "test", "doc", "lint"]).describe("What you want to do."),
      },
    },
    async ({ goal }) => {
      const pkg = await readFileSafe(config.fs, "package.json");
      if (!pkg) return { content: [{ type: "text", text: "No package.json found." }] };

      const data = JSON.parse(pkg) as { scripts?: Record<string, string> };
      const scripts: Record<string, string> = data.scripts ?? {};

      if (goal === "dev") {
        const lines = [
          `# Lampa local development (plugin docs ch.12)`,
          ``,
          scripts.start
            ? `- \`npm run start\` → ${scripts.start}  (watch + BrowserSync, typically http://localhost:3000)`
            : "- `npm run start` — not in package.json; check gulpfile.js",
          scripts.debug
            ? `- \`npm run debug\` → ${scripts.debug}  (same as start with inline sourcemaps)`
            : "",
          scripts.watch ? `- \`npm run watch\` → ${scripts.watch}` : "",
          ``,
          `Platform \`browser\` is detected automatically. Load a remote plugin via Settings → Extensions.`,
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const candidates: Record<string, string[]> = {
        build: ["build", "compile", "bundle"],
        dev: ["dev", "start", "watch", "serve"],
        test: ["test", "spec"],
        doc: ["doc", "docs", "jsdoc"],
        lint: ["lint", "eslint"],
      };

      const matches = candidates[goal]
        .map((k) => (scripts[k] ? `npm run ${k}  →  ${scripts[k]}` : null))
        .filter((v): v is string => v !== null);

      if (matches.length === 0) {
        const gulpFile = await fileExists(config.fs, "gulpfile.js");
        if (gulpFile && goal === "build") {
          return {
            content: [
              {
                type: "text",
                text: "No npm build script found, but gulpfile.js is present. Try: gulp",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `No "${goal}" script found. Available scripts: ${Object.keys(scripts).join(", ")}`,
            },
          ],
        };
      }

      return { content: [{ type: "text", text: matches.join("\n") }] };
    }
  );

  // ── plugin_docs ────────────────────────────────────────────────────────────
  server.registerTool(
    "plugin_docs",
    {
      description:
        "Read or search the official Lampa plugin guide (docs/en or docs/ru). Pass chapter (e.g. pitfalls, settings, player) or a free-text query.",
      inputSchema: {
        chapter: z
          .string()
          .optional()
          .describe(
            "Chapter id or alias: 01–13, getting-started, lifecycle, events, settings, pitfalls, controller, …"
          ),
        query: z.string().optional().describe("Search headings and body when chapter is omitted."),
        lang: z.enum(["en", "ru"]).optional().describe("docs language. Default en."),
      },
    },
    async ({ chapter, query, lang }) => {
      const locale = lang ?? "en";
      if (chapter) {
        const found = await readPluginChapter(config.fs, config.pluginDocsPath, chapter, locale);
        if (!found) {
          const aliases = PLUGIN_DOC_CHAPTERS.map((c) => `${c.id} (${c.aliases[0]})`).join(", ");
          return {
            content: [
              {
                type: "text" as const,
                text: `Chapter "${chapter}" not found under docs/${locale}. Known: ${aliases}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `# ${found.path}\n\n${found.text}`,
            },
          ],
        };
      }

      if (query) {
        const mapped = resolveChapter(query);
        if (mapped) {
          const found = await readPluginChapter(
            config.fs,
            config.pluginDocsPath,
            mapped.id,
            locale
          );
          if (found) {
            return {
              content: [{ type: "text" as const, text: `# ${found.path}\n\n${found.text}` }],
            };
          }
        }
        const hits = await searchPluginDocs(config.fs, config.pluginDocsPath, query, locale);
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No plugin-docs hits for "${query}" in docs/${locale}. Try chapter=pitfalls or resource lampa://plugin-guide.`,
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: formatDocHits(hits) }] };
      }

      const toc = await formatPluginGuideToc(config.fs, config.pluginDocsPath, locale);
      return { content: [{ type: "text" as const, text: toc }] };
    }
  );

  // ── doc_lookup ─────────────────────────────────────────────────────────────
  server.registerTool(
    "doc_lookup",
    {
      description:
        "Look up a topic in official plugin docs (docs/en), then UPGRADE.md / README. Prefer plugin_docs for a full chapter.",
      inputSchema: {
        topic: z
          .string()
          .describe("Topic, e.g. 'Storage', 'SettingsApi', 'PlayerVideo', 'pitfalls'."),
      },
    },
    async ({ topic }) => {
      const chapter = resolveChapter(topic);
      if (chapter) {
        const found = await readPluginChapter(config.fs, config.pluginDocsPath, chapter.id, "en");
        if (found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `> From official plugin docs \`${found.path}\`\n\n${found.text}`,
              },
            ],
          };
        }
      }

      const indexed = await config.fs.readIndex?.("plugin-docs");
      const hits = await searchPluginDocs(config.fs, config.pluginDocsPath, topic, "en", 10);
      const sections: string[] = [];
      if (hits.length > 0) {
        sections.push(`## Plugin docs (docs/en)\n\n${formatDocHits(hits)}`);
      } else if (indexed != null) {
        sections.push(
          `## Plugin-docs index present but no text hits for "${topic}". Try plugin_docs with a chapter alias.`
        );
      }

      const extras = ["UPGRADE.md", "README.md"];
      for (const src of extras) {
        if (!(await fileExists(config.fs, src))) continue;
        const content = (await readFileSafe(config.fs, src)) ?? "";
        const lines = content.split("\n");
        const extraHits: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(topic.toLowerCase())) {
            const ctx = lines.slice(Math.max(0, i - 1), i + 3).join("\n").trim();
            if (ctx.length > 5) extraHits.push(`L${i + 1}: ${ctx.slice(0, 200)}`);
          }
        }
        if (extraHits.length > 0) {
          sections.push(`### ${basename(src)}\n${extraHits.slice(0, 6).join("\n")}`);
        }
      }

      const jsdoc = joinRepo(config.docsPath, "index.html");
      if (sections.length === 0 && (await fileExists(config.fs, jsdoc))) {
        const content = (await readFileSafe(config.fs, jsdoc)) ?? "";
        if (content.toLowerCase().includes(topic.toLowerCase())) {
          sections.push(`### generated JSDoc (${jsdoc})\nMatch found; strip HTML via docs://index.`);
        }
      }

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No documentation found for "${topic}". Use plugin_docs({ chapter: "01" }) or resource lampa://plugin-guide.`,
            },
          ],
        };
      }

      return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
    }
  );
}
