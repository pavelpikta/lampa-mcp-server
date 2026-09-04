import { describe, it, expect } from "vitest";
import { EXTERNAL_API_PROVIDERS } from "./external_api.js";

// Guards against ever pasting a real credential from pavelpikta-api-inventory.md
// into this static catalog — see AGENTS/plan notes: never surface secret values.
const SECRET_PATTERNS = [
  /8da1c9beda9545174264dc9f63a77d/, // Alloha Bearer
  /85d30ae5-d875-4c5f-900d-8e37bb20625e/, // KP unofficial API key
  /CT4BCQB-5A54XG5-HJZR6E9-27EBP91/, // PoiskKino API key
  /8m45c3jagb96ilczx0ky8uk9i/, // MDBList API key
  /cgg3gtifu46urtfp2zp1nqtba0k2ezxh/, // KinoPub client_secret
  /fe341561106d4a1caf9e7676b3a9ec24/, // Jellyfin API key
];

describe("EXTERNAL_API_PROVIDERS", () => {
  const serialized = JSON.stringify(EXTERNAL_API_PROVIDERS);

  it("never contains a known real credential value", () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.test(serialized)).toBe(false);
    }
  });

  it("every provider has a non-empty id, auth type, and description", () => {
    for (const p of EXTERNAL_API_PROVIDERS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.authType.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it("has unique provider ids", () => {
    const ids = EXTERNAL_API_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
