import type { RepoFs } from "../fs/types.js";
import { dirname, joinRepo } from "../fs/paths.js";

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

function globToExts(globs: string[]): string[] {
  if (globs.length === 0) {
    return [".js", ".ts", ".css", ".scss", ".html", ".json"];
  }
  return globs.map((g) => g.replace(/^\*/, ""));
}

/**
 * Pure-JS code search over RepoFs. Returns up to 100 matches.
 * `file` in results is always a repo-relative posix path.
 * Optional `prefix` scopes the walk (e.g. "src", "plugins").
 */
export async function searchCode(
  fs: RepoFs,
  query: string,
  globs: string[] = [],
  isRegex = false,
  prefix?: string
): Promise<SearchMatch[]> {
  const exts = globToExts(globs);
  const files = await fs.listFiles({ exts, prefix: prefix || undefined });
  const results: SearchMatch[] = [];
  const pattern = isRegex ? new RegExp(query) : null;

  for (const file of files) {
    if (results.length >= 100) break;
    const content = await fs.readFile(file);
    if (!content) continue;
    const lines = content.split("\n");
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= 100 || perFile >= 5) break;
      const line = lines[i];
      const matched = pattern ? pattern.test(line) : line.includes(query);
      if (matched) {
        results.push({
          file,
          line: i + 1,
          text: line.trim().slice(0, 200),
        });
        perFile++;
      }
    }
  }
  return results;
}

export async function getImports(fs: RepoFs, relPath: string): Promise<string[]> {
  const content = await fs.readFile(relPath);
  if (!content) return [];

  const importPattern = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = importPattern.exec(content)) !== null) {
    const imp = m[1];
    if (imp.startsWith(".")) {
      try {
        matches.push(joinRepo(dirname(relPath), imp));
      } catch {
        matches.push(imp);
      }
    } else {
      matches.push(imp);
    }
  }
  return [...new Set(matches)];
}
