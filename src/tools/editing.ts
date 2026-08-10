import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import { searchCode } from "../utils/search.js";
import { inferFeatureFiles, detectRisks } from "../utils/lampa.js";

interface AnchorHit {
  line: number; // 1-based
  kind: string;
  label: string;
}

function findAnchor(content: string): AnchorHit | null {
  const lines = content.split("\n");
  const patterns: Array<{ re: RegExp; kind: string; label: (m: RegExpMatchArray) => string }> = [
    {
      re: /(?:^|\s)function\s+([A-Za-z_$][\w$]*)\s*\(/,
      kind: "function",
      label: (m) => m[1],
    },
    {
      re: /SettingsApi\.add\s*\(/,
      kind: "SettingsApi.add",
      label: () => "SettingsApi.add",
    },
    {
      re: /Listener\.follow\s*\(/,
      kind: "Listener.follow",
      label: () => "Listener.follow",
    },
    {
      re: /Component\.add\s*\(/,
      kind: "Component.add",
      label: () => "Component.add",
    },
    {
      re: /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s*([A-Za-z_$][\w$]*)?/,
      kind: "export",
      label: (m) => m[1] ?? "export",
    },
    {
      re: /exports\.([A-Za-z_$][\w$]*)/,
      kind: "export",
      label: (m) => m[1],
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = lines[i].match(p.re);
      if (m) {
        return { line: i + 1, kind: p.kind, label: p.label(m) };
      }
    }
  }
  return null;
}

function buildUnifiedDiffSuggestion(
  file: string,
  content: string,
  request: string
): string {
  const lines = content.split("\n");
  const anchor = findAnchor(content);
  const anchorLine = anchor?.line ?? Math.min(10, Math.max(lines.length, 1));
  const ctxBefore = 3;
  const ctxAfter = 3;
  const start = Math.max(1, anchorLine - ctxBefore);
  const end = Math.min(lines.length, anchorLine + ctxAfter);
  const oldCount = end - start + 1;
  const newCount = oldCount + 2;

  const hunkLines: string[] = [];
  for (let ln = start; ln <= end; ln++) {
    const text = lines[ln - 1] ?? "";
    hunkLines.push(` ${text}`);
    if (ln === anchorLine) {
      hunkLines.push(`+// TODO: ${request}`);
      hunkLines.push(`+// Insert change near ${anchor?.kind ?? "anchor"} (${anchor?.label ?? "start"})`);
    }
  }

  const header = anchor
    ? `@@ -${start},${oldCount} +${start},${newCount} @@ ${anchor.kind}: ${anchor.label}`
    : `@@ -${start},${oldCount} +${start},${newCount} @@`;

  return [
    `### ${file}`,
    anchor
      ? `Anchor: \`${anchor.kind}\` → \`${anchor.label}\` at line ${anchor.line}`
      : `Anchor: first available context (no named symbol found)`,
    "```diff",
    `--- a/${file}`,
    `+++ b/${file}`,
    header,
    ...hunkLines,
    "```",
  ].join("\n");
}

export function registerEditingTools(server: McpServer, config: Config): void {
  // ── draft_patch ────────────────────────────────────────────────────────────
  server.registerTool(
    "draft_patch",
    {
      description:
        "Draft a code patch for a Lampa change. Requires a prior plan_feature_change / plan_change call. Returns unified-diff suggestions anchored to real symbols in each target file.",
      inputSchema: {
        request: z.string().describe("The change to implement."),
        target_files: z
          .array(z.string())
          .optional()
          .describe("Files to focus on (repo-relative paths)."),
        plan_context: z
          .string()
          .optional()
          .describe("Paste the output of plan_feature_change / plan_change here for best results."),
      },
    },
    async ({ request, target_files, plan_context }) => {
      const files = target_files ?? (await inferFeatureFiles(config.fs, request));
      const risks = await detectRisks(config.fs, files);

      const diffs: string[] = [];
      for (const f of files.slice(0, 5)) {
        if (!(await fileExists(config.fs, f))) {
          diffs.push(`### ${f}\nFile not found — create new file or pick another target.`);
          continue;
        }
        const content = (await readFileSafe(config.fs, f)) ?? "";
        diffs.push(buildUnifiedDiffSuggestion(f, content, request));
      }

      const draft = [
        `# Draft Patch: "${request}"`,
        ``,
        plan_context ? `## Plan context\n${plan_context}\n` : "",
        `## Target files`,
        files
          .slice(0, 6)
          .map((f) => `- ${f}`)
          .join("\n"),
        ``,
        `## Unified-diff suggestions`,
        diffs.join("\n\n") || "No target files available.",
        ``,
        `## Risks before editing`,
        risks.length > 0 ? risks.map((r) => `⚠ ${r}`).join("\n") : "✓ None detected.",
        ``,
        `## Patch guidance`,
        `Based on Lampa conventions:`,
        ``,
        `1. **Plugin entry point pattern** (if adding a plugin): use \`scaffold_plugin_integration\`.`,
        `2. **Settings:** \`Lampa.Settings.add(...)\` / \`SettingsApi.add(...)\``,
        `3. **Storage:** \`Lampa.Storage.get/set\``,
        `4. **Events:** \`Lampa.Listener.follow\` / \`Lampa.Listener.send\``,
        ``,
        `> ⚠ Guided draft only. Read the full anchor region with \`read_file_segment\` and adapt to surrounding style.`,
      ]
        .filter((l) => l !== undefined)
        .join("\n");

      return { content: [{ type: "text" as const, text: draft }] };
    }
  );

  // ── insert_hook ────────────────────────────────────────────────────────────
  server.registerTool(
    "insert_hook",
    {
      description:
        "Find the best Lampa.Listener / Player.listener hook point for a trigger. Searches live code plus recommended patterns.",
      inputSchema: {
        trigger: z
          .string()
          .describe(
            "The event or lifecycle moment, e.g. 'player start', 'card render', 'settings open'."
          ),
      },
    },
    async ({ trigger }) => {
      const lower = trigger.toLowerCase();
      const keyword =
        lower
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2)
          .sort((a, b) => b.length - a.length)[0] ?? trigger;

      const searchPatterns = [
        "Lampa.Listener.follow",
        "Player.listener.follow",
        "Lampa.Listener.send",
      ];

      const liveHits: string[] = [];
      for (const pat of searchPatterns) {
        const withKeyword = await searchCode(config.fs, keyword, ["*.js"], false, "src");
        const base = await searchCode(config.fs, pat, ["*.js"], false, "src");
        const pluginBase = await searchCode(config.fs, pat, ["*.js"], false, "plugins");

        const related = [...withKeyword, ...base, ...pluginBase].filter(
          (m) =>
            (m.text.includes("Listener.follow") ||
              m.text.includes("listener.follow") ||
              m.text.includes("Listener.send")) &&
            (m.text.toLowerCase().includes(keyword.toLowerCase()) ||
              lower.split(/\s+/).some((w) => w.length > 3 && m.text.toLowerCase().includes(w)))
        );

        for (const m of related.slice(0, 8)) {
          const line = `${m.file}:${m.line}  ${m.text}`;
          if (!liveHits.includes(line)) liveHits.push(line);
        }
      }

      // Fallback broader search if keyword filter was too tight
      if (liveHits.length === 0) {
        for (const pat of searchPatterns) {
          const hits = [
            ...(await searchCode(config.fs, pat, ["*.js"], false, "src")),
            ...(await searchCode(config.fs, pat, ["*.js"], false, "plugins")),
          ];
          for (const m of hits.slice(0, 5)) {
            const line = `${m.file}:${m.line}  ${m.text}`;
            if (!liveHits.includes(line)) liveHits.push(line);
          }
        }
      }

      const eventMap: Array<{ keywords: string[]; event: string; description: string }> = [
        {
          keywords: ["player", "play", "video"],
          event: "Lampa.Listener.follow('player', fn)  // or Player.listener.follow",
          description: "Player lifecycle: start, end, pause, resume, destroy",
        },
        {
          keywords: ["card", "render", "full"],
          event: "Lampa.Listener.follow('full', fn)",
          description: "Full card view lifecycle: create, complite, destroy",
        },
        {
          keywords: ["settings", "open", "menu"],
          event: "Lampa.Listener.follow('settings', fn)",
          description: "Settings panel events",
        },
        {
          keywords: ["app", "ready", "init", "start"],
          event: "$(document).on('appready', fn)",
          description: "App fully initialized",
        },
        {
          keywords: ["catalog", "feed", "list"],
          event: "Lampa.Listener.follow('catalog', fn)",
          description: "Catalog/feed events",
        },
        {
          keywords: ["activity", "navigate", "route"],
          event: "Lampa.Activity.listener.follow('activity', fn)",
          description: "Navigation stack changes",
        },
        {
          keywords: ["torrent", "magnet"],
          event: "Lampa.Listener.follow('torrent', fn)",
          description: "Torrent-related events",
        },
        {
          keywords: ["storage", "save", "load"],
          event: "Lampa.Storage.listener.follow('change', fn)",
          description: "Storage change events",
        },
      ];

      const recommended: string[] = [];
      for (const entry of eventMap) {
        if (entry.keywords.some((k) => lower.includes(k))) {
          recommended.push(`### ${entry.event}\n${entry.description}`);
        }
      }
      if (recommended.length === 0) {
        recommended.push(
          `No static recommendation matched "${trigger}". Prefer live hits below, or search \`Lampa.Listener\` / \`Player.listener\`.`
        );
      }

      const text = [
        `# Hook insertion for: "${trigger}"`,
        ``,
        `## Recommended pattern`,
        recommended.join("\n\n"),
        ``,
        `## Live code hits (keyword: "${keyword}")`,
        liveHits.slice(0, 20).join("\n") || "No matching Listener.follow / Listener.send / Player.listener.follow hits.",
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── add_setting ────────────────────────────────────────────────────────────
  server.registerTool(
    "add_setting",
    {
      description: "Generate the boilerplate to add a new setting to Lampa's settings panel.",
      inputSchema: {
        key: z.string().describe("Storage key for the setting, e.g. 'my_plugin_enabled'."),
        label: z.string().describe("Human-readable label shown in the UI."),
        type: z.enum(["toggle", "select", "input"]).describe("Setting type."),
        default_value: z.string().optional().describe("Default value."),
        options: z.array(z.string()).optional().describe("Options for 'select' type."),
      },
    },
    async ({ key, label, type, default_value, options }) => {
      let snippet: string;

      if (type === "toggle") {
        snippet = `Lampa.Settings.add('my_plugin', {
  component: 'my_plugin',
  name: 'My Plugin',
  items: [
    {
      name: '${label}',
      type: 'toggle',
      field: '${key}',
      default: ${default_value ?? "false"}
    }
  ]
});`;
      } else if (type === "select") {
        const opts = (options ?? [])
          .map((o) => `{ title: '${o}', value: '${o}' }`)
          .join(",\n      ");
        snippet = `Lampa.Settings.add('my_plugin', {
  component: 'my_plugin',
  name: 'My Plugin',
  items: [
    {
      name: '${label}',
      type: 'select',
      field: '${key}',
      default: '${default_value ?? ""}',
      values: {
        ${opts}
      }
    }
  ]
});`;
      } else {
        snippet = `Lampa.Settings.add('my_plugin', {
  component: 'my_plugin',
  name: 'My Plugin',
  items: [
    {
      name: '${label}',
      type: 'input',
      field: '${key}',
      default: '${default_value ?? ""}'
    }
  ]
});`;
      }

      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const defaultVal =
        type === "toggle" ? (default_value ?? "false") : `'${default_value ?? ""}'`;
      const read = `// Read the value anywhere:\nvar ${camelKey} = Lampa.Storage.get('${key}', ${defaultVal});`;

      return {
        content: [
          {
            type: "text" as const,
            text: `# New setting: ${key}\n\n## Registration snippet\n\`\`\`javascript\n${snippet}\n\`\`\`\n\n## Reading the value\n\`\`\`javascript\n${read}\n\`\`\``,
          },
        ],
      };
    }
  );

  // ── scaffold_plugin_integration ────────────────────────────────────────────
  server.registerTool(
    "scaffold_plugin_integration",
    {
      description:
        "Generate a complete Lampa plugin scaffold (folder structure + main.js boilerplate) for a new plugin. Prefer this over generate_plugin_boilerplate.",
      inputSchema: {
        plugin_name: z.string().describe("Plugin name, e.g. 'my_feature'. Use snake_case."),
        description: z.string().describe("One-sentence description of what the plugin does."),
      },
    },
    async ({ plugin_name, description }) => {
      const cssClass = plugin_name.replace(/_/g, "-");
      const displayName = plugin_name.replace(/_/g, " ");

      const scaffold = `# Plugin scaffold: plugins/${plugin_name}/

## plugins/${plugin_name}/main.js
\`\`\`javascript
(function() {
  'use strict';

  var component_name = '${plugin_name}';

  // ── Settings ────────────────────────────────────────────────────────────
  function registerSettings() {
    Lampa.Settings.add(component_name, {
      component: component_name,
      name: '${displayName}',
      items: [
        {
          name: 'Enable ${description}',
          type: 'toggle',
          field: '${plugin_name}_enabled',
          default: true
        }
      ]
    });
  }

  // ── Component ───────────────────────────────────────────────────────────
  function Component(object) {
    var network = new Lampa.Reguest();
    var scroll  = new Lampa.Scroll({ mask: true, over: true });
    var items   = [];

    this.create = function() {
      // build UI here
    };

    this.start = function() {
      Lampa.Controller.enable(component_name);
    };

    this.pause = function() {};
    this.stop  = function() {};

    this.destroy = function() {
      network.clear();
      scroll.destroy();
      items = [];
    };
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    registerSettings();
    Lampa.Component.add(component_name, Component);
  }

  if (window.appready) init();
  else $(document).on('appready', init);

})();
\`\`\`

## plugins/${plugin_name}/css/style.css
\`\`\`css
/* Styles for ${plugin_name} plugin */
.${cssClass}__wrap {
  display: flex;
  flex-direction: column;
}
\`\`\`

## To include in Lampa build
Add to the appropriate assembly.json or load via a \`<script>\` tag referencing
\`plugins/${plugin_name}/main.js\`.
`;

      return { content: [{ type: "text" as const, text: scaffold }] };
    }
  );
}
