/**
 * Join and normalize repo-relative posix paths.
 * Rejects `..` that would escape the repository root.
 */
export function joinRepo(...parts: string[]): string {
  const segments: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    const cleaned = part.replace(/\\/g, "/");
    for (const seg of cleaned.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (segments.length === 0) {
          throw new Error(`Path escapes repository root: ${parts.join("/")}`);
        }
        segments.pop();
        continue;
      }
      segments.push(seg);
    }
  }

  return segments.join("/");
}

/** Last path segment; optionally strip a trailing extension (e.g. ".js"). */
export function basename(relPath: string, ext?: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  let base = i === -1 ? norm : norm.slice(i + 1);
  if (ext && base.endsWith(ext)) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

/** Parent directory as a repo-relative posix path, or "" for root-level entries. */
export function dirname(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return "";
  return norm.slice(0, i);
}

/** Normalize "" / "." to empty string (repo root). */
export function normalizeRel(relPath?: string): string {
  if (!relPath || relPath === "." || relPath === "/") return "";
  return joinRepo(relPath);
}
