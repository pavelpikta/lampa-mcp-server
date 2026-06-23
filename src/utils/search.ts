import { execSync } from "node:child_process";
import path from "node:path";
import { listFilesRecursive, readFileSafe } from "./fs.js";

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

function hasRipgrep(): boolean {
  try {
    execSync("rg --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function searchCode(
  repoPath: string,
  query: string,
  globs: string[] = [],
  isRegex = false
): SearchMatch[] {
  if (hasRipgrep()) {
    return searchWithRipgrep(repoPath, query, globs, isRegex);
  }
  return searchWithNode(repoPath, query, globs, isRegex);
}

function searchWithRipgrep(
  repoPath: string,
  query: string,
  globs: string[],
  isRegex: boolean
): SearchMatch[] {
  try {
    const globArgs = globs.map((g) => `-g "${g}"`).join(" ");
    const regexFlag = isRegex ? "" : "--fixed-strings";
    const cmd = `rg ${regexFlag} --line-number --no-heading --max-count 5 ${globArgs} "${query.replace(/"/g, '\\"')}" "${repoPath}"`;
    const output = execSync(cmd, { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
    return output
      .split("\n")
      .filter(Boolean)
      .slice(0, 100)
      .map((line) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) return null;
        return {
          file: path.relative(repoPath, match[1]),
          line: parseInt(match[2], 10),
          text: match[3].trim(),
        };
      })
      .filter((m): m is SearchMatch => m !== null);
  } catch {
    return [];
  }
}

function searchWithNode(
  repoPath: string,
  query: string,
  globs: string[],
  isRegex: boolean
): SearchMatch[] {
  const exts =
    globs.length > 0
      ? globs.map((g) => g.replace(/^\*/, ""))
      : [".js", ".ts", ".css", ".scss", ".html", ".json"];

  const files = listFilesRecursive(repoPath, exts);
  const results: SearchMatch[] = [];
  const pattern = isRegex ? new RegExp(query) : null;

  for (const file of files) {
    if (results.length >= 100) break;
    const content = readFileSafe(file);
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matched = pattern ? pattern.test(line) : line.includes(query);
      if (matched) {
        results.push({
          file: path.relative(repoPath, file),
          line: i + 1,
          text: line.trim().slice(0, 200),
        });
        if (results.length >= 100) break;
      }
    }
  }
  return results;
}

export function getImports(filePath: string, repoPath: string): string[] {
  const content = readFileSafe(filePath);
  if (!content) return [];

  const importPattern = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = importPattern.exec(content)) !== null) {
    const imp = m[1];
    if (imp.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filePath), imp);
      matches.push(path.relative(repoPath, resolved));
    } else {
      matches.push(imp);
    }
  }
  return [...new Set(matches)];
}
