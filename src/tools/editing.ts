import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { Config } from "../config.js";
import { readFileSafe, fileExists } from "../utils/fs.js";
import { inferFeatureFiles, detectRisks } from "../utils/lampa.js";

export function registerEditingTools(server: McpServer, config: Config): void {
  // ── draft_patch ────────────────────────────────────────────────────────────
  server.tool(
    "draft_patch",
    "Draft a code patch for a Lampa change. Requires a prior plan_feature_change call. Returns annotated diff-style suggestions.",
    {
      request: z.string().describe("The change to implement."),
      target_files: z
        .array(z.string())
        .optional()
        .describe("Files to focus on (repo-relative paths)."),
      plan_context: z
        .string()
        .optional()
        .describe("Paste the output of plan_feature_change here for best results."),
    },
    async ({ request, target_files, plan_context }) => {
      const files = target_files ?? inferFeatureFiles(config.repoPath, request);
      const risks = detectRisks(config.repoPath, files);

      const fileSnippets: string[] = [];
      for (const f of files.slice(0, 5)) {
        const abs = path.join(config.repoPath, f);
        if (!fileExists(abs)) continue;
        const content = readFileSafe(abs) ?? "";
        const preview = content.split("\n").slice(0, 30).join("\n");
        fileSnippets.push(`### ${f} (first 30 lines)\n\`\`\`javascript\n${preview}\n\`\`\``);
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
        `## File previews`,
        fileSnippets.join("\n\n"),
        ``,
        `## Risks before editing`,
        risks.length > 0 ? risks.map((r) => `⚠ ${r}`).join("\n") : "✓ None detected.",
        ``,
        `## Patch guidance`,
        `Based on Lampa conventions:`,
        ``,
        `1. **Plugin entry point pattern** (if adding a plugin):`,
        `\`\`\`javascript`,
        `// plugins/myplugin/main.js`,
        `(function() {`,
        `  'use strict';`,
        ``,
        `  function init() {`,
        `    // Register settings`,
        `    Lampa.Settings.add('myplugin', {`,
        `      component: 'myplugin',`,
        `      name: 'My Plugin'`,
        `    });`,
        ``,
        `    // Hook into events`,
        `    Lampa.Listener.follow('full', function(e) {`,
        `      if (e.type === 'complite') {`,
        `        // inject UI`,
        `      }`,
        `    });`,
        `  }`,
        ``,
        `  if (window.appready) init();`,
        `  else $(document).on('appready', init);`,
        `})();`,
        `\`\`\``,
        ``,
        `2. **Settings entry pattern**:`,
        `\`\`\`javascript`,
        `Lampa.Settings.add('section_name', {`,
        `  component: 'component_name',`,
        `  name: 'Display Name',`,
        `  icon: '<svg>...</svg>'`,
        `});`,
        `\`\`\``,
        ``,
        `3. **Storage read/write pattern**:`,
        `\`\`\`javascript`,
        `var value = Lampa.Storage.get('my_key', 'default_value');`,
        `Lampa.Storage.set('my_key', newValue);`,
        `\`\`\``,
        ``,
        `> ⚠ This is a guided draft. Read target files with \`read_file_segment\` and adapt patterns exactly to match the surrounding code style.`,
      ]
        .filter((l) => l !== undefined)
        .join("\n");

      return { content: [{ type: "text", text: draft }] };
    }
  );

  // ── insert_hook ────────────────────────────────────────────────────────────
  server.tool(
    "insert_hook",
    "Find the best Lampa.Listener or Lampa.Event hook point for a given trigger or lifecycle event.",
    {
      trigger: z
        .string()
        .describe(
          "The event or lifecycle moment, e.g. 'player start', 'card render', 'settings open'."
        ),
    },
    async ({ trigger }) => {
      const lower = trigger.toLowerCase();
      const hints: string[] = [];

      const eventMap: Array<{ keywords: string[]; event: string; description: string }> = [
        {
          keywords: ["player", "play", "video"],
          event: "Lampa.Listener.follow('player', fn)",
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

      for (const entry of eventMap) {
        if (entry.keywords.some((k) => lower.includes(k))) {
          hints.push(`### ${entry.event}\n${entry.description}`);
        }
      }

      if (hints.length === 0) {
        hints.push(
          `No specific hook found for "${trigger}". Try searching with: search_code('Lampa.Listener') to see all registered hooks in the repo.`
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `# Hook insertion for: "${trigger}"\n\n${hints.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ── add_setting ────────────────────────────────────────────────────────────
  server.tool(
    "add_setting",
    "Generate the boilerplate to add a new setting to Lampa's settings panel.",
    {
      key: z.string().describe("Storage key for the setting, e.g. 'my_plugin_enabled'."),
      label: z.string().describe("Human-readable label shown in the UI."),
      type: z.enum(["toggle", "select", "input"]).describe("Setting type."),
      default_value: z.string().optional().describe("Default value."),
      options: z.array(z.string()).optional().describe("Options for 'select' type."),
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
            type: "text",
            text: `# New setting: ${key}\n\n## Registration snippet\n\`\`\`javascript\n${snippet}\n\`\`\`\n\n## Reading the value\n\`\`\`javascript\n${read}\n\`\`\``,
          },
        ],
      };
    }
  );

  // ── scaffold_plugin_integration ────────────────────────────────────────────
  server.tool(
    "scaffold_plugin_integration",
    "Generate a complete Lampa plugin scaffold (folder structure + main.js boilerplate) for a new plugin.",
    {
      plugin_name: z.string().describe("Plugin name, e.g. 'my_feature'. Use snake_case."),
      description: z.string().describe("One-sentence description of what the plugin does."),
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

      return { content: [{ type: "text", text: scaffold }] };
    }
  );
}
