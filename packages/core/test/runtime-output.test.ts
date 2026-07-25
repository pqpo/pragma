import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createInitialRuntimePrompt,
  parseRuntimeOutput,
} from "../src/runtime/output.ts";

describe("Runtime structured output", () => {
  const schema = z.object({ score: z.number(), summary: z.string() }).strict();

  it("includes the concrete JSON Schema in the initial prompt", () => {
    const prompt = createInitialRuntimePrompt("Review the change.", schema);
    expect(prompt).toContain("JSON Schema:");
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"summary"');
  });

  it("parses and validates structured output", () => {
    expect(parseRuntimeOutput('{"score":9,"summary":"ready"}', schema)).toEqual({
      ok: true,
      value: { score: 9, summary: "ready" },
    });
    expect(parseRuntimeOutput('{"score":"nine","summary":"ready"}', schema)).toMatchObject({
      ok: false,
    });
  });
});
