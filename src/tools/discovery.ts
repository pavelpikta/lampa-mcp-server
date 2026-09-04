import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe, readSegment, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { inferFeatureFiles, LAMPA_FEATURE_MAP, resolveEditPath } from "../utils/lampa.js";
import { formatTemplates } from "../utils/lampa_deep.js";
import { READ_ONLY_SNAPSHOT, fail, ok, reportOutput } from "./meta.js";

export function registerDiscoveryTools(server: McpServer, config: Config): void {
  server.registerTool(
    "repo_overview",
    {
      title: "Summarize Lampa repo layout",
      description:
        "Summarize the Lampa snapshot — commit metadata, top-level folders, plugins, entrypoints, and npm scripts — for first-session orientation. Do not use it to read bytes (`read_source`), search contents (`search_code`), or list files by name (`find_files`). Optional `subfolder` lists JS/TS under that prefix (recursive within it; unknown folder → error); missing repo → error; stdio needs LAMPA_REPO_PATH and Worker PAT is transport-only.",
      inputSchema: {
        subfolder: z
          .string()
          .optional()
          .describe(
            "Repo-relative prefix whose JS/TS files to list recursively, e.g. 'src/components'. Omit for the compact overview. Unknown folder → error."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ subfolder }) => {
      if (!(await fileExists(config.fs))) {
        return fail(`Repository not found at ${config.label}. Set LAMPA_REPO_PATH.`);
      }

      interface PackageJson {
        name?: string;
        version?: string;
        scripts?: Record<string, string>;
      }
      const pkg = await readFileSafe(config.fs, "package.json");
      const pkgData = pkg ? (JSON.parse(pkg) as PackageJson) : {};
      const meta = (await config.fs.getSnapshotMeta?.()) ?? null;

      const topLevel = (await config.fs.listDir())
        .map((e) => `${e.type === "dir" ? "[dir]" : "[file]"} ${e.name}`)
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

      const parts = [
        `# Lampa Repository Overview`,
        `**Path:** ${config.label}`,
        `**Name:** ${pkgData.name ?? "unknown"} v${pkgData.version ?? "?"}`,
        ``,
        `## Snapshot`,
        `- commit: ${meta?.commit ?? "(local checkout — no snapshot commit)"}`,
        `- generatedAt: ${meta?.generatedAt ?? "n/a"}`,
        `- fileCount: ${meta?.fileCount ?? "n/a"}`,
        `- totalBytes: ${meta?.totalBytes ?? "n/a"}`,
        `- bundled: ${meta?.bundled ?? "n/a"}`,
        ``,
        `## Top-level`,
        topLevel,
        ``,
        `## Source directories`,
        srcDirs.join("\n") || "None.",
        ``,
        `## Plugins (${plugins.length})`,
        plugins.join(", ") || "None.",
        ``,
        `## Entrypoints`,
        entrypoints.join("\n") || "None detected.",
        ``,
        `## NPM scripts`,
        scripts,
        ``,
        `## Key observations`,
        `- Main app source: src/ — edit here, not public/ or build/`,
        `- Plugin system: plugins/ (each plugin is a self-contained subfolder)`,
        `- Build output: public/ (do not edit; use resolve_edit_path)`,
        `- Language files: src/lang/ (authoritative) and public/lang/ (generated)`,
      ];

      if (subfolder) {
        const base = subfolder;
        if (!(await fileExists(config.fs, base))) {
          return fail(`Folder not found: ${base}`);
        }
        const files = await listFilesRecursive(config.fs, base, [".js", ".ts"]);
        parts.push(
          ``,
          `## Modules in ${base} (${files.length})`,
          files.join("\n") || "No modules found."
        );
      }

      return ok(parts.join("\n"));
    }
  );

  server.registerTool(
    "search_code",
    {
      title: "Search Lampa source contents",
      description:
        "Search Lampa source contents for a literal or regex and return path:line plus a preview. Use this when you know a symbol or pattern; do not use it to list files by name (`find_files`), dump catalogs (`map_lampa`), or read one known path (`read_source`). Default is literal and case-sensitive (`regex=true` uses RegExp as written, no implicit `i`); default extensions .js/.ts/.css/.scss/.html/.json unless `globs`; prefer `prefix` over `globs`; max 100 hits, 5 per file, 200-char preview; no matches → empty markdown, not an error.",
      inputSchema: {
        query: z
          .string()
          .describe("Literal substring (default, case-sensitive) or regex when regex=true."),
        globs: z
          .array(z.string())
          .optional()
          .describe(
            "Extension globs to restrict search, e.g. ['*.js','*.ts']. When omitted, searches .js/.ts/.css/.scss/.html/.json."
          ),
        regex: z
          .boolean()
          .optional()
          .describe(
            "If true, compile query as a JS RegExp with no extra flags (no implicit case-insensitive). Default false (literal)."
          ),
        prefix: z
          .string()
          .optional()
          .describe(
            "Repo-relative folder to walk, e.g. 'src' or 'plugins/iptv'. Preferred over globs when the area is known."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ query, globs, regex, prefix }) => {
      const matches = await searchCode(config.fs, query, globs ?? [], regex ?? false, prefix);
      if (matches.length === 0) {
        return ok(`No matches for "${query}".`);
      }
      const lines = matches.map((m) => `${m.file}:${m.line}  ${m.text}`);
      return ok(`Found ${matches.length} match(es) for "${query}":\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "find_files",
    {
      title: "Find Lampa files by name or feature",
      description:
        "Locate repo-relative paths by filename, Lampa feature, UI component, stylesheet, or spec — a path finder, not content grep. Unlike `search_code`, this matches names/paths (except `mode=ui`/`styles`, which also attach up to 20/15 content hits); unlike `read_source`, it does not return file bytes. `mode=feature` uses a built-in Lampa feature map plus filename match, not full-text search; `ext` only for `mode=name` (default); empty matches → list, not an error.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Filename substring (mode=name), feature name (mode=feature, e.g. player/catalog/iptv), UI component, style module, or spec keyword."
          ),
        mode: z
          .enum(["name", "feature", "ui", "styles", "tests"])
          .optional()
          .describe(
            "name (default)=filename substring; feature=built-in Lampa feature map + filename; ui=templates/components (+ up to 20 content hits); styles=css/scss (+ up to 15 content hits); tests=spec files."
          ),
        ext: z
          .string()
          .optional()
          .describe(
            "For mode=name only: extension filter, e.g. '.js' or '.scss'. Ignored otherwise."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ query, mode = "name", ext }) => {
      const lower = query.toLowerCase();

      if (mode === "feature") {
        const files = await inferFeatureFiles(config.fs, query);
        const knownKeys = Object.keys(LAMPA_FEATURE_MAP).filter(
          (k) => lower.includes(k) || k.includes(lower)
        );
        return ok(
          [
            `## Feature: "${query}"`,
            ``,
            `### Matched categories: ${knownKeys.join(", ") || "none (generic filename match only)"}`,
            ``,
            `### Relevant files (${files.length})`,
            files.join("\n") || "No files found.",
            ``,
            `Next: \`read_source\` for bytes, \`trace_lampa\` for blast radius, \`plan_change\` before edits.`,
          ].join("\n")
        );
      }

      if (mode === "ui") {
        const files = await listFilesRecursive(config.fs, "", [".js", ".html", ".scss", ".css"]);
        const byFilename = files.filter((f) => basename(f).toLowerCase().includes(lower));
        const byContent = (await searchCode(config.fs, query, ["*.js", "*.html"], false))
          .filter(
            (m) =>
              m.text.toLowerCase().includes("template") ||
              m.text.toLowerCase().includes("component") ||
              m.text.toLowerCase().includes("render") ||
              m.text.toLowerCase().includes("create")
          )
          .slice(0, 20)
          .map((m) => `${m.file}:${m.line}  ${m.text}`);
        return ok(
          [
            `## Files matching "${query}"`,
            byFilename.join("\n") || "None.",
            ``,
            `## Code references (template/component/render context)`,
            byContent.join("\n") || "None.",
          ].join("\n")
        );
      }

      if (mode === "styles") {
        const cssFiles = await listFilesRecursive(config.fs, "", [".css", ".scss"]);
        const direct = cssFiles.filter((f) => f.toLowerCase().includes(lower));
        const byContent = (await searchCode(config.fs, query, ["*.css", "*.scss"], false))
          .slice(0, 15)
          .map((m) => `${m.file}:${m.line}  ${m.text}`);
        return ok(
          [
            `## CSS/SCSS files for "${query}"`,
            direct.join("\n") || "None.",
            ``,
            `## Style references mentioning "${query}"`,
            byContent.join("\n") || "None.",
          ].join("\n")
        );
      }

      if (mode === "tests") {
        const hasSpec = await fileExists(config.fs, "spec");
        const specFiles = hasSpec
          ? await listFilesRecursive(config.fs, "spec", [".js", ".ts", ".spec.js"])
          : [];
        const direct = specFiles.filter((f) => basename(f).toLowerCase().includes(lower));
        const byContent: string[] = [];
        for (const f of specFiles) {
          const content = (await readFileSafe(config.fs, f)) ?? "";
          if (content.toLowerCase().includes(lower)) byContent.push(f);
        }
        const all = [...new Set([...direct, ...byContent])];
        return ok(
          all.length > 0
            ? `Related specs for "${query}":\n${all.join("\n")}`
            : `No spec files found for "${query}". Spec directory: ${hasSpec ? "exists (spec/)" : "not found"}.`
        );
      }

      const exts = ext ? [ext] : [];
      const all = await listFilesRecursive(config.fs, "", exts);
      const matches = all.filter((f) => basename(f).toLowerCase().includes(lower));
      return ok(matches.join("\n") || `No files matching "${query}".`);
    }
  );

  server.registerTool(
    "read_source",
    {
      title: "Read Lampa source file bytes",
      description:
        "Read bytes from one known path: a repo file, a src/core module, or a src/templates template. Unlike `search_code`/`find_files`, this returns contents of a single target — do not dump catalogs (`map_lampa`). Full files truncate at `max_lines` (default 300); pass `start_line`+`end_line` (1-based, inclusive) for a range (ignores `max_lines`); `kind=file` requires `file`; omit `file` with `kind=core`/`template` to list; missing path → error.",
      inputSchema: {
        file: z
          .string()
          .optional()
          .describe(
            "Repo-relative path, core module name (kind=core), or template name (kind=template). Required for kind=file."
          ),
        kind: z
          .enum(["file", "core", "template"])
          .optional()
          .describe(
            "file (default)=any path; core=src/core module; template=src/templates markup."
          ),
        start_line: z
          .number()
          .optional()
          .describe("First line to read (1-based). Pair with end_line."),
        end_line: z
          .number()
          .optional()
          .describe("Last line to read (inclusive). Pair with start_line."),
        max_lines: z
          .number()
          .optional()
          .describe(
            "Cap when reading a full file. Default 300. Ignored when start_line/end_line are set."
          ),
        template_mode: z
          .enum(["list", "html", "raw"])
          .optional()
          .describe(
            "For kind=template: list catalog, html markup, or raw JS. Default list when file omitted."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ file, kind = "file", start_line, end_line, max_lines = 300, template_mode }) => {
      if (kind === "template") {
        const mode = file ? (template_mode ?? "html") : (template_mode ?? "list");
        if ((mode === "html" || mode === "raw") && !file) {
          return fail("kind=template with mode html/raw requires `file` (template name).");
        }
        return ok(await formatTemplates(config.fs, mode, file));
      }

      if (kind === "core") {
        const coreDir = "src/core";
        if (!(await fileExists(config.fs, coreDir))) {
          return fail("src/core/ not found in repository.");
        }
        if (!file) {
          const entries = (await config.fs.listDir(coreDir)).sort((a, b) =>
            a.name.localeCompare(b.name)
          );
          const dirs = entries.filter((e) => e.type === "dir").map((e) => `[dir] ${e.name}/`);
          const files = entries.filter((e) => e.type === "file").map((e) => `[file] ${e.name}`);
          return ok(
            [
              `# src/core/  (${entries.length} items)`,
              ``,
              `## Subdirectories`,
              dirs.join("\n") || "none",
              ``,
              `## Files`,
              files.join("\n") || "none",
              ``,
              `Pass file="<module>" with kind=core to read a specific module, e.g. file="lang".`,
            ].join("\n")
          );
        }
        const lower = file.toLowerCase().replace(/\.js$/, "");
        const allFiles = await listFilesRecursive(config.fs, coreDir, [".js"]);
        const match =
          allFiles.find((f) => basename(f, ".js").toLowerCase() === lower) ??
          allFiles.find((f) => basename(f).toLowerCase().includes(lower));
        if (!match) {
          const available = allFiles.map((f) => basename(f, ".js")).join(", ");
          return fail(`Module "${file}" not found in src/core/.\nAvailable: ${available}`);
        }
        return readPath(config, match, start_line, end_line, max_lines);
      }

      if (!file) {
        return fail("kind=file requires `file` (repo-relative path).");
      }
      return readPath(config, file, start_line, end_line, max_lines);
    }
  );

  server.registerTool(
    "resolve_edit_path",
    {
      title: "Resolve authoritative Lampa edit path",
      description:
        "Map a change kind (lang, sass, template, component, plugin, core, interaction, settings) to the authoritative src/ or plugins/ path and list generated public/build copies to avoid. Call this before `plan_change` or `draft_patch`; unlike `find_files`, this is a fixed landmark table, not a search. Optional `name` is a plugin id or lang code; unknown name does not fail — it returns the kind's default paths.",
      inputSchema: {
        kind: z
          .enum([
            "lang",
            "sass",
            "template",
            "component",
            "plugin",
            "core",
            "interaction",
            "settings",
          ])
          .describe("What kind of source you intend to change."),
        name: z
          .string()
          .optional()
          .describe(
            "Optional plugin id (e.g. 'tracks') or lang code (e.g. 'en'). Unknown values still return the kind's default paths."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
    },
    async ({ kind, name }) => {
      const result = resolveEditPath(kind, name);
      return ok(
        [
          `# Edit path: ${kind}${name ? ` (${name})` : ""}`,
          ``,
          `## Authoritative`,
          ...result.authoritative.map((p) => `- ${p}`),
          ``,
          `## Avoid`,
          ...result.avoid.map((p) => `- ${p}`),
          ``,
          result.notes,
        ].join("\n")
      );
    }
  );
}

async function readPath(
  config: Config,
  file: string,
  start_line?: number,
  end_line?: number,
  max_lines = 300
) {
  if (!(await fileExists(config.fs, file))) {
    return fail(`File not found: ${file}\nUse find_files or search_code to locate the path.`);
  }

  if (start_line != null && end_line != null) {
    const segment = await readSegment(config.fs, file, start_line, end_line);
    return ok(`# ${file}  lines ${start_line}-${end_line}\n\`\`\`\n${segment}\n\`\`\``);
  }

  const content = (await readFileSafe(config.fs, file)) ?? "";
  const lines = content.split("\n");
  const total = lines.length;
  const truncated = total > max_lines;
  const shown = truncated ? lines.slice(0, max_lines).join("\n") : content;
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "text";
  const lang = ext === "ts" ? "typescript" : ext === "js" ? "javascript" : ext;

  return ok(
    [
      `// ${file}  (${total} lines${truncated ? `, first ${max_lines} shown` : ""})`,
      `\`\`\`${lang}`,
      shown,
      truncated
        ? `\n// … ${total - max_lines} more lines omitted.\n// Re-call read_source with start_line=${max_lines + 1} and end_line to continue.`
        : "",
      "```",
    ]
      .filter((l) => l !== "")
      .join("\n")
  );
}
