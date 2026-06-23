import path from "node:path";
import fs from "node:fs";
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
export function extractLampaApiUsage(
  dirOrFile: string,
  repoPath: string
): Record<string, string[]> {
  const files = getJsFiles(dirOrFile);
  const usage: Record<string, string[]> = {};

  for (const file of files) {
    const content = readFileSafe(file);
    if (!content) continue;
    const relFile = path.relative(repoPath, file);
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
export function extractEvents(dirOrFile: string, repoPath: string): EventUsage {
  const files = getJsFiles(dirOrFile);
  const follows: Record<string, string[]> = {};
  const sends: Record<string, string[]> = {};

  for (const file of files) {
    const content = readFileSafe(file);
    if (!content) continue;
    const relFile = path.relative(repoPath, file);

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
export function parseLangFile(filePath: string): string[] {
  const content = readFileSafe(filePath);
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
export function extractProviderInfo(filePath: string): ProviderInfo {
  const content = readFileSafe(filePath) ?? "";
  const name = path.basename(filePath, ".js");

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
    path: filePath,
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
export function analyseComponentFile(filePath: string, repoPath: string): LifecycleSummary {
  const content = readFileSafe(filePath) ?? "";
  const lines = content.split("\n");
  const relFile = path.relative(repoPath, filePath);

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

  const events = extractEvents(filePath, repoPath);

  const lampaUsage = extractLampaApiUsage(filePath, repoPath);
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
    file: relFile,
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

// ── Internal helpers ──────────────────────────────────────────────────────

function getJsFiles(dirOrFile: string): string[] {
  try {
    const stat = fs.statSync(dirOrFile);
    return stat.isDirectory() ? listFilesRecursive(dirOrFile, [".js"]) : [dirOrFile];
  } catch {
    return [];
  }
}
