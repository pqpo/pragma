import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createInitialRuntimePrompt,
  normalizeOutputRetryLimit,
  parseRuntimeOutput,
  tryParseJsonLike,
} from "../../src/runtime/output.ts";

describe("runtime output helpers", () => {
  it("parses structured output from fenced JSON and surrounding prose", () => {
    const result = parseRuntimeOutput(
      'Here is the result:\n```json\n{"summary":"done","confidence":0.9}\n```',
      z.object({
        summary: z.string(),
        confidence: z.number(),
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        summary: "done",
        confidence: 0.9,
      },
    });
  });

  it("extracts the first balanced JSON value without being confused by strings", () => {
    expect(tryParseJsonLike('prefix {"text":"}","ok":true} suffix')).toEqual({
      ok: true,
      value: {
        text: "}",
        ok: true,
      },
    });
  });

  it("normalizes invalid retry limits to the default", () => {
    expect(normalizeOutputRetryLimit(undefined, 2)).toBe(2);
    expect(normalizeOutputRetryLimit(Number.NaN, 2)).toBe(2);
    expect(normalizeOutputRetryLimit(-1, 2)).toBe(2);
    expect(normalizeOutputRetryLimit(1.8, 2)).toBe(1);
  });

  it("adds JSON-only instructions only for structured output", () => {
    expect(createInitialRuntimePrompt("hello", undefined)).toBe("hello");
    expect(createInitialRuntimePrompt("hello", z.object({ ok: z.boolean() }))).toContain(
      "valid JSON only",
    );
  });
});
