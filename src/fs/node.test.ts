import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeRepoFs } from "./node.js";

describe("NodeRepoFs", () => {
  let root: string;
  let fs: NodeRepoFs;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lampa-mcp-test-"));
    await mkdir(path.join(root, "src", "core"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(path.join(root, "src", "core", "lang.js"), "// lang module\n");
    fs = new NodeRepoFs(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads an existing file", async () => {
    expect(await fs.readFile("src/core/lang.js")).toContain("lang module");
  });

  it("returns null for a missing file instead of throwing", async () => {
    expect(await fs.readFile("does/not/exist.js")).toBeNull();
  });

  it("reports exists() correctly for files, dirs, and root", async () => {
    expect(await fs.exists()).toBe(true);
    expect(await fs.exists("src/core")).toBe(true);
    expect(await fs.exists("src/core/lang.js")).toBe(true);
    expect(await fs.exists("nope")).toBe(false);
  });

  it("lists directory entries with type tags", async () => {
    const entries = await fs.listDir("src");
    expect(entries).toEqual([{ name: "core", type: "dir" }]);
  });

  it("rejects path traversal escaping the repo root on read", async () => {
    await expect(fs.readFile("../../etc/passwd")).resolves.toBeNull();
  });

  it("rejects path traversal escaping the repo root on exists", async () => {
    expect(await fs.exists("../outside")).toBe(false);
  });

  it("lists files recursively filtered by extension", async () => {
    const files = await fs.listFiles({ exts: [".js"] });
    expect(files).toContain("src/core/lang.js");
  });
});
