import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, readSegment, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";

export function registerDiscoveryTools(server: McpServer, config: Config): void {
  // ── repo_overview ──────────────────────────────────────────────────────────
  server.registerTool(
    "repo_overview",
    {
      description:
        "Summarise the Lampa repository structure: top-level folders, likely entrypoints, build/doc scripts, and plugin list.",
      inputSchema: {},
    },
    async () => {
      if (!(await fileExists(config.fs))) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Repository not found at ${config.label}. Set LAMPA_REPO_PATH.`,
            },
          ],
        };
      }

      interface PackageJson {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      }
      const pkg = await readFileSafe(config.fs, "package.json");
      const pkgData = pkg ? (JSON.parse(pkg) as PackageJson) : {};

      const topLevel = (await config.fs.listDir())
        .map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}`)
        .join("\n");

      const plugins = (await fileExists(config.fs, "plugins"))
        ? (await config.fs.listDir("plugins")).filter((e) => e.type === "dir").map((e) => e.name)
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
        if (await fileExists(config.fs, candidate)) entrypoints.push(candidate);
      }

      const srcDirs = (await fileExists(config.fs, "src"))
        ? (await config.fs.listDir("src"))
            .filter((e) => e.type === "dir")
            .map((e) => `src/${e.name}`)
        : [];

      const summary = [
        `# Lampa Repository Overview`,
        `**Path:** ${config.label}`,
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

      return { content: [{ type: "text" as const, text: summary }] };
    }
  );

  // ── list_modules ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_modules",
    {
      description:
        "List all JavaScript/TypeScript modules in a given subfolder of the Lampa repo.",
      inputSchema: {
        subfolder: z
          .string()
          .optional()
          .describe("Relative path inside repo, e.g. 'src/components'. Defaults to 'src'."),
      },
    },
    async ({ subfolder }) => {
      const base = subfolder ?? "src";
      if (!(await fileExists(config.fs, base))) {
        return { content: [{ type: "text" as const, text: `Folder not found: ${subfolder}` }] };
      }
      const files = await listFilesRecursive(config.fs, base, [".js", ".ts"]);
      return { content: [{ type: "text" as const, text: files.join("\n") || "No modules found." }] };
    }
  );

  // ── find_files ─────────────────────────────────────────────────────────────
  server.registerTool(
    "find_files",
    {
      description: "Find files in the repo by name pattern or extension.",
      inputSchema: {
        pattern: z.string().describe("Substring or glob pattern to match against file names."),
        ext: z.string().optional().describe("File extension filter, e.g. '.js', '.scss'."),
      },
    },
    async ({ pattern, ext }) => {
      const exts = ext ? [ext] : [];
      const all = await listFilesRecursive(config.fs, "", exts);
      const lower = pattern.toLowerCase();
      const matches = all.filter((f) => basename(f).toLowerCase().includes(lower));
      return {
        content: [{ type: "text" as const, text: matches.join("\n") || `No files matching "${pattern}".` }],
      };
    }
  );

  // ── search_code ────────────────────────────────────────────────────────────
  server.registerTool(
    "search_code",
    {
      description:
        "Search the repo source code for a text string or regex pattern. Returns file paths, line numbers, and short previews.",
      inputSchema: {
        query: z.string().describe("Text or regex to search for."),
        globs: z
          .array(z.string())
          .optional()
          .describe("File glob patterns to restrict search, e.g. ['*.js','*.ts']."),
        regex: z.boolean().optional().describe("Treat query as a regex. Default false."),
      },
    },
    async ({ query, globs, regex }) => {
      const matches = await searchCode(config.fs, query, globs ?? [], regex ?? false);
      if (matches.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches for "${query}".` }] };
      }
      const lines = matches.map((m) => `${m.file}:${m.line}  ${m.text}`);
      const header = `Found ${matches.length} match(es) for "${query}":\n`;
      return { content: [{ type: "text" as const, text: header + lines.join("\n") }] };
    }
  );

  // ── read_file_segment ──────────────────────────────────────────────────────
  server.registerTool(
    "read_file_segment",
    {
      description: "Read a specific line range from a file in the repo.",
      inputSchema: {
        file: z.string().describe("Repo-relative path, e.g. 'src/app.js'."),
        start_line: z.number().describe("First line to read (1-based)."),
        end_line: z.number().describe("Last line to read (inclusive)."),
      },
    },
    async ({ file, start_line, end_line }) => {
      if (!(await fileExists(config.fs, file))) {
        return { content: [{ type: "text" as const, text: `File not found: ${file}` }] };
      }
      const segment = await readSegment(config.fs, file, start_line, end_line);
      return { content: [{ type: "text" as const, text: `\`\`\`\n${segment}\n\`\`\`` }] };
    }
  );

  // ── list_scripts ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_scripts",
    {
      description: "List all NPM scripts defined in package.json.",
      inputSchema: {},
    },
    async () => {
      const pkg = await readFileSafe(config.fs, "package.json");
      if (!pkg) return { content: [{ type: "text" as const, text: "No package.json found." }] };
      const data = JSON.parse(pkg) as { scripts?: Record<string, string> };
      const scripts: Record<string, string> = data.scripts ?? {};
      const lines = Object.entries(scripts).map(([k, v]) => `${k.padEnd(20)} → ${v}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") || "No scripts defined." }] };
    }
  );
}
