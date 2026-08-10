import type { RepoFs } from "../fs/types.js";

export async function readFileSafe(fs: RepoFs, relPath: string): Promise<string | null> {
  return fs.readFile(relPath);
}

export async function fileExists(fs: RepoFs, relPath?: string): Promise<boolean> {
  return fs.exists(relPath);
}

export async function listFilesRecursive(
  fs: RepoFs,
  prefix = "",
  exts: string[] = [],
  ignore: string[] = ["node_modules", ".git", "dist", "build"]
): Promise<string[]> {
  return fs.listFiles({ prefix: prefix || undefined, exts, ignore });
}

export async function readSegment(
  fs: RepoFs,
  relPath: string,
  startLine: number,
  endLine: number
): Promise<string> {
  const content = await readFileSafe(fs, relPath);
  if (!content) return "";
  const lines = content.split("\n");
  return lines
    .slice(Math.max(0, startLine - 1), endLine)
    .map((l, i) => `${startLine + i}: ${l}`)
    .join("\n");
}
