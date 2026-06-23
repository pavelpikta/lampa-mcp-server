import fs from "node:fs";
import path from "node:path";

export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function listFilesRecursive(
  dir: string,
  exts: string[] = [],
  ignore: string[] = ["node_modules", ".git", "dist", "build"]
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, exts, ignore));
    } else if (exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

export function readSegment(filePath: string, startLine: number, endLine: number): string {
  const content = readFileSafe(filePath);
  if (!content) return "";
  const lines = content.split("\n");
  return lines
    .slice(Math.max(0, startLine - 1), endLine)
    .map((l, i) => `${startLine + i}: ${l}`)
    .join("\n");
}
