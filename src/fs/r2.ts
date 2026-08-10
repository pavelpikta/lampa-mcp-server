import type { DirEntry, RepoFs } from "./types.js";
import { normalizeRel } from "./paths.js";

export interface R2Manifest {
  files: string[];
  commit?: string;
  generatedAt?: string;
  /** When true, file bodies live in bundle.json instead of files/ keys */
  bundled?: boolean;
}

export type R2Bundle = Record<string, string>;

const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "build"];

/**
 * R2-backed RepoFs.
 *
 * Preferred layout (fast upload):
 * - `{prefix}manifest.json` — file list + `{ bundled: true }`
 * - `{prefix}bundle.json` — `{ [relPath]: fileContents }`
 * - `{prefix}indexes/<name>.json` — optional indexes
 *
 * Legacy layout still supported:
 * - `{prefix}files/<relPath>` — individual file bodies
 *
 * Manifest/bundle/file contents are cached per instance (request lifetime).
 */
export class R2RepoFs implements RepoFs {
  private readonly cache = new Map<string, string | null>();
  private manifest: R2Manifest | null = null;
  private bundle: R2Bundle | null = null;
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    prefix = "lampa/"
  ) {
    this.prefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  }

  private filesKey(relPath: string): string {
    const rel = normalizeRel(relPath);
    return `${this.prefix}files/${rel}`;
  }

  private async loadManifest(): Promise<R2Manifest> {
    if (this.manifest) return this.manifest;

    const cacheKey = "__manifest__";
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.manifest = cached ? (JSON.parse(cached) as R2Manifest) : { files: [] };
      return this.manifest;
    }

    const obj = await this.bucket.get(`${this.prefix}manifest.json`);
    if (!obj) {
      this.cache.set(cacheKey, null);
      this.manifest = { files: [] };
      return this.manifest;
    }

    const text = await obj.text();
    this.cache.set(cacheKey, text);
    this.manifest = JSON.parse(text) as R2Manifest;
    return this.manifest;
  }

  private async loadBundle(): Promise<R2Bundle | null> {
    if (this.bundle) return this.bundle;
    const manifest = await this.loadManifest();
    if (!manifest.bundled) return null;

    const cacheKey = "__bundle__";
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.bundle = cached ? (JSON.parse(cached) as R2Bundle) : {};
      return this.bundle;
    }

    const obj = await this.bucket.get(`${this.prefix}bundle.json`);
    if (!obj) {
      this.cache.set(cacheKey, null);
      this.bundle = {};
      return this.bundle;
    }

    const text = await obj.text();
    this.cache.set(cacheKey, text);
    this.bundle = JSON.parse(text) as R2Bundle;
    return this.bundle;
  }

  private isIgnored(relPath: string, ignore: string[]): boolean {
    const parts = relPath.split("/");
    return parts.some((p) => ignore.includes(p));
  }

  async exists(relPath?: string): Promise<boolean> {
    const rel = normalizeRel(relPath);
    if (!rel) return true;

    const manifest = await this.loadManifest();
    if (manifest.files.includes(rel)) return true;
    const dirPrefix = `${rel}/`;
    return manifest.files.some((f) => f.startsWith(dirPrefix));
  }

  async readFile(relPath: string): Promise<string | null> {
    const rel = normalizeRel(relPath);
    if (!rel) return null;

    if (this.cache.has(rel)) {
      return this.cache.get(rel) ?? null;
    }

    const bundle = await this.loadBundle();
    if (bundle) {
      const text = bundle[rel] ?? null;
      this.cache.set(rel, text);
      return text;
    }

    const obj = await this.bucket.get(this.filesKey(rel));
    if (!obj) {
      this.cache.set(rel, null);
      return null;
    }

    const text = await obj.text();
    this.cache.set(rel, text);
    return text;
  }

  async listDir(relPath?: string): Promise<DirEntry[]> {
    const rel = normalizeRel(relPath);
    const manifest = await this.loadManifest();
    const prefix = rel ? `${rel}/` : "";
    const dirs = new Set<string>();
    const files = new Set<string>();

    for (const file of manifest.files) {
      if (rel && file !== rel && !file.startsWith(prefix)) continue;
      if (!rel && !file.includes("/")) {
        files.add(file);
        continue;
      }
      const rest = rel ? file.slice(prefix.length) : file;
      if (!rest || file === rel) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.add(rest);
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }

    return [
      ...[...dirs].sort().map((name) => ({ name, type: "dir" as const })),
      ...[...files].sort().map((name) => ({ name, type: "file" as const })),
    ];
  }

  async listFiles(options?: {
    prefix?: string;
    exts?: string[];
    ignore?: string[];
  }): Promise<string[]> {
    const prefix = normalizeRel(options?.prefix);
    const exts = options?.exts ?? [];
    const ignore = options?.ignore ?? DEFAULT_IGNORE;
    const manifest = await this.loadManifest();
    const dirPrefix = prefix ? `${prefix}/` : "";

    return manifest.files.filter((f) => {
      if (this.isIgnored(f, ignore)) return false;
      if (prefix) {
        if (f !== prefix && !f.startsWith(dirPrefix)) return false;
      }
      if (exts.length > 0 && !exts.some((e) => f.endsWith(e))) return false;
      return true;
    });
  }

  async readIndex<T = unknown>(name: string): Promise<T | null> {
    const key = `${this.prefix}indexes/${name}.json`;
    const cacheKey = `__index__:${name}`;

    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      return cached ? (JSON.parse(cached) as T) : null;
    }

    const obj = await this.bucket.get(key);
    if (!obj) {
      this.cache.set(cacheKey, null);
      return null;
    }

    const text = await obj.text();
    this.cache.set(cacheKey, text);
    return JSON.parse(text) as T;
  }
}
