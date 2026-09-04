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

// Kept small on purpose: results must stay well within one MCP tool-call response.
const MAX_HITS = 100;
const MAX_HITS_PER_FILE = 5;
const PREVIEW_LEN = 200;
// Bounds regex backtracking cost on pathological user patterns (ReDoS mitigation).
const MAX_REGEX_TEST_LEN = 5000;

/**
 * Pure-JS code search over RepoFs. Returns up to MAX_HITS matches.
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
    if (results.length >= MAX_HITS) break;
    const content = await fs.readFile(file);
    if (!content) continue;
    const lines = content.split("\n");
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= MAX_HITS || perFile >= MAX_HITS_PER_FILE) break;
      const line = lines[i];
      const testLine = line.length > MAX_REGEX_TEST_LEN ? line.slice(0, MAX_REGEX_TEST_LEN) : line;
      const matched = pattern ? pattern.test(testLine) : line.includes(query);
      if (matched) {
        results.push({
          file,
          line: i + 1,
          text: line.trim().slice(0, PREVIEW_LEN),
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
