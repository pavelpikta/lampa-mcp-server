import path from "node:path";
import type { RepoFs } from "./fs/types.js";
import { NodeRepoFs } from "./fs/node.js";

export interface Config {
  fs: RepoFs;
  label: string; // display path e.g. "r2://lampa-source" or local path
  docsPath: string; // generated JSDoc, relative "build/doc"
  pluginDocsPath: string; // official plugin guide, relative "docs"
}

export function getConfig(): Config {
  const repoPath = process.env.LAMPA_REPO_PATH
    ? path.resolve(process.env.LAMPA_REPO_PATH)
    : path.resolve(process.cwd(), "temp/lampa-source");

  return {
    fs: new NodeRepoFs(repoPath),
    label: repoPath,
    docsPath: "build/doc",
    pluginDocsPath: "docs",
  };
}
