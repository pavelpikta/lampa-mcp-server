import path from "node:path";

export interface Config {
  repoPath: string;
  docsPath: string;
}

export function getConfig(): Config {
  const repoPath = process.env.LAMPA_REPO_PATH
    ? path.resolve(process.env.LAMPA_REPO_PATH)
    : path.resolve(process.cwd(), "temp/lampa-source");

  return {
    repoPath,
    docsPath: path.join(repoPath, "build", "doc"),
  };
}
