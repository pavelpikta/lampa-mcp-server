#!/usr/bin/env node
/**
 * Upload a Lampa source snapshot (and optional indexes) to the R2 bucket.
 *
 * Writes a single bundle.json (fast) plus manifest + indexes.
 *
 * Usage:
 *   node scripts/upload-snapshot.mjs [--local] [--repo path] [--prefix lampa/] [--bucket lampa-mcp-source]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const local = args.includes("--local");
const repoArg = argValue("--repo");
const prefix = (argValue("--prefix") ?? "lampa/").replace(/\/?$/, "/");
const bucket = argValue("--bucket") ?? "lampa-mcp-source";
const repoPath = path.resolve(
  repoArg ?? process.env.LAMPA_REPO_PATH ?? path.join(root, "temp/lampa-source")
);

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".DS_Store"]);
const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".zip",
  ".gz",
  ".map",
]);

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(abs, base, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

function wranglerPut(key, filePath) {
  const finalArgs = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", filePath];
  if (local) finalArgs.push("--local");

  const result = spawnSync("npx", finalArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to upload ${key}: ${result.stderr || result.stdout || `exit ${result.status}`}`
    );
  }
}

function writeTemp(rel, content) {
  const abs = path.join(root, "temp", "snapshot-staging", rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function extractRegexIndex(files, pattern, mapFn) {
  const re = new RegExp(pattern, "g");
  const results = [];
  for (const rel of files) {
    if (!rel.endsWith(".js") && !rel.endsWith(".ts")) continue;
    const abs = path.join(repoPath, rel);
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      results.push(mapFn(rel, m, content));
      if (results.length > 8000) return results;
    }
  }
  return results;
}

console.log(`Scanning ${repoPath} ...`);
if (!existsSync(repoPath)) {
  console.error(`Repo not found: ${repoPath}`);
  console.error("Clone Lampa source into temp/lampa-source or pass --repo");
  process.exit(1);
}

const files = listFiles(repoPath).sort();
console.log(`Found ${files.length} text files`);

const bundle = {};
let totalBytes = 0;
for (const rel of files) {
  const abs = path.join(repoPath, rel);
  try {
    const text = readFileSync(abs, "utf8");
    bundle[rel] = text;
    totalBytes += Buffer.byteLength(text, "utf8");
  } catch {
    // skip unreadable
  }
}

const commitHint = (() => {
  const r = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
})();

const manifest = {
  files: Object.keys(bundle).sort(),
  commit: commitHint,
  generatedAt: new Date().toISOString(),
  fileCount: Object.keys(bundle).length,
  bundled: true,
  totalBytes,
};

const storageHits = extractRegexIndex(
  files,
  String.raw`Lampa\.Storage\.(get|set|cache)\(\s*['"]([^'"]+)['"]`,
  (rel, m) => ({ file: rel, op: m[1], key: m[2] })
);
const eventHits = [
  ...extractRegexIndex(
    files,
    String.raw`Lampa\.Listener\.(follow|send)\(\s*['"]([^'"]+)['"]`,
    (rel, m) => ({ file: rel, op: m[1], event: m[2], bus: "Listener" })
  ),
  ...extractRegexIndex(
    files,
    String.raw`Player\.listener\.(follow|send)\(\s*['"]([^'"]+)['"]`,
    (rel, m) => ({ file: rel, op: m[1], event: m[2], bus: "Player" })
  ),
];
const settingsHits = [
  ...extractRegexIndex(
    files,
    String.raw`Lampa\.Settings\.add\(\s*['"]([^'"]+)['"]`,
    (rel, m) => ({ file: rel, component: m[1], api: "Settings.add" })
  ),
  ...extractRegexIndex(
    files,
    String.raw`SettingsApi\.add(?:Component|Param)\(\s*['"]?([^'")\s]+)`,
    (rel, m) => ({ file: rel, component: m[1], api: "SettingsApi" })
  ),
];
const apiHits = extractRegexIndex(
  files,
  String.raw`(Lampa\.Api|Lampa\.Network|new Reguest|fetch\(|\$\.ajax)`,
  (rel, m, content) => {
    const line = content.slice(0, m.index).split("\n").length;
    const text = content.split("\n")[line - 1]?.trim().slice(0, 160) ?? m[0];
    return { file: rel, line, text, kind: m[1] };
  }
);

/** @type {Record<string, unknown>} */
const indexes = {
  "storage-schema": {
    generatedAt: manifest.generatedAt,
    hits: storageHits,
    note: "Precomputed Lampa.Storage get/set/cache key references",
  },
  events: {
    generatedAt: manifest.generatedAt,
    hits: eventHits,
    note: "Precomputed Listener/Player event follow/send references",
  },
  "settings-catalog": {
    generatedAt: manifest.generatedAt,
    hits: settingsHits,
    note: "Precomputed Settings.add / SettingsApi registrations",
  },
  "api-integrations": {
    generatedAt: manifest.generatedAt,
    hits: apiHits,
    note: "Precomputed API/network call patterns",
  },
};

try {
  const nodeFsUrl = pathToFileURL(path.join(root, "dist/fs/node.js")).href;
  const cubUrl = pathToFileURL(path.join(root, "dist/utils/cub.js")).href;
  const { NodeRepoFs } = await import(nodeFsUrl);
  const { extractLampaCubApi } = await import(cubUrl);
  const fs = new NodeRepoFs(repoPath);
  const endpoints = await extractLampaCubApi(fs);
  indexes["cub-api"] = endpoints;
  console.log(`  cub-api index: ${endpoints.length} endpoints`);
} catch (err) {
  console.warn(
    `  cub-api index skipped (run npm run build first for full index): ${err?.message ?? err}`
  );
}

console.log(
  `Uploading bundle (${(totalBytes / 1024 / 1024).toFixed(1)} MiB text) to ${bucket} (${local ? "local" : "remote"}) ...`
);

const stagingManifest = writeTemp("manifest.json", JSON.stringify(manifest, null, 2));
const stagingBundle = writeTemp("bundle.json", JSON.stringify(bundle));
wranglerPut(`${prefix}manifest.json`, stagingManifest);
wranglerPut(`${prefix}bundle.json`, stagingBundle);

for (const [name, data] of Object.entries(indexes)) {
  const p = writeTemp(`indexes/${name}.json`, JSON.stringify(data, null, 2));
  wranglerPut(`${prefix}indexes/${name}.json`, p);
  const hits = data && typeof data === "object" && "hits" in data ? data.hits.length : Array.isArray(data) ? data.length : "?";
  console.log(`  index ${name}: ${hits}`);
}

const digest = createHash("sha256")
  .update(JSON.stringify(manifest.files))
  .digest("hex")
  .slice(0, 12);
console.log(
  `Done. Uploaded ${manifest.fileCount} files via bundle. digest=${digest} commit=${commitHint ?? "n/a"}`
);
console.log(`R2 keys under prefix: ${prefix}`);
