import type { RepoFs } from "../fs/types.js";
import { joinRepo } from "../fs/paths.js";
import { fileExists, listFilesRecursive, readFileSafe } from "./fs.js";

export type PluginDocsLang = "en" | "ru";

export const PLUGIN_DOC_CHAPTERS: Array<{
  id: string;
  file: string;
  aliases: string[];
  title: string;
}> = [
  {
    id: "01",
    file: "01-getting-started.md",
    aliases: ["getting-started", "overview", "skeleton", "guard", "start"],
    title: "Overview & File Structure",
  },
  {
    id: "02",
    file: "02-lifecycle.md",
    aliases: ["lifecycle", "component", "destroy", "inited"],
    title: "Lifecycle",
  },
  {
    id: "03",
    file: "03-events.md",
    aliases: ["events", "listener", "subscribe", "player-events"],
    title: "Events System",
  },
  {
    id: "04",
    file: "04-storage-network.md",
    aliases: ["storage", "network", "request", "reguest", "http"],
    title: "Storage & Network",
  },
  {
    id: "05",
    file: "05-templates-lang.md",
    aliases: ["templates", "lang", "i18n", "css", "localization"],
    title: "Templates & Localization",
  },
  {
    id: "06",
    file: "06-ui-components.md",
    aliases: ["ui", "noty", "select", "modal", "scroll"],
    title: "UI Components",
  },
  {
    id: "07",
    file: "07-navigation.md",
    aliases: ["navigation", "activity", "router", "component.add"],
    title: "Navigation",
  },
  {
    id: "08",
    file: "08-settings.md",
    aliases: ["settings", "settingsapi", "addparam", "trigger"],
    title: "Settings API",
  },
  {
    id: "09",
    file: "09-manifest-menu.md",
    aliases: ["manifest", "menu", "context-menu", "oncontextlauch"],
    title: "Manifest & Menu",
  },
  {
    id: "10",
    file: "10-player.md",
    aliases: ["player", "playervideo", "tracks", "subs", "torrent"],
    title: "Player Integration",
  },
  {
    id: "11",
    file: "11-pitfalls.md",
    aliases: ["pitfalls", "mistakes", "leaks", "gotchas"],
    title: "Pitfalls",
  },
  {
    id: "12",
    file: "12-debug.md",
    aliases: ["debug", "logging", "console", "dev"],
    title: "Debug & Logging",
  },
  {
    id: "13",
    file: "13-controller.md",
    aliases: ["controller", "keypad", "tv", "remote", "selector", "hover"],
    title: "Controller & TV Navigation",
  },
];

const CHEATSHEET = `# Global Namespace Cheatsheet

| Object | Purpose |
|---|---|
| \`Lampa.Listener\` | Global app event bus |
| \`Lampa.Storage\` | Persistent key-value store |
| \`Lampa.Lang\` | i18n — add and translate strings |
| \`Lampa.Template\` | Register and retrieve HTML templates |
| \`Lampa.Activity\` | Push / pop navigation screens |
| \`Lampa.Component\` | Register page components by name |
| \`Lampa.Reguest\` | HTTP request wrapper (use \`new\`) |
| \`Lampa.Select\` | Bottom-sheet picker UI |
| \`Lampa.Modal\` | Modal overlay UI |
| \`Lampa.Noty\` | Toast notification |
| \`Lampa.Player\` | Player lifecycle events |
| \`Lampa.PlayerVideo\` | Video element events |
| \`Lampa.PlayerPanel\` | Player UI panel (tracks, subtitles) |
| \`Lampa.SettingsApi\` | Add settings sections and params |
| \`Lampa.Manifest\` | App metadata + plugin registration |
| \`Lampa.Platform\` | Platform detection |
| \`Lampa.Subscribe\` | Create a private event bus |
| \`Lampa.Controller\` | Focus / remote-key region |
| \`Lampa.Keypad\` | Raw remote key events |
`;

export function pluginDocsDir(pluginDocsPath: string, lang: PluginDocsLang = "en"): string {
  return joinRepo(pluginDocsPath, lang);
}

export function resolveChapter(query: string): (typeof PLUGIN_DOC_CHAPTERS)[number] | null {
  const q = query.trim().toLowerCase().replace(/\.md$/, "");
  return (
    PLUGIN_DOC_CHAPTERS.find((c) => {
      const num = String(Number.parseInt(c.id, 10));
      return (
        c.id === q ||
        num === q ||
        c.file.replace(/\.md$/, "") === q ||
        c.file.startsWith(`${q}-`) ||
        (q.length >= 3 && c.file.startsWith(q)) ||
        c.title.toLowerCase() === q ||
        c.aliases.includes(q) ||
        c.aliases.some((a) => q.includes(a) || a.includes(q))
      );
    }) ?? null
  );
}

export async function pluginDocsAvailable(
  fs: RepoFs,
  pluginDocsPath: string,
  lang: PluginDocsLang = "en"
): Promise<boolean> {
  return fileExists(fs, joinRepo(pluginDocsDir(pluginDocsPath, lang), "README.md"));
}

export async function formatPluginGuideToc(
  fs: RepoFs,
  pluginDocsPath: string,
  lang: PluginDocsLang = "en"
): Promise<string> {
  const dir = pluginDocsDir(pluginDocsPath, lang);
  const readme = await readFileSafe(fs, joinRepo(dir, "README.md"));
  const chapters = PLUGIN_DOC_CHAPTERS.map(
    (c) => `- \`${c.id}\` / \`${c.aliases[0]}\` — ${c.title} (\`${dir}/${c.file}\`)`
  ).join("\n");

  const tocFromReadme = readme
    ? readme
        .split("\n")
        .filter((l) => /^\s*(\d+\.|-|\*)\s+\[/.test(l) || /^#{1,3}\s/.test(l))
        .slice(0, 40)
        .join("\n")
    : "";

  return [
    `# Lampa Plugin Development Guide (${lang})`,
    ``,
    `Source: \`${dir}/\` — official plugin docs in the Lampa snapshot. Do not copy into the MCP repo.`,
    ``,
    `Use \`plugin_docs\` / \`doc_lookup\` to read a chapter. Preferred bootstrap:`,
    ``,
    "```js",
    "if (window.appready) init()",
    "else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })",
    "```",
    ``,
    `## Chapters`,
    chapters,
    tocFromReadme ? `\n## Index excerpt\n\n${tocFromReadme}` : "",
    ``,
    CHEATSHEET,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export async function readPluginChapter(
  fs: RepoFs,
  pluginDocsPath: string,
  chapter: string,
  lang: PluginDocsLang = "en"
): Promise<{ path: string; text: string } | null> {
  const meta = resolveChapter(chapter);
  const dir = pluginDocsDir(pluginDocsPath, lang);
  const file = meta
    ? joinRepo(dir, meta.file)
    : joinRepo(dir, chapter.endsWith(".md") ? chapter : `${chapter}.md`);
  if (!(await fileExists(fs, file))) return null;
  const text = await readFileSafe(fs, file);
  if (!text) return null;
  return { path: file, text };
}

export interface PluginDocHit {
  file: string;
  heading: string;
  line: number;
  preview: string;
}

export async function searchPluginDocs(
  fs: RepoFs,
  pluginDocsPath: string,
  query: string,
  lang: PluginDocsLang = "en",
  limit = 12
): Promise<PluginDocHit[]> {
  const dir = pluginDocsDir(pluginDocsPath, lang);
  if (!(await fileExists(fs, dir))) return [];

  const files = (await listFilesRecursive(fs, dir, [".md"])).sort();
  const needle = query.toLowerCase();
  const hits: PluginDocHit[] = [];

  for (const file of files) {
    const content = (await readFileSafe(fs, file)) ?? "";
    const lines = content.split("\n");
    let heading = file;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,3}\s+/.test(line)) heading = line.replace(/^#+\s+/, "").trim();
      if (!line.toLowerCase().includes(needle)) continue;
      const preview = lines
        .slice(Math.max(0, i - 1), Math.min(lines.length, i + 3))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280);
      hits.push({ file, heading, line: i + 1, preview });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export function formatDocHits(hits: PluginDocHit[]): string {
  if (hits.length === 0) return "";
  return hits.map((h) => `### ${h.file}:${h.line} — ${h.heading}\n${h.preview}`).join("\n\n");
}

/** Condensed event tables from docs/en/03-events.md (stable; not a full chapter dump). */
export const PLUGIN_EVENTS_CHEATSHEET = `# Lampa plugin events

Source: official plugin docs chapter 3. Subscribe with \`.follow(type, namedFn)\` and unsubscribe with \`.remove(type, namedFn)\`.

## Lampa.Listener (app-wide)

| Event | Notes |
|---|---|
| \`app\` | \`e.type\`: \`start\` (boot began) / \`ready\` (all APIs safe) |
| \`activity\` | \`e.type\`: \`create\` \\| \`init\` \\| \`start\` \\| \`destroy\` \\| \`archive\`; \`e.component\`, \`e.object\` |
| \`full\` | Card detail page lifecycle |
| \`torrent\` / \`torrent_file\` | Torrent search; file list \`list_open\` / \`list_close\` / \`render\` |
| \`line\` | Horizontal content-row events |
| \`resize_start\` / \`resize_end\` | Window resize |
| \`request_before\` / \`request_error\` / \`request_secuses\` | Network layer around loading overlay |

## Lampa.Player.listener

| Event | Notes |
|---|---|
| \`create\` | Before open; \`data.abort()\` cancels launch |
| \`start\` | Player opened; subscribe to PlayerVideo here |
| \`ready\` | Video element created |
| \`destroy\` | Player closed — **remove all PlayerVideo listeners** |
| \`external\` | Opening an external player app |

## Lampa.PlayerVideo.listener

Recreated every player open. Subscribe on \`Player:start\`, remove on \`Player:destroy\`.

\`canplay\`, \`timeupdate\` \`{duration,current}\`, \`ended\`, \`error\` \`{error,fatal}\`, \`play\`, \`pause\`, \`rewind\`, \`tracks\`, \`subs\`, \`levels\`, \`progress\`, \`loadeddata\`, \`videosize\`, \`translate\`, \`reset_continue\`, plus WebOS \`webos_tracks\` / \`webos_subs\`.

## Other buses

| Bus | Events |
|---|---|
| \`Lampa.Storage.listener\` | \`change\` / \`add\` / \`clear\` |
| \`Lampa.Favorite.listener\` | \`add\` / \`added\` / \`remove\` (\`where\`: like, wath, history, book) |
| \`Lampa.Keypad.listener\` | \`left/right/up/down/enter/back\`, \`keydown\` |

## App-ready (do not use jQuery)

\`\`\`js
if (window.appready) init()
else Lampa.Listener.follow('app', e => { if (e.type == 'ready') init() })
\`\`\`
`;
