import { describe, it, expect } from "vitest";
import { resolveEditPath } from "./lampa.js";

describe("resolveEditPath", () => {
  it("returns default authoritative/avoid paths for a known kind without a name", () => {
    const result = resolveEditPath("lang");
    expect(result.authoritative).toContain("src/lang/");
    expect(result.avoid).toContain("public/lang/");
  });

  it("scopes to a specific name when given", () => {
    const result = resolveEditPath("plugin", "tracks");
    expect(result.authoritative).toEqual(["plugins/tracks/", "plugins/tracks/tracks.js"]);
  });

  it("never fails for an unrecognized name — falls back to the kind's defaults", () => {
    const result = resolveEditPath("lang", "does-not-exist-as-a-real-locale");
    expect(result.authoritative[0]).toBe("src/lang/does-not-exist-as-a-real-locale.js");
    expect(result.notes).toBeTruthy();
  });

  it("always flags public/ and build/ as generated copies to avoid", () => {
    for (const kind of ["lang", "sass", "template", "component", "plugin", "core"] as const) {
      const result = resolveEditPath(kind);
      expect(result.avoid.some((p) => p.startsWith("public/") || p.startsWith("build/"))).toBe(
        true
      );
    }
  });
});
