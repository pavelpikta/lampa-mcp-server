import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import type { Config } from "../config.js";
import { listFilesRecursive, readFileSafe, readSegment, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";

export function registerDiscoveryTools(server: McpServer, config: Config): void {
  // ── repo_overview ──────────────────────────────────────────────────────────
  server.tool(
    "repo_overview",
    "Summarise the Lampa repository structure: top-level folders, likely entrypoints, build/doc scripts, and plugin list.",
    {},
    async () => {
      const repoPath = config.repoPath;
      if (!fileExists(repoPath)) {
        return {
          content: [
            { type: "text", text: `Repository not found at ${repoPath}. Set LAMPA_REPO_PATH.` },
          ],
        };
      }

      interface PackageJson {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      }
      const pkg = readFileSafe(path.join(repoPath, "package.json"));
      const pkgData = pkg ? (JSON.parse(pkg) as PackageJson) : {};

      const topLevel = fs
        .readdirSync(repoPath, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
        .join("\n");

      const plugins = fileExists(path.join(repoPath, "plugins"))
        ? fs
            .readdirSync(path.join(repoPath, "plugins"), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [];

      const scripts = pkgData.scripts
        ? Object.entries(pkgData.scripts)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n")
        : "None found.";

      const entrypoints: string[] = [];
      for (const candidate of [
        "src/app.js",
        "src/index.ts",
        "public/index.html",
        "index/github/index.html",
      ]) {
        if (fileExists(path.join(repoPath, candidate))) entrypoints.push(candidate);
      }

      const srcDirs = fileExists(path.join(repoPath, "src"))
        ? fs
            .readdirSync(path.join(repoPath, "src"), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => `src/${e.name}`)
        : [];

      const summary = [
        `# Lampa Repository Overview`,
        `**Path:** ${repoPath}`,
        `**Name:** ${pkgData.name ?? "unknown"} v${pkgData.version ?? "?"}`,
        ``,
        `## Top-level`,
        topLevel,
        ``,
        `## Source directories`,
        srcDirs.join("\n"),
        ``,
        `## Plugins (${plugins.length})`,
        plugins.join(", "),
        ``,
        `## Entrypoints`,
        entrypoints.join("\n") || "None detected.",
        ``,
        `## NPM scripts`,
        scripts,
        ``,
        `## Key observations`,
        `- Main app source: src/`,
        `- Plugin system: plugins/ (each plugin is a self-contained subfolder)`,
        `- Build output: public/ (static assets served to TV clients)`,
        `- Language files: public/lang/ and src/lang/`,
        `- Vendor libs: public/vender/`,
        `- Specs: spec/ (Jest or similar)`,
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    }
  );

  // ── list_modules ───────────────────────────────────────────────────────────
  server.tool(
    "list_modules",
    "List all JavaScript/TypeScript modules in a given subfolder of the Lampa repo.",
    {
      subfolder: z
        .string()
        .optional()
        .describe("Relative path inside repo, e.g. 'src/components'. Defaults to 'src'."),
    },
    async ({ subfolder }) => {
      const base = path.join(config.repoPath, subfolder ?? "src");
      if (!fileExists(base)) {
        return { content: [{ type: "text", text: `Folder not found: ${subfolder}` }] };
      }
      const files = listFilesRecursive(base, [".js", ".ts"]);
      const lines = files.map((f) => path.relative(config.repoPath, f));
      return { content: [{ type: "text", text: lines.join("\n") || "No modules found." }] };
    }
  );

  // ── find_files ─────────────────────────────────────────────────────────────
  server.tool(
    "find_files",
    "Find files in the repo by name pattern or extension.",
    {
      pattern: z.string().describe("Substring or glob pattern to match against file names."),
      ext: z.string().optional().describe("File extension filter, e.g. '.js', '.scss'."),
    },
    async ({ pattern, ext }) => {
      const exts = ext ? [ext] : [];
      const all = listFilesRecursive(config.repoPath, exts);
      const lower = pattern.toLowerCase();
      const matches = all
        .filter((f) => path.basename(f).toLowerCase().includes(lower))
        .map((f) => path.relative(config.repoPath, f));
      return {
        content: [{ type: "text", text: matches.join("\n") || `No files matching "${pattern}".` }],
      };
    }
  );

  // ── search_code ────────────────────────────────────────────────────────────
  server.tool(
    "search_code",
    "Search the repo source code for a text string or regex pattern. Returns file paths, line numbers, and short previews.",
    {
      query: z.string().describe("Text or regex to search for."),
      globs: z
        .array(z.string())
        .optional()
        .describe("File glob patterns to restrict search, e.g. ['*.js','*.ts']."),
      regex: z.boolean().optional().describe("Treat query as a regex. Default false."),
    },
    async ({ query, globs, regex }) => {
      const matches = searchCode(config.repoPath, query, globs ?? [], regex ?? false);
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${query}".` }] };
      }
      const lines = matches.map((m) => `${m.file}:${m.line}  ${m.text}`);
      const header = `Found ${matches.length} match(es) for "${query}":\n`;
      return { content: [{ type: "text", text: header + lines.join("\n") }] };
    }
  );

  // ── read_file_segment ──────────────────────────────────────────────────────
  server.tool(
    "read_file_segment",
    "Read a specific line range from a file in the repo.",
    {
      file: z.string().describe("Repo-relative path, e.g. 'src/app.js'."),
      start_line: z.number().describe("First line to read (1-based)."),
      end_line: z.number().describe("Last line to read (inclusive)."),
    },
    async ({ file, start_line, end_line }) => {
      const abs = path.join(config.repoPath, file);
      if (!fileExists(abs)) {
        return { content: [{ type: "text", text: `File not found: ${file}` }] };
      }
      const segment = readSegment(abs, start_line, end_line);
      return { content: [{ type: "text", text: `\`\`\`\n${segment}\n\`\`\`` }] };
    }
  );

  // ── list_scripts ───────────────────────────────────────────────────────────
  server.tool("list_scripts", "List all NPM scripts defined in package.json.", {}, async () => {
    const pkgPath = path.join(config.repoPath, "package.json");
    const pkg = readFileSafe(pkgPath);
    if (!pkg) return { content: [{ type: "text", text: "No package.json found." }] };
    const data = JSON.parse(pkg) as { scripts?: Record<string, string> };
    const scripts: Record<string, string> = data.scripts ?? {};
    const lines = Object.entries(scripts).map(([k, v]) => `${k.padEnd(20)} → ${v}`);
    return { content: [{ type: "text", text: lines.join("\n") || "No scripts defined." }] };
  });
}
