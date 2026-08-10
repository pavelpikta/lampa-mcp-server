export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface RepoFs {
  /** Check if a repo-relative path exists (file or dir). "" or "." means repo root. */
  exists(relPath?: string): Promise<boolean>;
  /** Read file as utf8; null if missing */
  readFile(relPath: string): Promise<string | null>;
  /** List direct children of a directory */
  listDir(relPath?: string): Promise<DirEntry[]>;
  /** Recursively list files as repo-relative posix paths */
  listFiles(options?: {
    prefix?: string;
    exts?: string[];
    ignore?: string[];
  }): Promise<string[]>;
  /** Optional precomputed index JSON under indexes/ */
  readIndex?<T = unknown>(name: string): Promise<T | null>;
}
