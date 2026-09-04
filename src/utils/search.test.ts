import { describe, it, expect } from "vitest";
import type { RepoFs } from "../fs/types.js";
import { searchCode } from "./search.js";

function fakeFs(files: Record<string, string>): RepoFs {
  return {
    exists: async (relPath) => (relPath ? relPath in files : true),
    readFile: async (relPath) => files[relPath] ?? null,
    listDir: async () => [],
    listFiles: async (options) => {
      const exts = options?.exts ?? [];
      const prefix = options?.prefix ?? "";
      return Object.keys(files).filter(
        (f) =>
          (!prefix || f === prefix || f.startsWith(`${prefix}/`)) &&
          (exts.length === 0 || exts.some((e) => f.endsWith(e)))
      );
    },
  };
}

describe("searchCode", () => {
  it("finds literal case-sensitive matches", async () => {
    const fs = fakeFs({ "src/a.js": "const Lampa = 1;\nconst other = 2;" });
    const hits = await searchCode(fs, "Lampa", [], false);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "src/a.js", line: 1 });
  });

  it("is case-sensitive by default", async () => {
    const fs = fakeFs({ "src/a.js": "lampa lowercase only" });
    const hits = await searchCode(fs, "Lampa", [], false);
    expect(hits).toHaveLength(0);
  });

  it("supports regex without an implicit case-insensitive flag", async () => {
    const fs = fakeFs({ "src/a.js": "FOO\nfoo\nFoo" });
    const hits = await searchCode(fs, "^foo$", [], true);
    expect(hits).toHaveLength(1);
  });

  it("throws on invalid regex so callers can report a clear error", async () => {
    const fs = fakeFs({ "src/a.js": "anything" });
    await expect(searchCode(fs, "(", [], true)).rejects.toThrow();
  });

  it("caps hits per file at 5", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `match ${i}`).join("\n");
    const fs = fakeFs({ "src/a.js": content });
    const hits = await searchCode(fs, "match", [], false);
    expect(hits).toHaveLength(5);
  });

  it("caps total hits at 100 across many files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`src/f${i}.js`] = "match\nmatch\nmatch\nmatch\nmatch";
    const fs = fakeFs(files);
    const hits = await searchCode(fs, "match", [], false);
    expect(hits).toHaveLength(100);
  });

  it("does not hang or crash on a very long line with a backtracking-prone regex", async () => {
    const longLine = "a".repeat(20000) + "!";
    const fs = fakeFs({ "src/a.js": longLine });
    const hits = await searchCode(fs, "(a+)+$", [], true);
    expect(Array.isArray(hits)).toBe(true);
  });

  it("returns an empty array when nothing matches", async () => {
    const fs = fakeFs({ "src/a.js": "nothing relevant here" });
    expect(await searchCode(fs, "Lampa", [], false)).toEqual([]);
  });
});
