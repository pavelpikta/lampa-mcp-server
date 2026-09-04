import { describe, it, expect } from "vitest";
import { joinRepo, basename, dirname, normalizeRel } from "./paths.js";

describe("joinRepo", () => {
  it("joins and normalizes plain segments", () => {
    expect(joinRepo("src", "core", "lang.js")).toBe("src/core/lang.js");
  });

  it("drops empty and '.' segments", () => {
    expect(joinRepo("src", ".", "", "core")).toBe("src/core");
  });

  it("resolves internal '..' that stays within bounds", () => {
    expect(joinRepo("src/core", "..", "lang")).toBe("src/lang");
  });

  it("rejects '..' that escapes the repository root", () => {
    expect(() => joinRepo("..", "etc", "passwd")).toThrow(/escapes repository root/);
  });

  it("rejects '..' that escapes after consuming all segments", () => {
    expect(() => joinRepo("src", "..", "..")).toThrow(/escapes repository root/);
  });
});

describe("normalizeRel", () => {
  it("normalizes root markers to empty string", () => {
    expect(normalizeRel(undefined)).toBe("");
    expect(normalizeRel(".")).toBe("");
    expect(normalizeRel("/")).toBe("");
  });

  it("normalizes a real path via joinRepo", () => {
    expect(normalizeRel("src/core")).toBe("src/core");
  });

  it("still rejects traversal", () => {
    expect(() => normalizeRel("../secret")).toThrow(/escapes repository root/);
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("src/core/lang.js")).toBe("lang.js");
  });

  it("strips a trailing extension when given", () => {
    expect(basename("src/core/lang.js", ".js")).toBe("lang");
  });

  it("ignores trailing slashes", () => {
    expect(basename("plugins/iptv/")).toBe("iptv");
  });
});

describe("dirname", () => {
  it("returns the parent directory", () => {
    expect(dirname("src/core/lang.js")).toBe("src/core");
  });

  it("returns empty string for root-level entries", () => {
    expect(dirname("package.json")).toBe("");
  });
});
