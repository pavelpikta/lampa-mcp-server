import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename } from "../fs/paths.js";
import { fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { inferFeatureFiles, detectRisks, LAMPA_RISKY_PATTERNS } from "../utils/lampa.js";

export function registerPlanningTools(server: McpServer, config: Config): void {
  // ── plan_feature_change ────────────────────────────────────────────────────
  server.registerTool(
    "plan_feature_change",
    {
      description:
        "Generate a step-by-step implementation plan for a requested Lampa feature or change. Must be called before draft_patch.",
      inputSchema: {
        request: z
          .string()
          .describe(
            "Plain-language description of the change, e.g. 'add a sleep timer to the player'."
          ),
        scope_hint: z
          .string()
          .optional()
          .describe("Optional hint for which feature area is involved."),
      },
    },
    async ({ request, scope_hint }) => {
      const combinedQuery = scope_hint ? `${request} ${scope_hint}` : request;
      const files = await inferFeatureFiles(config.fs, combinedQuery);
      const risks = await detectRisks(config.fs, files);

      const words = request
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 4);

      const liveHits: string[] = [];
      for (const word of words.slice(0, 3)) {
        const matches = await searchCode(config.fs, word, ["*.js"], false);
        for (const m of matches.slice(0, 5)) {
          liveHits.push(`${m.file}:${m.line}  ${m.text}`);
        }
      }

      const plan = [
        `# Change Plan: "${request}"`,
        ``,
        `## Step 1 — Understand the affected surface`,
        `Review these likely-affected files:`,
        files
          .slice(0, 12)
          .map((f) => `- ${f}`)
          .join("\n") || "- No files inferred. Use find_feature or search_code.",
        ``,
        `## Step 2 — Search for live code anchors`,
        liveHits.slice(0, 10).join("\n") || "No direct code matches found.",
        ``,
        `## Step 3 — Dependency and coupling check`,
        `Run \`module_dependency_map\` on each target file before editing.`,
        ``,
        `## Step 4 — Implementation steps`,
        `1. Read and understand the target file(s) with \`read_file_segment\`.`,
        `2. Identify the exact insertion or modification points.`,
        `3. Check for shared helpers, global events, or settings that need updating.`,
        `4. Prepare translation keys if any new UI text is added (see \`find_translation_keys\`).`,
        `5. Check for related styles (\`find_styles_for_module\`).`,
        `6. Confirm no existing plugin already handles this feature (\`list_modules plugins\`).`,
        ``,
        `## Step 5 — Risks (${risks.length})`,
        risks.length > 0
          ? risks.map((r) => `⚠ ${r}`).join("\n")
          : "No risky global patterns detected in inferred files.",
        ``,
        `## Step 6 — Validation checklist`,
        `- [ ] Run existing specs: \`npm test\` (if configured)`,
        `- [ ] Visually verify in browser via \`npm start\` or \`gulp\``,
        `- [ ] Check that all translation keys are present in all lang files`,
        `- [ ] Verify plugin still loads when feature is disabled`,
        ``,
        `## Proceed`,
        `When confident in the plan, call \`draft_patch\` with this plan as context.`,
      ].join("\n");

      return { content: [{ type: "text", text: plan }] };
    }
  );

  // ── impact_analysis ────────────────────────────────────────────────────────
  server.registerTool(
    "impact_analysis",
    {
      description: "Analyse the potential impact of modifying a specific file or module.",
      inputSchema: {
        file: z.string().describe("Repo-relative path to the file you plan to edit."),
      },
    },
    async ({ file }) => {
      if (!(await fileExists(config.fs, file))) {
        return { content: [{ type: "text", text: `File not found: ${file}` }] };
      }

      const base = basename(file).replace(/\.[^.]+$/, "");
      const reverseRefs = (await searchCode(config.fs, base, ["*.js", "*.ts"], false))
        .filter((m) => m.file !== file)
        .slice(0, 30);

      const risks = await detectRisks(config.fs, [file]);

      const impact = [
        `# Impact Analysis: ${file}`,
        ``,
        `## References to this module (${reverseRefs.length})`,
        reverseRefs.map((m) => `${m.file}:${m.line}  ${m.text}`).join("\n") || "None found.",
        ``,
        `## Risky global patterns in this file`,
        risks.length > 0 ? risks.map((r) => `⚠ ${r}`).join("\n") : "None detected.",
        ``,
        `## Impact level`,
        reverseRefs.length > 10
          ? "🔴 HIGH — many files reference this module"
          : reverseRefs.length > 3
            ? "🟡 MEDIUM — several files may be affected"
            : "🟢 LOW — few references, change is likely contained",
      ].join("\n");

      return { content: [{ type: "text", text: impact }] };
    }
  );

  // ── suggest_edit_targets ───────────────────────────────────────────────────
  server.registerTool(
    "suggest_edit_targets",
    {
      description:
        "Given a feature request, suggest the minimal set of files to edit and the best insertion points.",
      inputSchema: {
        request: z.string().describe("The change you want to make."),
      },
    },
    async ({ request }) => {
      const files = await inferFeatureFiles(config.fs, request);
      const filtered: string[] = [];
      for (const f of files) {
        if (await fileExists(config.fs, f)) filtered.push(f);
      }

      const suggestions = [
        `# Edit targets for: "${request}"`,
        ``,
        `## Recommended files to modify`,
        filtered
          .slice(0, 8)
          .map((f) => `- \`${f}\``)
          .join("\n") || "None inferred. Use search_code to locate exact anchors.",
        ``,
        `## Approach`,
        `- Prefer modifying the most specific file (deepest path) rather than shared core`,
        `- Hook into existing Lampa.Event listeners before adding new ones`,
        `- Extend plugin entry points (main.js in plugin folder) rather than core files`,
        `- Add settings via Lampa.Settings.add() in the plugin's main.js init`,
      ].join("\n");

      return { content: [{ type: "text", text: suggestions }] };
    }
  );

  // ── risk_scan ──────────────────────────────────────────────────────────────
  server.registerTool(
    "risk_scan",
    {
      description:
        "Scan a file or folder for coupling risks: shared state, global events, settings persistence, reused components.",
      inputSchema: {
        target: z.string().describe("Repo-relative file or folder path to scan."),
      },
    },
    async ({ target }) => {
      if (!(await fileExists(config.fs, target))) {
        return { content: [{ type: "text", text: `Not found: ${target}` }] };
      }

      const risks = await detectRisks(config.fs, [target]);

      const extraPatterns = [
        "window.",
        "document.",
        "localStorage",
        "sessionStorage",
        "globalThis",
      ];
      const extraHits: string[] = [];
      const inScope = (file: string) => file === target || file.startsWith(`${target}/`);
      for (const pat of extraPatterns) {
        const matches = (await searchCode(config.fs, pat, [], false)).filter((m) =>
          inScope(m.file)
        );
        for (const m of matches.slice(0, 3)) {
          extraHits.push(`${pat} at line ${m.line}: ${m.text}`);
        }
      }

      const out = [
        `# Risk Scan: ${target}`,
        ``,
        `## Lampa global coupling (${risks.length} issues)`,
        risks.length > 0
          ? risks.map((r) => `⚠ ${r}`).join("\n")
          : "✓ No Lampa global patterns found.",
        ``,
        `## Browser/DOM global usage`,
        extraHits.length > 0 ? extraHits.join("\n") : "✓ No direct DOM globals found.",
        ``,
        `## Known high-risk patterns`,
        LAMPA_RISKY_PATTERNS.map((p) => `- \`${p.pattern}\` → ${p.reason}`).join("\n"),
      ].join("\n");

      return { content: [{ type: "text", text: out }] };
    }
  );
}
