import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { Config } from "../config.js";
import { listFilesRecursive, readFileSafe, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";

export function registerValidationTools(server: McpServer, config: Config): void {
  // ── run_grep_checks ────────────────────────────────────────────────────────
  server.tool(
    "run_grep_checks",
    "Run a set of code-quality grep checks across the repo: undefined references, console.log leftovers, TODO markers, missing translations.",
    {
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
        const hits = searchCode(config.repoPath, "TODO", ["*.js", "*.ts"], false).slice(0, 20);
        results.push(
          `## TODOs (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      if (toRun.includes("console_logs")) {
        const hits = searchCode(config.repoPath, "console.log", ["*.js", "*.ts"], false).slice(
          0,
          20
        );
        results.push(
          `## console.log (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      if (toRun.includes("undefined_refs")) {
        const hits = searchCode(config.repoPath, "undefined", ["*.js"], false)
          .filter((h) => h.text.includes("=== undefined") || h.text.includes("== undefined"))
          .slice(0, 15);
        results.push(
          `## Loose undefined checks (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      if (toRun.includes("hardcoded_strings")) {
        const hits = searchCode(config.repoPath, 'innerHTML = "', ["*.js"], false).slice(0, 10);
        results.push(
          `## Hardcoded innerHTML strings (${hits.length})\n${hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n") || "None."}`
        );
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    }
  );

  // ── list_related_tests ─────────────────────────────────────────────────────
  server.tool(
    "list_related_tests",
    "Find test/spec files related to a module or feature.",
    {
      module: z.string().describe("Module name or feature keyword."),
    },
    async ({ module: mod }) => {
      const specDir = path.join(config.repoPath, "spec");
      const hasSpec = fileExists(specDir);
      const specFiles = hasSpec ? listFilesRecursive(specDir, [".js", ".ts", ".spec.js"]) : [];

      const lower = mod.toLowerCase();
      const direct = specFiles
        .filter((f) => path.basename(f).toLowerCase().includes(lower))
        .map((f) => path.relative(config.repoPath, f));

      const byContent = specFiles
        .filter((f) => {
          const content = readFileSafe(f) ?? "";
          return content.toLowerCase().includes(lower);
        })
        .map((f) => path.relative(config.repoPath, f));

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
  server.tool(
    "run_build_hint",
    "Return the correct build/dev/test command for the Lampa project based on package.json scripts.",
    {
      goal: z.enum(["build", "dev", "test", "doc", "lint"]).describe("What you want to do."),
    },
    async ({ goal }) => {
      const pkgPath = path.join(config.repoPath, "package.json");
      const pkg = readFileSafe(pkgPath);
      if (!pkg) return { content: [{ type: "text", text: "No package.json found." }] };

      const data = JSON.parse(pkg) as { scripts?: Record<string, string> };
      const scripts: Record<string, string> = data.scripts ?? {};

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
        const gulpFile = fileExists(path.join(config.repoPath, "gulpfile.js"));
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

  // ── doc_lookup ─────────────────────────────────────────────────────────────
  server.tool(
    "doc_lookup",
    "Look up a topic in the generated docs (build/doc/index.html) or README.",
    {
      topic: z.string().describe("Topic to search for, e.g. 'Storage', 'Settings', 'Component'."),
    },
    async ({ topic }) => {
      const sources = [
        path.join(config.docsPath, "index.html"),
        path.join(config.repoPath, "README.md"),
        path.join(config.repoPath, "UPGRADE.md"),
      ];

      const results: string[] = [];

      for (const src of sources) {
        if (!fileExists(src)) continue;
        const content = readFileSafe(src) ?? "";
        const lines = content.split("\n");
        const hits: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(topic.toLowerCase())) {
            const ctx = lines
              .slice(Math.max(0, i - 1), i + 3)
              .join("\n")
              .replace(/<[^>]+>/g, "")
              .trim();
            if (ctx.length > 5) hits.push(`L${i + 1}: ${ctx.slice(0, 200)}`);
          }
        }
        if (hits.length > 0) {
          results.push(`### ${path.basename(src)}\n${hits.slice(0, 8).join("\n")}`);
        }
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No documentation found for "${topic}". Run \`npm run doc\` in the repo to generate docs, then retry.`,
            },
          ],
        };
      }

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    }
  );
}
