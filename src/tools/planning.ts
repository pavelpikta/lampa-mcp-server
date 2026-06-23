import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { Config } from "../config.js";
import { fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { inferFeatureFiles, detectRisks, LAMPA_RISKY_PATTERNS } from "../utils/lampa.js";

export function registerPlanningTools(server: McpServer, config: Config): void {
  // ── plan_feature_change ────────────────────────────────────────────────────
  server.tool(
    "plan_feature_change",
    "Generate a step-by-step implementation plan for a requested Lampa feature or change. Must be called before draft_patch.",
    {
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
    async ({ request, scope_hint }) => {
      const combinedQuery = scope_hint ? `${request} ${scope_hint}` : request;
      const files = inferFeatureFiles(config.repoPath, combinedQuery);
      const risks = detectRisks(config.repoPath, files);

      // Live search for tokens in the request
      const words = request
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 4);

      const liveHits: string[] = [];
      for (const word of words.slice(0, 3)) {
        const matches = searchCode(config.repoPath, word, ["*.js"], false);
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
  server.tool(
    "impact_analysis",
    "Analyse the potential impact of modifying a specific file or module.",
    {
      file: z.string().describe("Repo-relative path to the file you plan to edit."),
    },
    async ({ file }) => {
      const abs = path.join(config.repoPath, file);
      if (!fileExists(abs)) {
        return { content: [{ type: "text", text: `File not found: ${file}` }] };
      }

      const basename = path.basename(file, path.extname(file));
      const reverseRefs = searchCode(config.repoPath, basename, ["*.js", "*.ts"], false)
        .filter((m) => m.file !== file)
        .slice(0, 30);

      const risks = detectRisks(config.repoPath, [file]);

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
  server.tool(
    "suggest_edit_targets",
    "Given a feature request, suggest the minimal set of files to edit and the best insertion points.",
    {
      request: z.string().describe("The change you want to make."),
    },
    async ({ request }) => {
      const files = inferFeatureFiles(config.repoPath, request);
      const filtered = files.filter((f) => fileExists(path.join(config.repoPath, f)));

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
  server.tool(
    "risk_scan",
    "Scan a file or folder for coupling risks: shared state, global events, settings persistence, reused components.",
    {
      target: z.string().describe("Repo-relative file or folder path to scan."),
    },
    async ({ target }) => {
      const abs = path.join(config.repoPath, target);
      if (!fileExists(abs)) {
        return { content: [{ type: "text", text: `Not found: ${target}` }] };
      }

      const risks = detectRisks(config.repoPath, [target]);

      // Also scan for additional patterns
      const extraPatterns = [
        "window.",
        "document.",
        "localStorage",
        "sessionStorage",
        "globalThis",
      ];
      const extraHits: string[] = [];
      for (const pat of extraPatterns) {
        const matches = searchCode(abs, pat, [], false);
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
