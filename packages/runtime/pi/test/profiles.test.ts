import { describe, expect, it } from "vitest";

import {
  defaultPiCompatibilityProfileId,
  listPiCompatibilityProfiles,
  resolvePiCompatibilityProfile,
} from "../src/profiles.ts";

describe("PI compatibility profiles", () => {
  it("publishes unique versioned IDs", () => {
    const profiles = listPiCompatibilityProfiles();
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(profiles.length);
    for (const profile of profiles) expect(profile.id).toMatch(/^pi\.[a-z0-9.-]+@v[1-9]\d*$/);
  });

  it("chooses provider-specific profiles and a conservative compatible fallback", () => {
    expect(defaultPiCompatibilityProfileId("qwen", "openai-completions")).toBe("pi.qwen@v1");
    expect(defaultPiCompatibilityProfileId("unknown", "openai-completions")).toBe(
      "pi.openai-compatible-safe@v1",
    );
    expect(defaultPiCompatibilityProfileId("custom-openai", "openai-responses")).toBe(
      "pi.openai-responses-safe@v1",
    );
  });

  it("rejects unknown profiles and protocol mismatches", () => {
    expect(() => resolvePiCompatibilityProfile("pi.missing@v1", "openai-completions")).toThrow(
      "Unknown PI compatibility profile",
    );
    expect(() => resolvePiCompatibilityProfile("pi.openai-modern@v1", "openai-responses")).toThrow(
      "does not support API",
    );
  });
});
