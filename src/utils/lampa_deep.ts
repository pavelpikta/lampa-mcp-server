import type { RepoFs } from "../fs/types.js";
import { basename } from "../fs/paths.js";
import { listFilesRecursive, readFileSafe } from "./fs.js";

// ── Type definitions ───────────────────────────────────────────────────────

export interface EventUsage {
  follows: Record<string, string[]>; // eventName -> files that listen
  sends: Record<string, string[]>; // eventName -> files that emit
}

export interface ProviderInfo {
  name: string;
  baseUrl: string | null;
  methods: string[];
  lampaApis: string[];
  path: string;
}

// ── Lampa API extraction ───────────────────────────────────────────────────

/**
 * Extract all unique Lampa.Module top-level names used in JS files under a path.
 * Returns a map of module name -> list of relative file paths that use it.
 */
export async function extractLampaApiUsage(
  fs: RepoFs,
  dirOrFile: string
): Promise<Record<string, string[]>> {
  const files = await getJsFiles(fs, dirOrFile);
  const usage: Record<string, string[]> = {};

  for (const relFile of files) {
    const content = await readFileSafe(fs, relFile);
    if (!content) continue;
    const pattern = /Lampa\.([A-Z][a-zA-Z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const mod = m[1];
      if (!usage[mod]) usage[mod] = [];
      if (!usage[mod].includes(relFile)) usage[mod].push(relFile);
    }
  }
  return usage;
}

/**
 * Extract Lampa.Listener.follow and Lampa.Listener.send calls in JS files under a path.
 */
export async function extractEvents(fs: RepoFs, dirOrFile: string): Promise<EventUsage> {
  const files = await getJsFiles(fs, dirOrFile);
  const follows: Record<string, string[]> = {};
  const sends: Record<string, string[]> = {};

  for (const relFile of files) {
    const content = await readFileSafe(fs, relFile);
    if (!content) continue;

    const followPat = /Lampa\.Listener\.follow\(['"]([^'"]+)['"]/g;
    const sendPat = /Lampa\.Listener\.send\(['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;

    while ((m = followPat.exec(content)) !== null) {
      const evt = m[1];
      if (!follows[evt]) follows[evt] = [];
      if (!follows[evt].includes(relFile)) follows[evt].push(relFile);
    }
    while ((m = sendPat.exec(content)) !== null) {
      const evt = m[1];
      if (!sends[evt]) sends[evt] = [];
      if (!sends[evt].includes(relFile)) sends[evt].push(relFile);
    }
  }

  return { follows, sends };
}

// ── Language file parsing ──────────────────────────────────────────────────

/**
 * Parse a Lampa lang file and return all translation keys found.
 * Handles both `export default { key: 'value' }` (src/lang) and
 * `Lampa.lang('code', { key: 'value' })` (public/lang) formats.
 */
export async function parseLangFile(fs: RepoFs, relPath: string): Promise<string[]> {
  const content = await readFileSafe(fs, relPath);
  if (!content) return [];
  // Match keys like: 'some_key': or "some_key":
  const pattern = /['"]([a-z][a-z0-9_]{1,60})['"]\s*:/g;
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    keys.push(m[1]);
  }
  return [...new Set(keys)];
}

// ── Provider analysis ─────────────────────────────────────────────────────

/**
 * Extract metadata from a streaming provider JS file (plugins/online/*.js).
 */
export async function extractProviderInfo(fs: RepoFs, relPath: string): Promise<ProviderInfo> {
  const content = (await readFileSafe(fs, relPath)) ?? "";
  const name = basename(relPath, ".js");

  // Base URL (let/var/const embed = '...')
  const urlMatch = content.match(/(?:let|var|const)\s+embed\s*=\s*['"]([^'"]+)['"]/);
  const baseUrl = urlMatch ? urlMatch[1] : null;

  // Public methods: this.something = function
  const methodPat = /this\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*function/g;
  const methods: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = methodPat.exec(content)) !== null) {
    methods.push(m[1]);
  }

  // Lampa API modules used
  const lampaSet = new Set<string>();
  const lmpPat = /Lampa\.([A-Z][a-zA-Z]+)/g;
  while ((m = lmpPat.exec(content)) !== null) {
    lampaSet.add(m[1]);
  }

  return {
    name,
    baseUrl,
    methods: [...new Set(methods)],
    lampaApis: [...lampaSet],
    path: relPath,
  };
}

// ── Component lifecycle analysis ──────────────────────────────────────────

export interface LifecycleSummary {
  file: string;
  lineCount: number;
  methods: Record<string, number[]>;
  events: EventUsage;
  lampaApis: string[];
  storageReads: Array<{ line: number; text: string }>;
  storageWrites: Array<{ line: number; text: string }>;
  templateUsages: Array<{ line: number; text: string }>;
  settingsUsages: Array<{ line: number; text: string }>;
  preview: string;
}

/**
 * Analyse a single component JS file's lifecycle in depth.
 */
export async function analyseComponentFile(fs: RepoFs, relPath: string): Promise<LifecycleSummary> {
  const content = (await readFileSafe(fs, relPath)) ?? "";
  const lines = content.split("\n");

  // Lifecycle method patterns
  const methodPatterns: Record<string, RegExp> = {
    "create/init": /(?:this\.create|this\.init|function\s+\w+)\s*[=(]/,
    render: /this\.render\s*=/,
    start: /this\.start\s*=/,
    stop: /this\.stop\s*=/,
    pause: /this\.pause\s*=/,
    resume: /this\.resume\s*=/,
    destroy: /this\.destroy\s*=/,
    back: /this\.back\s*=/,
    show: /this\.show\s*=/,
    hide: /this\.hide\s*=/,
  };

  const methods: Record<string, number[]> = {};
  for (const [name, pat] of Object.entries(methodPatterns)) {
    methods[name] = [];
    for (let i = 0; i < lines.length; i++) {
      if (pat.test(lines[i])) methods[name].push(i + 1);
    }
  }

  const events = await extractEvents(fs, relPath);

  const lampaUsage = await extractLampaApiUsage(fs, relPath);
  const lampaApis = Object.keys(lampaUsage);

  // Extract specific usages inline (search the lines array directly)
  const storageReads: Array<{ line: number; text: string }> = [];
  const storageWrites: Array<{ line: number; text: string }> = [];
  const templateUsages: Array<{ line: number; text: string }> = [];
  const settingsUsages: Array<{ line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes("Lampa.Storage.get")) storageReads.push({ line: i + 1, text: l.trim() });
    if (l.includes("Lampa.Storage.set")) storageWrites.push({ line: i + 1, text: l.trim() });
    if (l.includes("Lampa.Template")) templateUsages.push({ line: i + 1, text: l.trim() });
    if (l.includes("Lampa.Settings") || l.includes("Lampa.SettingsApi")) {
      settingsUsages.push({ line: i + 1, text: l.trim() });
    }
  }

  return {
    file: relPath,
    lineCount: lines.length,
    methods,
    events,
    lampaApis,
    storageReads: storageReads.slice(0, 15),
    storageWrites: storageWrites.slice(0, 15),
    templateUsages: templateUsages.slice(0, 15),
    settingsUsages: settingsUsages.slice(0, 15),
    preview: lines.slice(0, 35).join("\n"),
  };
}

// ── i18n helpers ───────────────────────────────────────────────────────────

export async function resolveLangDir(fs: RepoFs): Promise<string | null> {
  if (await fs.exists("src/lang")) return "src/lang";
  if (await fs.exists("public/lang")) return "public/lang";
  return null;
}

export async function formatI18nKeys(fs: RepoFs, key?: string): Promise<string> {
  const langDir = await resolveLangDir(fs);
  if (!langDir) {
    return "No lang directory found (checked src/lang/ and public/lang/).";
  }

  const langFiles = (await listFilesRecursive(fs, langDir, [".js"])).filter(
    (f) => !f.endsWith("meta.js")
  );

  if (key) {
    const results: string[] = [];
    for (const lf of langFiles) {
      const content = await readFileSafe(fs, lf);
      if (!content) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(key)) {
          results.push(`${basename(lf)}:${i + 1}  ${lines[i].trim()}`);
        }
      }
    }

    const usages: string[] = [];
    const jsFiles = await listFilesRecursive(fs, "", [".js"]);
    for (const file of jsFiles) {
      if (usages.length >= 10) break;
      const content = await readFileSafe(fs, file);
      if (!content) continue;
      if (
        !content.includes(`Lang.translate('${key}'`) &&
        !content.includes(`Lang.translate("${key}"`)
      ) {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && usages.length < 10; i++) {
        const line = lines[i];
        if (line.includes(`Lang.translate('${key}'`) || line.includes(`Lang.translate("${key}"`)) {
          usages.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      }
    }

    return [
      results.length > 0 ? results.join("\n") : `Key "${key}" not found in lang files.`,
      usages.length > 0 ? `\n## Usages\n${usages.join("\n")}` : "",
    ].join("\n");
  }

  const keys = await parseLangFile(fs, `${langDir}/en.js`);
  const langFilenames = langFiles.map((f) => basename(f));
  return `Language directory: ${langDir}/\nFiles: ${langFilenames.join(", ")}\n\nKeys in en.js (${keys.length}):\n${keys.join(", ")}`;
}

export async function formatI18nCoverage(fs: RepoFs, showMissing = true): Promise<string> {
  const langDir = await resolveLangDir(fs);
  if (!langDir) {
    return "No language directory found (checked src/lang/ and public/lang/).";
  }

  const langFiles = (await fs.listDir(langDir))
    .filter((e) => e.type === "file" && e.name.endsWith(".js") && e.name !== "meta.js")
    .map((e) => e.name)
    .sort();

  const enFile = `${langDir}/en.js`;
  if (!(await fs.exists(enFile))) {
    return `Reference file en.js not found in ${langDir}.`;
  }

  const enKeys = await parseLangFile(fs, enFile);
  const enCount = enKeys.length;

  const rows: string[] = [
    `# Translation Coverage`,
    `**Directory:** ${langDir}`,
    `**Reference:** en.js (${enCount} keys)`,
    ``,
    `| Lang | File | Keys | Coverage | Missing |`,
    `|------|------|------|----------|---------|`,
  ];

  const details: string[] = [];

  for (const file of langFiles) {
    const langPath = `${langDir}/${file}`;
    const keys = await parseLangFile(fs, langPath);
    const missingKeys = enKeys.filter((k) => !keys.includes(k));
    const extraKeys = keys.filter((k) => !enKeys.includes(k));
    const covered = enCount - missingKeys.length;
    const pct = enCount > 0 ? Math.round((covered / enCount) * 100) : 0;
    const icon = pct === 100 ? "✅" : pct >= 90 ? "🟡" : "🔴";
    const lang = file.replace(".js", "");

    rows.push(`| ${lang} | ${file} | ${keys.length} | ${icon} ${pct}% | ${missingKeys.length} |`);

    if (showMissing) {
      if (missingKeys.length > 0) {
        details.push(
          `\n### ${lang} — ${missingKeys.length} missing key(s)`,
          missingKeys.join(", ")
        );
      }
      if (extraKeys.length > 0) {
        details.push(
          `### ${lang} — ${extraKeys.length} extra key(s) (not in en.js)`,
          extraKeys.join(", ")
        );
      }
    }
  }

  return [...rows, ...details].join("\n");
}

// ── Template helpers ───────────────────────────────────────────────────────

export type TemplateMode = "list" | "html" | "raw";

export async function formatTemplates(
  fs: RepoFs,
  mode: TemplateMode = "list",
  name?: string
): Promise<string> {
  const templatesDir = "src/templates";
  if (!(await fs.exists(templatesDir))) {
    return "src/templates/ directory not found in the repository.";
  }

  const allFiles = await listFilesRecursive(fs, templatesDir, [".js"]);

  if (mode === "list" && !name) {
    const grouped: Record<string, string[]> = {};
    for (const rel of allFiles) {
      const parts = rel.split("/");
      const group = parts.length > 2 ? parts[2] : "root";
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(rel);
    }

    const lines = Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, files]) => `### ${group}\n${files.map((f) => `- ${f}`).join("\n")}`)
      .join("\n\n");

    return `# Lampa UI Templates (${allFiles.length} files)\n\n${lines}\n\nUse \`name\` with mode=html or mode=raw to inspect a template.`;
  }

  if (!name) {
    return `mode=${mode} requires a \`name\` parameter.\nUse list_templates (mode=list) to see all available templates.`;
  }

  const lower = name.toLowerCase();
  const matches = allFiles.filter((f) => {
    const base = basename(f).toLowerCase();
    const stem = basename(f, ".js").toLowerCase();
    return stem === lower || base.includes(lower);
  });

  if (matches.length === 0) {
    return `No template matching "${name}" in src/templates/.\nUse list_templates (mode=list) to see all available templates.`;
  }

  if (mode === "raw" || (mode === "list" && name)) {
    const results: string[] = [];
    for (const file of matches.slice(0, 4)) {
      const content = (await readFileSafe(fs, file)) ?? "";
      const preview =
        content.length > 2500 ? content.slice(0, 2500) + "\n// …(truncated)" : content;
      results.push(`## ${file}\n\`\`\`javascript\n${preview}\n\`\`\``);
    }
    return results.join("\n\n");
  }

  // mode === "html"
  const results: string[] = [];
  for (const file of matches.slice(0, 4)) {
    const content = (await readFileSafe(fs, file)) ?? "";
    const tlMatch = content.match(/`([\s\S]+?)`/);
    const html = tlMatch ? tlMatch[1].trim() : content.trim();

    const classSet = new Set<string>();
    const classPat = /class="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = classPat.exec(html)) !== null) {
      m[1].split(/\s+/).forEach((c) => classSet.add(c));
    }

    const bindingSet = new Set<string>();
    const bindPat = /\{([a-z_][a-z0-9_]*)\}/g;
    while ((m = bindPat.exec(html)) !== null) {
      bindingSet.add(`{${m[1]}}`);
    }

    const dataSet = new Set<string>();
    const dataPat = /data-([a-z][a-z0-9-]*)/g;
    while ((m = dataPat.exec(html)) !== null) {
      dataSet.add(`data-${m[1]}`);
    }

    const meta: string[] = [];
    if (classSet.size > 0)
      meta.push(`**CSS classes (${classSet.size}):** \`${[...classSet].join("`, `")}\``);
    if (bindingSet.size > 0) meta.push(`**Data bindings:** \`${[...bindingSet].join("`, `")}\``);
    if (dataSet.size > 0) meta.push(`**Data attributes:** \`${[...dataSet].join("`, `")}\``);

    results.push(
      [
        `## ${file}`,
        meta.join("\n"),
        ``,
        `\`\`\`html`,
        html.slice(0, 3000),
        html.length > 3000 ? `\n<!-- …truncated -->` : "",
        "```",
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
  }

  return results.join("\n\n");
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function getJsFiles(fs: RepoFs, dirOrFile: string): Promise<string[]> {
  const asFile = await fs.readFile(dirOrFile);
  if (asFile !== null) return [dirOrFile];
  if (await fs.exists(dirOrFile)) {
    return listFilesRecursive(fs, dirOrFile, [".js"]);
  }
  return [];
}
