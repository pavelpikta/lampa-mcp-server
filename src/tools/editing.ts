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

function buildUnifiedDiffSuggestion(file: string, content: string, request: string): string {
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
      hunkLines.push(
        `+// Insert change near ${anchor?.kind ?? "anchor"} (${anchor?.label ?? "start"})`
      );
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

function pascalName(pluginName: string): string {
  return pluginName
    .split(/[_-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function buildOfficialScaffold(
  pluginName: string,
  description: string,
  kind: "screen" | "player" | "context-menu" | "settings-only"
): string {
  const cssClass = pluginName.replace(/_/g, "-");
  const displayName = pluginName.replace(/_/g, " ");
  const pascal = pascalName(pluginName);
  const flag = `${pluginName}_ready`;
  const componentId = `${pluginName}_screen`;
  const startFn = `start${pascal}`;

  const langBlock = `    Lampa.Lang.add({
        ${pluginName}_title: { ru: '${displayName}', en: '${displayName}' },
        ${pluginName}_settings: { ru: 'Настройки ${displayName}', en: '${displayName} settings' },
        ${pluginName}_enabled: { ru: 'Включить', en: 'Enable' }
    })`;

  const cssBlock = `    Lampa.Template.add('${pluginName}_css', \`
        <style>
            .${cssClass} { padding: 1em; }
        </style>
    \`)
    $('body').append(Lampa.Template.get('${pluginName}_css', {}, true))`;

  const settingsBlock = `    Lampa.SettingsApi.addComponent({
        component: '${pluginName}',
        name: Lampa.Lang.translate('${pluginName}_settings'),
        icon: '<svg width="44" height="44" viewBox="0 0 44 44"></svg>'
    })
    Lampa.SettingsApi.addParam({
        component: '${pluginName}',
        param: { name: '${pluginName}_enabled', type: 'trigger', default: true },
        field: { name: Lampa.Lang.translate('${pluginName}_enabled') }
    })`;

  const boot = `    if (window.appready) init()
    else Lampa.Listener.follow('app', function(e) {
        if (e.type == 'ready') init()
    })`;

  let body: string;

  if (kind === "settings-only") {
    body = `${langBlock}

    function init() {
${cssBlock}

${settingsBlock}
    }

${boot}`;
  } else if (kind === "player") {
    body = `${langBlock}

    function onPlayerStart(data) {
        var inited = true

        function onEnded() {
            if (!inited) return
            console.log('${pascal}', 'ended', data.title)
        }

        function onDestroy() {
            inited = false
            Lampa.PlayerVideo.listener.remove('ended', onEnded)
            Lampa.Player.listener.remove('destroy', onDestroy)
        }

        Lampa.PlayerVideo.listener.follow('ended', onEnded)
        Lampa.Player.listener.follow('destroy', onDestroy)
    }

    function init() {
${cssBlock}

${settingsBlock}

        Lampa.Player.listener.follow('start', onPlayerStart)
    }

${boot}`;
  } else if (kind === "context-menu") {
    body = `${langBlock}

    function ${pascal}Screen(object) {
        var html = Lampa.Template.get('${pluginName}_main', { title: object.title || '' })
        var network = new Lampa.Reguest()
        var inited = false

        this.create = function() {
            inited = true
            this.activity.loader(false)
            return this.render()
        }
        this.start = function() {
            Lampa.Controller.add('content', {
                toggle: function() {
                    Lampa.Controller.collectionSet(html)
                    Lampa.Controller.collectionFocus(false, html)
                },
                back: function() { Lampa.Activity.backward() }
            })
            Lampa.Controller.toggle('content')
        }
        this.stop = function() {}
        this.destroy = function() {
            inited = false
            network.clear()
            html.remove()
        }
        this.render = function() { return html }
    }

    var manifest = {
        type: 'video',
        version: '1.0.0',
        name: '${displayName}',
        description: '${description}',
        onContextMenu: function() {
            return { name: Lampa.Lang.translate('${pluginName}_title'), description: '' }
        },
        onContextLauch: function(card) {
            if (!Lampa.Component.get('${componentId}')) {
                Lampa.Component.add('${componentId}', ${pascal}Screen)
            }
            Lampa.Activity.push({
                url: '',
                title: Lampa.Lang.translate('${pluginName}_title'),
                component: '${componentId}',
                movie: card,
                search: card.title,
                search_two: card.original_title,
                page: 1
            })
        }
    }

    function init() {
        Lampa.Template.add('${pluginName}_main', \`
            <div class="${cssClass} selector">
                <div class="${cssClass}__title">{title}</div>
            </div>
        \`)
${cssBlock}

        Lampa.Component.add('${componentId}', ${pascal}Screen)
        Lampa.Manifest.plugins = manifest
${settingsBlock}
    }

${boot}`;
  } else {
    body = `${langBlock}

    Lampa.Template.add('${pluginName}_main', \`
        <div class="${cssClass}">
            <div class="${cssClass}__title">{title}</div>
        </div>
    \`)

    function ${pascal}Screen(object) {
        var network = new Lampa.Reguest()
        var scroll = new Lampa.Scroll({ mask: true, over: true })
        var html = Lampa.Template.get('${pluginName}_main', {
            title: Lampa.Lang.translate('${pluginName}_title')
        })
        var inited = false
        var last = false

        this.create = function() {
            inited = true
            this.activity.loader(true)
            scroll.append(html)
            this.activity.loader(false)
            return this.render()
        }

        this.start = function() {
            Lampa.Controller.add('content', {
                toggle: function() {
                    Lampa.Controller.collectionSet(scroll.render())
                    Lampa.Controller.collectionFocus(last || false, scroll.render())
                },
                left: function() { Lampa.Controller.toggle('menu') },
                right: function() { Navigator.move('right') },
                up: function() { if (Navigator.canmove('up')) Navigator.move('up') },
                down: function() { if (Navigator.canmove('down')) Navigator.move('down') },
                back: function() { Lampa.Activity.backward() }
            })
            Lampa.Controller.toggle('content')
        }

        this.stop = function() {}

        this.destroy = function() {
            inited = false
            network.clear()
            scroll.destroy()
            html.remove()
        }

        this.render = function() { return scroll.render() }

        this.empty = function() {
            this.activity.loader(false)
            this.activity.empty()
        }
    }

    function init() {
${cssBlock}

        Lampa.Component.add('${componentId}', ${pascal}Screen)
${settingsBlock}

        var btn = $('<li class="menu__item selector"><div class="menu__text">' +
            Lampa.Lang.translate('${pluginName}_title') + '</div></li>')
        btn.on('hover:enter', function() {
            Lampa.Activity.push({
                url: '',
                title: Lampa.Lang.translate('${pluginName}_title'),
                component: '${componentId}',
                page: 1
            })
        })
        $('.menu .menu__list').eq(0).append(btn)
    }

${boot}`;
  }

  return `# Plugin scaffold: plugins/${pluginName}/  (kind: ${kind})

Official pattern: unique global guard, \`Lampa.Listener\` app:ready (not jQuery appready),
SettingsApi, Lang ru+en, CSS inside init(), Controller.add + toggle.

Place entry at \`plugins/${pluginName}/${pluginName}.js\` (folder name = filename).

## plugins/${pluginName}/${pluginName}.js
\`\`\`javascript
function ${startFn}() {
    window.${flag} = true

${body}
}

if (!window.${flag}) ${startFn}()
\`\`\`

## plugins/${pluginName}/css/style.css
\`\`\`css
.${cssClass} {
  display: flex;
  flex-direction: column;
}
\`\`\`

Built-in plugins: Gulp may \`@@include('../plugins/${pluginName}/css/style.css')\` into the style template.
External plugins: keep CSS in the Template.add string as above.

Validate with \`validate_plugin\`. See \`lampa://plugin-guide\` and \`lampa://pitfalls\`.
`;
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
        `1. **Plugin entry:** \`scaffold_plugin_integration\` (official guard + Listener appready + SettingsApi).`,
        `2. **Settings:** \`Lampa.SettingsApi.addComponent\` / \`addParam\`; read with \`Lampa.Storage.field(key)\`.`,
        `3. **Storage:** prefix keys; \`Storage.get/set\` for plugin state, \`Storage.field\` for SettingsApi params.`,
        `4. **Events:** \`Lampa.Listener.follow('app', …)\` for ready; \`Player.listener\` / \`PlayerVideo.listener\` for playback.`,
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
        "Find the best Lampa.Listener / Player.listener / PlayerVideo / Storage / Favorite / Keypad hook for a trigger. Official plugin-docs catalog plus live code hits.",
      inputSchema: {
        trigger: z
          .string()
          .describe(
            "The event or lifecycle moment, e.g. 'player start', 'app ready', 'card full', 'storage change'."
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
        "PlayerVideo.listener.follow",
        "Storage.listener.follow",
        "Favorite.listener.follow",
        "Keypad.listener.follow",
      ];

      const liveHits: string[] = [];
      const prefixes = ["src", "plugins"] as const;
      for (const prefix of prefixes) {
        const withKeyword = await searchCode(config.fs, keyword, ["*.js"], false, prefix);
        for (const m of withKeyword) {
          if (
            !/listener\.follow|Listener\.follow|Listener\.send/i.test(m.text) &&
            !lower.split(/\s+/).some((w) => w.length > 3 && m.text.toLowerCase().includes(w))
          ) {
            continue;
          }
          if (
            /listener\.follow|Listener\.follow|Listener\.send/i.test(m.text) ||
            m.text.toLowerCase().includes(keyword.toLowerCase())
          ) {
            const line = `${m.file}:${m.line}  ${m.text}`;
            if (!liveHits.includes(line)) liveHits.push(line);
          }
        }
      }

      if (liveHits.length === 0) {
        for (const pat of searchPatterns) {
          for (const prefix of prefixes) {
            const hits = await searchCode(config.fs, pat, ["*.js"], false, prefix);
            for (const m of hits.slice(0, 5)) {
              const line = `${m.file}:${m.line}  ${m.text}`;
              if (!liveHits.includes(line)) liveHits.push(line);
            }
          }
        }
      }

      const eventMap: Array<{ keywords: string[]; event: string; description: string }> = [
        {
          keywords: ["app", "ready", "init", "boot"],
          event:
            "if (window.appready) init(); else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })",
          description:
            "App fully initialized. Do NOT use $(document).on('appready'). UI/Settings/Menu/Player are only safe after app:ready.",
        },
        {
          keywords: ["player", "play", "video", "playback"],
          event: "Lampa.Player.listener.follow('start'|'create'|'ready'|'destroy'|'external', fn)",
          description:
            "Player lifecycle. Subscribe to PlayerVideo inside start; remove every PlayerVideo handler in destroy. create can data.abort().",
        },
        {
          keywords: ["canplay", "timeupdate", "ended", "tracks", "subs", "subtitle"],
          event: "Lampa.PlayerVideo.listener.follow('canplay'|'timeupdate'|'ended'|…, namedFn)",
          description:
            "Video element events. Module is recreated each open — always .remove(type, namedFn) on Player:destroy.",
        },
        {
          keywords: ["card", "full", "detail"],
          event: "Lampa.Listener.follow('full', fn)",
          description: "Card detail (full-info) page lifecycle.",
        },
        {
          keywords: ["activity", "navigate", "route", "screen"],
          event: "Lampa.Listener.follow('activity', fn)",
          description:
            "Navigation stack. e.type: create | init | start | destroy | archive. Not Activity.listener.",
        },
        {
          keywords: ["line", "row", "catalog", "feed"],
          event: "Lampa.Listener.follow('line', fn)",
          description: "Horizontal content-row events.",
        },
        {
          keywords: ["torrent", "magnet"],
          event: "Lampa.Listener.follow('torrent'|'torrent_file', fn)",
          description: "Torrent search / file list (list_open, list_close, render).",
        },
        {
          keywords: ["storage", "save", "load"],
          event: "Lampa.Storage.listener.follow('change', fn)",
          description: "Storage writes. Payload {name, value}. Prefix plugin keys.",
        },
        {
          keywords: ["favorite", "bookmark", "like", "wath", "history"],
          event: "Lampa.Favorite.listener.follow('add'|'added'|'remove', fn)",
          description: "Bookmark categories. e.where is like | wath | history | book.",
        },
        {
          keywords: ["key", "remote", "keypad", "hotkey"],
          event: "Lampa.Keypad.listener.follow('keydown'|'left'|'enter'|…, namedFn)",
          description: "Global remote keys. Always remove in destroy — not scoped to a component.",
        },
        {
          keywords: ["settings", "menu"],
          event: "Lampa.SettingsApi.addComponent / addParam  (register in init after app:ready)",
          description: "Settings UI is not a Listener event. Register sections with SettingsApi.",
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
          `No catalog match for "${trigger}". See resource \`lampa://events\` or search \`Lampa.Listener\` / \`Player.listener\`.`
        );
      }

      const text = [
        `# Hook insertion for: "${trigger}"`,
        ``,
        `## Recommended pattern (plugin docs)`,
        recommended.join("\n\n"),
        ``,
        `## Live code hits (keyword: "${keyword}")`,
        liveHits.slice(0, 20).join("\n") ||
          "No matching Listener.follow / listener.follow hits. Narrow the trigger or use search_code with prefix=src.",
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── add_setting ────────────────────────────────────────────────────────────
  server.registerTool(
    "add_setting",
    {
      description:
        "Generate SettingsApi boilerplate (addComponent + addParam). Uses Storage.field() for reads. Prefer over Lampa.Settings.add.",
      inputSchema: {
        key: z.string().describe("Storage key, e.g. 'myplugin_enabled'. Prefix with plugin name."),
        label: z.string().describe("Human-readable label shown in the UI."),
        type: z
          .enum(["toggle", "select", "input", "trigger"])
          .describe("Setting type. toggle is an alias of trigger."),
        default_value: z.string().optional().describe("Default value."),
        options: z.array(z.string()).optional().describe("Options for 'select' type."),
        component: z
          .string()
          .optional()
          .describe("Settings section id. Defaults to the key prefix before the first underscore."),
      },
    },
    async ({ key, label, type, default_value, options, component }) => {
      const section = component ?? key.split("_")[0] ?? "my_plugin";
      const paramType = type === "toggle" ? "trigger" : type;
      let paramBody: string;

      if (paramType === "trigger") {
        paramBody = `{ name: '${key}', type: 'trigger', default: ${default_value ?? "false"} }`;
      } else if (paramType === "select") {
        const values = (options ?? ["low", "mid", "high"])
          .map((o) => `            ${o}: '${o}'`)
          .join(",\n");
        paramBody = `{ name: '${key}', type: 'select',
          values: {
${values}
          },
          default: '${default_value ?? options?.[0] ?? "mid"}' }`;
      } else {
        paramBody = `{ name: '${key}', type: 'input', placeholder: '', default: '${default_value ?? ""}' }`;
      }

      const snippet = `Lampa.SettingsApi.addComponent({
    component: '${section}',
    name: Lampa.Lang.translate('${section}_settings'),
    icon: '<svg width="44" height="44" viewBox="0 0 44 44"></svg>'
})

Lampa.SettingsApi.addParam({
    component: '${section}',
    param: ${paramBody},
    field: {
        name: '${label}',
        description: ''
    },
    onChange: () => {
        var value = Lampa.Storage.field('${key}')
        console.log('${section}', '${key}', value)
    }
})`;

      const read = `// SettingsApi params: use Storage.field() so the default is applied
var value = Lampa.Storage.field('${key}')`;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# New setting: ${key}`,
              ``,
              `Register inside \`init()\` after \`app:ready\`. Prefix storage keys with the plugin name.`,
              ``,
              `## Registration snippet`,
              "```javascript",
              snippet,
              "```",
              ``,
              `## Reading the value`,
              "```javascript",
              read,
              "```",
            ].join("\n"),
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
        "Generate an official Lampa plugin scaffold (guard, Listener appready, SettingsApi, Controller.add). Prefer this over generate_plugin_boilerplate.",
      inputSchema: {
        plugin_name: z.string().describe("Plugin name, e.g. 'my_feature'. Use snake_case."),
        description: z.string().describe("One-sentence description of what the plugin does."),
        kind: z
          .enum(["screen", "player", "context-menu", "settings-only"])
          .optional()
          .describe("screen (default) | player | context-menu | settings-only"),
      },
    },
    async ({ plugin_name, description, kind }) => {
      const text = buildOfficialScaffold(plugin_name, description, kind ?? "screen");
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
