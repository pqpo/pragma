import { describe, expect, it } from "vitest";

import {
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
  desktopModelProviderBindingRef,
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
  parseDesktopModelProviderBindingRef,
} from "./desktop-binding-ref.ts";

describe("Desktop binding refs", () => {
  it("round-trips IDs containing dots and punctuation without ambiguous splitting", () => {
    const id = "enterprise.knowledge/base@east";
    expect(parseDesktopCapabilityBindingRef(desktopCapabilityBindingRef(id, 12))).toEqual({
      id,
      revision: 12,
    });
    expect(parseDesktopContextBindingRef(desktopContextBindingRef(id))).toBe(id);
    expect(parseDesktopModelProviderBindingRef(desktopModelProviderBindingRef(id))).toBe(id);
  });

  it("rejects malformed base64url segments", () => {
    expect(parseDesktopContextBindingRef("binding:desktop-context.a")).toBeUndefined();
    expect(
      parseDesktopCapabilityBindingRef("binding:desktop-capability.invalid.1.2"),
    ).toBeUndefined();
  });
});
