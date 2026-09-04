import { describe, it, expect } from "vitest";
import { parseJsonSafe } from "./fs.js";

describe("parseJsonSafe", () => {
  it("parses valid JSON", () => {
    expect(parseJsonSafe<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseJsonSafe("{not json")).toBeNull();
  });

  it("returns null for empty or missing input", () => {
    expect(parseJsonSafe(null)).toBeNull();
    expect(parseJsonSafe(undefined)).toBeNull();
    expect(parseJsonSafe("")).toBeNull();
  });
});
