import { describe, expect, it } from "vitest";

import {
  createExpertPromptInput,
  formatExpertPromptWithAttachments,
  readExpertPromptInput,
} from "../src/execution/expert-prompt.ts";

const attachments = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "image" as const,
    name: "screen.png",
    path: "/work/screen.png",
    mimeType: "image/png",
    size: 42,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    kind: "file" as const,
    name: "requirements.md",
    path: "/work/requirements.md",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    kind: "directory" as const,
    name: "fixtures",
    path: "/work/fixtures",
  },
];

describe("expert prompt attachments", () => {
  it("formats stable model-visible path sections without embedding file content", () => {
    expect(formatExpertPromptWithAttachments("Review these inputs.", attachments)).toBe(
      [
        "# Images mentioned by the user:\n## screen.png: /work/screen.png",
        "# Files mentioned by the user:\n## requirements.md: /work/requirements.md",
        "# Directories mentioned by the user:\n## fixtures: /work/fixtures",
        "# My request\nReview these inputs.",
      ].join("\n\n"),
    );
  });

  it("round-trips structured invocation input and keeps legacy string input readable", () => {
    const input = createExpertPromptInput("Review these inputs.", attachments);
    expect(readExpertPromptInput(input, "fallback")).toEqual(input);
    expect(readExpertPromptInput("legacy prompt", "legacy prompt")).toEqual({
      text: "legacy prompt",
      attachments: [],
    });
    expect(() =>
      readExpertPromptInput({ text: "broken", attachments: "invalid" }, "fallback"),
    ).toThrow("Expert prompt input is invalid");
  });
});
