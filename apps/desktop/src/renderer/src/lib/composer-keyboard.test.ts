import { describe, expect, it } from "vitest";

import { shouldSubmitComposerOnEnter } from "./composer-keyboard.ts";

describe("shouldSubmitComposerOnEnter", () => {
  it("submits a regular unmodified Enter key", () => {
    expect(
      shouldSubmitComposerOnEnter({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(true);
  });

  it("does not submit when Enter confirms an IME composition", () => {
    expect(
      shouldSubmitComposerOnEnter({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        keyCode: 13,
      }),
    ).toBe(false);
  });

  it("honors Chromium's keyCode 229 IME fallback", () => {
    expect(
      shouldSubmitComposerOnEnter({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 229,
      }),
    ).toBe(false);
  });

  it("keeps Shift+Enter and non-Enter keys available for editing", () => {
    expect(
      shouldSubmitComposerOnEnter({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        keyCode: 13,
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerOnEnter({
        key: "ArrowDown",
        shiftKey: false,
        isComposing: false,
        keyCode: 40,
      }),
    ).toBe(false);
  });
});
