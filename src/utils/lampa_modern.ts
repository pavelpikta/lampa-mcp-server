import path from "node:path";
import { listFilesRecursive, readFileSafe, fileExists } from "./fs.js";

// ── Maker architecture ─────────────────────────────────────────────────────

export interface MakerClassInfo {
  name: string;
  classPath: string;
  modulePath: string | null;
  mapPath: string | null;
  mapHooks: string[];
}

export function extractMakerClasses(repoPath: string): MakerClassInfo[] {
  const makerFile = path.join(repoPath, "src", "interaction", "maker.js");
  const content = readFileSafe(makerFile);
  if (!content) return [];

  const classNames: string[] = [];
  const classesMatch = content.match(/let classes = \{([\s\S]*?)\}/);
  if (classesMatch) {
    const pat = /(\w+)\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(classesMatch[1])) !== null) {
      if (m[1] !== "CardParser") classNames.push(m[1]);
    }
  }

  // CardParser is in classes but may be missed by simple regex — add from list() export
  if (!classNames.includes("CardParser") && content.includes("CardParser:")) {
    classNames.push("CardParser");
  }

  const unique = [...new Set(classNames)];

  return unique.map((name) => {
    const lower = name.toLowerCase();

    const candidates = [
      {
        classPath: `interaction/card/card.js`,
        module: `interaction/card/module/module.js`,
        map: `interaction/card/module/map.js`,
      },
      {
        classPath: `interaction/items/main.js`,
        module: `interaction/items/main/module/module.js`,
        map: `interaction/items/main/module/map.js`,
      },
      {
        classPath: `interaction/items/category.js`,
        module: `interaction/items/category/module/module.js`,
        map: `interaction/items/category/module/map.js`,
      },
      {
        classPath: `interaction/items/line.js`,
        module: `interaction/items/line/module/module.js`,
        map: `interaction/items/line/module/map.js`,
      },
      {
        classPath: `interaction/company/company.js`,
        module: `interaction/company/module/module.js`,
        map: `interaction/company/module/map.js`,
      },
      {
        classPath: `interaction/discuss/discuss.js`,
        module: `interaction/discuss/module/module.js`,
        map: `interaction/discuss/module/map.js`,
      },
      {
        classPath: `interaction/episode/episode.js`,
        module: `interaction/episode/module/module.js`,
        map: `interaction/episode/module/map.js`,
      },
      {
        classPath: `interaction/person/person.js`,
        module: `interaction/person/module/module.js`,
        map: `interaction/person/module/map.js`,
      },
      {
        classPath: `interaction/register/register.js`,
        module: `interaction/register/module/module.js`,
        map: `interaction/register/module/map.js`,
      },
      {
        classPath: `interaction/season/season.js`,
        module: `interaction/season/module/module.js`,
        map: `interaction/season/module/map.js`,
      },
      {
        classPath: `interaction/empty/empty.js`,
        module: `interaction/empty/module/module.js`,
        map: `interaction/empty/module/map.js`,
      },
      { classPath: `interaction/card_parser/card_parser.js`, module: null, map: null },
    ];

    const match =
      candidates.find(
        (c) =>
          c.classPath.toLowerCase().includes(`/${lower}/`) || c.classPath.includes(`/${lower}.`)
      ) ?? candidates.find((c) => path.basename(c.classPath, ".js") === lower);

    const classRel = match ? `src/${match.classPath}` : `src/interaction/**/${lower}.js`;
    const moduleRel = match?.module ? `src/${match.module}` : null;
    const mapRel = match?.map ? `src/${match.map}` : null;

    let mapHooks: string[] = [];
    if (mapRel && fileExists(path.join(repoPath, mapRel))) {
      const mapContent = readFileSafe(path.join(repoPath, mapRel)) ?? "";
      const hookPat = /(\w+)\s*:\s*\{/g;
      let hm: RegExpExecArray | null;
      while ((hm = hookPat.exec(mapContent)) !== null) {
        const hook = hm[1];
        if (
          !["export", "default", "onCreate", "onDestroy"].includes(hook) &&
          hook[0] === hook[0].toUpperCase()
        ) {
          mapHooks.push(hook);
        }
      }
      // Also catch hook keys like Create, Render, etc.
      const keyPat = /^(\w+)\s*:/gm;
      while ((hm = keyPat.exec(mapContent)) !== null) {
        const hook = hm[1];
        if (hook[0] === hook[0].toUpperCase() && !mapHooks.includes(hook)) {
          mapHooks.push(hook);
        }
      }
      mapHooks = [...new Set(mapHooks)].sort();
    }

    return { name, classPath: classRel, modulePath: moduleRel, mapPath: mapRel, mapHooks };
  });
}

// ── WebSocket protocol ───────────────────────────────────────────────────────

export interface SocketProtocol {
  inbound: Array<{ method: string; description: string; file: string }>;
  outbound: Array<{ method: string; file: string; context: string }>;
  mirrors: string[];
  urlPattern: string;
}

export function extractSocketProtocol(repoPath: string): SocketProtocol {
  const socketFile = path.join(repoPath, "src", "core", "socket.js");
  const manifestFile = path.join(repoPath, "src", "core", "manifest.js");
  const content = readFileSafe(socketFile) ?? "";
  const manifest = readFileSafe(manifestFile) ?? "";

  const inbound: SocketProtocol["inbound"] = [];
  const inboundMethods = [
    { method: "devices", description: "Device list sync" },
    { method: "open", description: "Remote navigation — pushes Activity" },
    { method: "timeline", description: "Watch progress sync from other devices" },
    { method: "bookmarks", description: "Triggers bookmark refresh" },
    { method: "terminal_activate", description: "Developer terminal access activation" },
    { method: "terminal_eval", description: "Remote eval in developer mode" },
    { method: "logoff", description: "Force account logout" },
    { method: "info", description: "Server info message" },
    { method: "token_status", description: "Account token status update" },
    { method: "buy_premium", description: "Premium purchase — refreshes user" },
    { method: "other.play", description: "Remote play request (submethod play)" },
  ];

  for (const item of inboundMethods) {
    const search = item.method.includes(".") ? item.method.split(".")[0] : item.method;
    if (content.includes(`'${search}'`) || content.includes(`"${search}"`)) {
      inbound.push({ ...item, file: "src/core/socket.js" });
    }
  }

  const outbound: SocketProtocol["outbound"] = [];
  const sendPat = /send\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  const outboundSet = new Set<string>();
  while ((m = sendPat.exec(content)) !== null) {
    if (!outboundSet.has(m[1])) {
      outboundSet.add(m[1]);
      outbound.push({ method: m[1], file: "src/core/socket.js", context: m[0] });
    }
  }

  const mirrorsMatch = manifest.match(/soc_mirrors['"]\s*,\s*\{\s*get:\s*\(\)\s*=>\s*\[([^\]]+)\]/);
  const mirrors = mirrorsMatch
    ? mirrorsMatch[1]
        .split(",")
        .map((s) => s.replace(/['"\s]/g, ""))
        .filter(Boolean)
    : ["cub.rip"];

  return {
    inbound,
    outbound,
    mirrors,
    urlPattern: "wss://{soc_mirror}:8443 (ws://:8080 on Orsay/Netcast)",
  };
}

// ── Component & route registry ───────────────────────────────────────────────

export interface ComponentRegistration {
  name: string;
  file: string;
  line: number;
  type: "component" | "router";
}

export function extractComponentRegistry(repoPath: string): ComponentRegistration[] {
  const jsFiles = listFilesRecursive(repoPath, [".js"]);
  const results: ComponentRegistration[] = [];
  const seen = new Set<string>();

  for (const file of jsFiles) {
    const content = readFileSafe(file);
    if (!content) continue;
    const rel = path.relative(repoPath, file);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const compMatch = line.match(/(?:Lampa\.)?Component\.add\(\s*['"]([^'"]+)['"]/);
      if (compMatch) {
        const key = `component:${compMatch[1]}@${rel}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ name: compMatch[1], file: rel, line: i + 1, type: "component" });
        }
      }

      const routeMatch = line.match(/router\.add\(\s*['"]([^'"]+)['"]/);
      if (routeMatch) {
        const key = `router:${routeMatch[1]}@${rel}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ name: routeMatch[1], file: rel, line: i + 1, type: "router" });
        }
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ── lampa_settings flags ─────────────────────────────────────────────────────

export interface LampaSettingFlag {
  key: string;
  defaultValue: string;
  nested?: boolean;
  gates?: string;
}

export function extractLampaSettingsFlags(repoPath: string): LampaSettingFlag[] {
  const appFile = path.join(repoPath, "src", "app.js");
  const content = readFileSafe(appFile);
  if (!content) return [];

  const flags: LampaSettingFlag[] = [];

  // Top-level flags from Arrays.extend(window.lampa_settings, { ... })
  const extendMatch = content.match(/Arrays\.extend\(window\.lampa_settings,\{([\s\S]*?)\}\)/);
  if (extendMatch) {
    const block = extendMatch[1];
    const linePat = /^\s*(\w+)\s*:\s*([^,\n]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = linePat.exec(block)) !== null) {
      if (m[1] === "disable_features") continue;
      flags.push({ key: m[1], defaultValue: m[2].trim().slice(0, 60) });
    }

    // disable_features sub-keys
    const dfMatch = block.match(/disable_features\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (dfMatch) {
      const dfPat = /(\w+)\s*:\s*([^,\n]+)/g;
      while ((m = dfPat.exec(dfMatch[1])) !== null) {
        flags.push({
          key: `disable_features.${m[1]}`,
          defaultValue: m[2].trim(),
          nested: true,
          gates: "CUB cloud feature",
        });
      }
    }
  }

  // IPTV mode overrides
  if (content.includes("lampa_settings.iptv")) {
    flags.push({
      key: "iptv (side effects)",
      defaultValue: "when true",
      gates: "Disables socket, plugins_store, plugins_use, account_sync, torrents_use",
    });
  }

  return flags;
}

// ── Platform packaging ───────────────────────────────────────────────────────

export interface PlatformTarget {
  gulpTask: string;
  outputDir: string;
  indexShell: string;
  description: string;
}

export function extractPlatformTargets(repoPath: string): PlatformTarget[] {
  const gulpFile = path.join(repoPath, "gulpfile.js");
  const content = readFileSafe(gulpFile) ?? "";

  const targets: PlatformTarget[] = [
    {
      gulpTask: "default / npm start",
      outputDir: "build/web/",
      indexShell: "index/github/index.html",
      description: "Dev watch + Browser-Sync on port 3000",
    },
    {
      gulpTask: "pack_webos",
      outputDir: "build/webos/",
      indexShell: "index/webos/index.html",
      description: "LG webOS TV package",
    },
    {
      gulpTask: "pack_tizen",
      outputDir: "build/tizen/",
      indexShell: "index/tizen/index.html",
      description: "Samsung Tizen TV package",
    },
    {
      gulpTask: "pack_github",
      outputDir: "build/github/lampa/",
      indexShell: "index/github/index.html",
      description: "GitHub Pages / CDN production bundle + assembly.json",
    },
    {
      gulpTask: "pack_plugins",
      outputDir: "plugins/*/ (rebuilt)",
      indexShell: "—",
      description: "Rebuild plugin bundles only",
    },
    {
      gulpTask: "doc",
      outputDir: "build/doc/",
      indexShell: "index/doc/index.html",
      description: "JSDoc @doc tag scanner → index.html + data.json",
    },
  ];

  // Verify gulp exports exist
  return targets.filter((t) => {
    if (t.gulpTask.startsWith("default")) return content.includes("exports.default");
    const task = t.gulpTask.split(" ")[0];
    return content.includes(`exports.${task}`);
  });
}

// ── ContentRows extension points ─────────────────────────────────────────────

export interface ContentRowRegistration {
  name: string;
  title: string | null;
  screen: string[];
  file: string;
  line: number;
}

export function extractContentRows(repoPath: string): ContentRowRegistration[] {
  const jsFiles = listFilesRecursive(repoPath, [".js"]);
  const rows: ContentRowRegistration[] = [];

  for (const file of jsFiles) {
    const content = readFileSafe(file);
    if (!content || !content.includes("ContentRows.add")) continue;
    const rel = path.relative(repoPath, file);
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("ContentRows.add")) continue;

      // Grab multi-line object starting at this line
      const chunk = lines.slice(i, i + 12).join("\n");
      const nameMatch = chunk.match(/name:\s*['"]([^'"]+)['"]/);
      const titleMatch = chunk.match(
        /title:\s*(?:Lang\.translate\(['"]([^'"]+)['"]\)|['"]([^'"]+)['"])/
      );
      const screenMatch = chunk.match(/screen:\s*\[([^\]]+)\]/);

      rows.push({
        name: nameMatch?.[1] ?? "unknown",
        title: titleMatch?.[1] ?? titleMatch?.[2] ?? null,
        screen: screenMatch
          ? screenMatch[1]
              .split(",")
              .map((s) => s.replace(/['"\s]/g, ""))
              .filter(Boolean)
          : [],
        file: rel,
        line: i + 1,
      });
    }
  }

  return rows;
}

// ── Favorite categories ──────────────────────────────────────────────────────

export interface FavoriteCategoryInfo {
  categories: string[];
  marks: string[];
  file: string;
}

export function extractFavoriteCategories(repoPath: string): FavoriteCategoryInfo | null {
  const favFile = path.join(repoPath, "src", "core", "favorite.js");
  const content = readFileSafe(favFile);
  if (!content) return null;

  const catMatch = content.match(/category\s*=\s*\[([^\]]+)\]/);
  const marksMatch = content.match(/marks\s*=\s*\[([^\]]+)\]/);

  const parse = (raw: string) =>
    raw
      .split(",")
      .map((s) => s.replace(/['"\s]/g, ""))
      .filter(Boolean);

  return {
    categories: catMatch ? parse(catMatch[1]) : [],
    marks: marksMatch ? parse(marksMatch[1]) : [],
    file: "src/core/favorite.js",
  };
}

// ── Manifest mirrors ───────────────────────────────────────────────────────────

export function extractManifestMirrors(repoPath: string): Record<string, string> {
  const manifestFile = path.join(repoPath, "src", "core", "manifest.js");
  const content = readFileSafe(manifestFile) ?? "";

  const extract = (prop: string): string => {
    const re = new RegExp(
      `${prop}['"]\\s*,\\s*\\{[\\s\\S]*?get:\\s*\\(\\)\\s*=>\\s*\\[([^\\]]+)\\]`
    );
    const m = content.match(re);
    if (!m) return "—";
    return m[1]
      .split(",")
      .map((s) => s.replace(/['"\s]/g, ""))
      .filter(Boolean)
      .join(", ");
  };

  return {
    cub_mirrors: extract("cub_mirrors"),
    soc_mirrors: extract("soc_mirrors"),
    old_mirrors: extract("old_mirrors"),
    cub_domain: "localStorage cub_domain or first cub_mirror",
    cub_site: content.match(/cub_site:\s*['"]([^'"]+)['"]/)?.[1] ?? "—",
    app_version: content.match(/app_version:\s*['"]([^'"]+)['"]/)?.[1] ?? "—",
    github_lampa: "window.lampa_settings.fix_widget ? lampa.mx : yumata.github.io/lampa",
  };
}

// ── Deprecated API checker ───────────────────────────────────────────────────

export const DEPRECATED_APIS: Array<{ pattern: RegExp; name: string; replacement: string }> = [
  {
    pattern: /Lampa\.Card\b/,
    name: "Lampa.Card",
    replacement: "Lampa.Maker.make('Card', data, moduleFn)",
  },
  {
    pattern: /Lampa\.InteractionMain\b/,
    name: "Lampa.InteractionMain",
    replacement: "Lampa.Maker.make('Main', data, moduleFn)",
  },
  {
    pattern: /Lampa\.InteractionCategory\b/,
    name: "Lampa.InteractionCategory",
    replacement: "Lampa.Maker.make('Category', data, moduleFn)",
  },
  {
    pattern: /Lampa\.InteractionLine\b/,
    name: "Lampa.InteractionLine",
    replacement: "Lampa.Maker.make('Line', data, moduleFn)",
  },
  {
    pattern: /new\s+Lampa\.InteractionMain\b/,
    name: "new Lampa.InteractionMain",
    replacement: "Lampa.Maker.make('Main', ...)",
  },
];

export function checkDeprecatedApis(
  repoPath: string,
  targetFile: string
): Array<{ api: string; line: number; text: string; replacement: string }> {
  const abs = path.join(repoPath, targetFile);
  const content = readFileSafe(abs);
  if (!content) return [];

  const lines = content.split("\n");
  const hits: Array<{ api: string; line: number; text: string; replacement: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    for (const dep of DEPRECATED_APIS) {
      if (dep.pattern.test(lines[i])) {
        hits.push({
          api: dep.name,
          line: i + 1,
          text: lines[i].trim().slice(0, 120),
          replacement: dep.replacement,
        });
      }
    }
  }

  return hits;
}

// ── Lang keys used in code but missing from en.js ───────────────────────────

export function findMissingLangKeys(repoPath: string): {
  missing: string[];
  enKeyCount: number;
  langDir: string;
} {
  const srcLang = path.join(repoPath, "src", "lang", "en.js");
  const pubLang = path.join(repoPath, "public", "lang", "en.js");
  const enFile = fileExists(srcLang) ? srcLang : pubLang;
  const langDir = fileExists(srcLang) ? "src/lang" : "public/lang";

  const enContent = readFileSafe(enFile) ?? "";
  const enKeys = new Set<string>();
  const keyPat = /['"]([a-z][a-z0-9_]{1,60})['"]\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyPat.exec(enContent)) !== null) {
    enKeys.add(m[1]);
  }

  const usedKeys = new Set<string>();
  const usagePat = /Lang\.translate\(\s*['"]([a-z][a-z0-9_]+)['"]/g;
  const srcFiles = listFilesRecursive(path.join(repoPath, "src"), [".js"]);
  const pluginFiles = fileExists(path.join(repoPath, "plugins"))
    ? listFilesRecursive(path.join(repoPath, "plugins"), [".js"])
    : [];

  for (const file of [...srcFiles, ...pluginFiles]) {
    const content = readFileSafe(file) ?? "";
    while ((m = usagePat.exec(content)) !== null) {
      usedKeys.add(m[1]);
    }
  }

  const missing = [...usedKeys].filter((k) => !enKeys.has(k)).sort();
  return { missing, enKeyCount: enKeys.size, langDir };
}
