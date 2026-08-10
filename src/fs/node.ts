import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DirEntry, RepoFs } from "./types.js";
import { joinRepo, normalizeRel } from "./paths.js";

const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "build"];

/**
 * Local filesystem RepoFs. `root` is an absolute path to the repository.
 * Public API uses repo-relative posix paths only.
 */
export class NodeRepoFs implements RepoFs {
  constructor(private readonly root: string) {}

  private toAbs(relPath?: string): string {
    const rel = normalizeRel(relPath);
    const abs = rel ? path.join(this.root, ...rel.split("/")) : this.root;
    const resolvedRoot = path.resolve(this.root);
    const resolvedAbs = path.resolve(abs);
    if (resolvedAbs !== resolvedRoot && !resolvedAbs.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Path escapes repository root: ${relPath}`);
    }
    return resolvedAbs;
  }

  async exists(relPath?: string): Promise<boolean> {
    try {
      await access(this.toAbs(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      return await readFile(this.toAbs(relPath), "utf8");
    } catch {
      return null;
    }
  }

  async listDir(relPath?: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(this.toAbs(relPath), { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? ("dir" as const) : ("file" as const),
        }));
    } catch {
      return [];
    }
  }

  async listFiles(options?: {
    prefix?: string;
    exts?: string[];
    ignore?: string[];
  }): Promise<string[]> {
    const prefix = normalizeRel(options?.prefix);
    const exts = options?.exts ?? [];
    const ignore = options?.ignore ?? DEFAULT_IGNORE;
    const results: string[] = [];

    const walk = async (relDir: string): Promise<void> => {
      const entries = await this.listDir(relDir || undefined);
      for (const entry of entries) {
        if (ignore.includes(entry.name)) continue;
        const child = relDir ? joinRepo(relDir, entry.name) : entry.name;
        if (entry.type === "dir") {
          await walk(child);
        } else if (exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
          results.push(child);
        }
      }
    };

    if (!(await this.exists(prefix || undefined))) return results;
    try {
      const st = await stat(this.toAbs(prefix || undefined));
      if (st.isFile()) {
        const name = prefix.split("/").pop() ?? prefix;
        if (exts.length === 0 || exts.some((e) => name.endsWith(e))) {
          return [prefix];
        }
        return [];
      }
    } catch {
      return results;
    }

    await walk(prefix);
    return results;
  }

  async readIndex<T = unknown>(name: string): Promise<T | null> {
    const candidates = [
      path.join(this.root, "indexes", `${name}.json`),
      path.join(this.root, "..", "indexes", `${name}.json`),
    ];
    for (const abs of candidates) {
      try {
        const text = await readFile(abs, "utf8");
        return JSON.parse(text) as T;
      } catch {
        // try next
      }
    }
    return null;
  }
}
