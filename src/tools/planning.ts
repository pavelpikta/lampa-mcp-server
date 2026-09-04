import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { basename } from "../fs/paths.js";
import type { RepoFs } from "../fs/types.js";
import { fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { inferFeatureFiles, detectRisks, LAMPA_RISKY_PATTERNS } from "../utils/lampa.js";
import { READ_ONLY_SNAPSHOT, ok, reportOutput } from "./meta.js";

async function buildSuggestedTargets(fs: RepoFs, request: string): Promise<string> {
  const files = await inferFeatureFiles(fs, request);
  const filtered: string[] = [];
  for (const f of files) {
    if (await fileExists(fs, f)) filtered.push(f);
  }

  return [
    `## Suggested targets`,
    filtered
      .slice(0, 8)
      .map((f) => `- \`${f}\``)
      .join("\n") || "None inferred. Use search_code to locate exact anchors.",
    ``,
    `### Approach`,
    `- Prefer modifying the most specific file (deepest path) rather than shared core`,
    `- Hook into existing Lampa.Event listeners before adding new ones`,
    `- Extend plugin entry points (main.js in plugin folder) rather than core files`,
    `- Add settings via Lampa.SettingsApi.addComponent / addParam in init() after app:ready`,
  ].join("\n");
}

async function buildImpactSection(fs: RepoFs, files: string[]): Promise<string> {
  const sections: string[] = [`## Impact`];

  for (const file of files.slice(0, 5)) {
    if (!(await fileExists(fs, file))) continue;

    const base = basename(file).replace(/\.[^.]+$/, "");
    const reverseRefs = (await searchCode(fs, base, ["*.js", "*.ts"], false))
      .filter((m) => m.file !== file)
      .slice(0, 15);

    const risks = await detectRisks(fs, [file]);
    const level = reverseRefs.length > 10 ? "HIGH" : reverseRefs.length > 3 ? "MEDIUM" : "LOW";

    sections.push(
      `### ${file} — ${level}`,
      `References (${reverseRefs.length}):`,
      reverseRefs.map((m) => `- ${m.file}:${m.line}  ${m.text}`).join("\n") || "- None found.",
      risks.length > 0
        ? `Risks:\n${risks.map((r) => `- ${r}`).join("\n")}`
        : "Risks: none detected.",
      ``
    );
  }

  if (sections.length === 1) {
    sections.push(
      "No existing target files to analyse. Infer targets first, then trace_symbol mode=deps."
    );
  }

  return sections.join("\n");
}

export function registerPlanningTools(server: McpServer, config: Config): void {
  server.registerTool(
    "plan_change",
    {
      title: "Plan a Lampa feature change",
      description:
        "Generate a step-by-step implementation plan with inferred targets, a reverse-ref sample, and coupling risks for a Lampa change. Call this before `draft_patch`; unlike `draft_patch` it does not invent diffs, unlike `trace_symbol` it covers a whole request rather than one file/event, unlike `scaffold_plugin` it plans edits to existing code. `request='add a sleep timer'` + `scope_hint='player'` concatenates into feature inference; empty inference still returns a plan (not an error). Snapshot-only — does not execute or write; heuristic — not a guarantee; affected-surface list caps at ~12 files.",
      inputSchema: {
        request: z
          .string()
          .describe(
            "Plain-language description of the change, e.g. 'add a sleep timer to the player'."
          ),
        scope_hint: z
          .string()
          .optional()
          .describe(
            "Optional hint for which feature area is involved, e.g. 'player' or 'plugins/iptv'."
          ),
      },
      outputSchema: reportOutput,
      annotations: READ_ONLY_SNAPSHOT,
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

      const extraHits: string[] = [];
      for (const file of files.slice(0, 3)) {
        if (!(await fileExists(config.fs, file))) continue;
        for (const pat of ["window.", "document.", "localStorage"]) {
          const matches = (await searchCode(config.fs, pat, [], false)).filter(
            (m) => m.file === file || m.file.startsWith(`${file}/`)
          );
          for (const m of matches.slice(0, 2)) {
            extraHits.push(`${pat} in ${m.file}:${m.line}: ${m.text}`);
          }
        }
      }

      const suggested = await buildSuggestedTargets(config.fs, combinedQuery);
      const impact = await buildImpactSection(config.fs, files);

      const plan = [
        `# Change Plan: "${request}"`,
        ``,
        `Call \`resolve_edit_path\` before editing so you change src/ or plugins/, not public/build.`,
        ``,
        `## Step 1 — Affected surface`,
        files
          .slice(0, 12)
          .map((f) => `- ${f}`)
          .join("\n") || "- No files inferred. Use find_files mode=feature or search_code.",
        ``,
        suggested,
        ``,
        impact,
        ``,
        `## Step 2 — Live code anchors`,
        liveHits.slice(0, 10).join("\n") || "No direct code matches found.",
        ``,
        `## Step 3 — Coupling / browser globals`,
        extraHits.length > 0
          ? extraHits.join("\n")
          : "No extra DOM globals sampled on top targets.",
        ``,
        `## Known high-risk patterns`,
        LAMPA_RISKY_PATTERNS.map((p) => `- \`${p.pattern}\` → ${p.reason}`).join("\n"),
        ``,
        `## Step 4 — Implementation steps`,
        `1. Read targets with \`read_source\`.`,
        `2. Identify insertion points; prefer existing Listener hooks (\`scaffold_plugin\` kind=hook).`,
        `3. Check i18n with \`validate_code\` mode=i18n if adding UI text.`,
        `4. Confirm no existing plugin already handles this (\`summarize_repo\` subfolder=plugins).`,
        ``,
        `## Step 5 — Risks (${risks.length})`,
        risks.length > 0
          ? risks.map((r) => `- ${r}`).join("\n")
          : "No risky global patterns detected in inferred files.",
        ``,
        `## Step 6 — Validation`,
        `- [ ] \`validate_code\` mode=plugin (new plugins) or mode=grep`,
        `- [ ] \`validate_code\` mode=build for the npm/gulp command`,
        `- [ ] Visually verify via the hinted dev command`,
        ``,
        `## Proceed`,
        `When confident, call \`draft_patch\` with this plan as plan_context. That tool still does not write files.`,
      ].join("\n");

      return ok(plan);
    }
  );
}
