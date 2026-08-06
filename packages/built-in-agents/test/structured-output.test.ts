import { describe, expect, it } from "vitest";

import { extractStructuredJson } from "../src/structured-output.ts";

describe("extractStructuredJson", () => {
  it("keeps bare JSON unchanged", () => {
    expect(extractStructuredJson('  {"status":"ok"}\n')).toBe('{"status":"ok"}');
  });

  it("extracts fenced JSON after explanatory text", () => {
    expect(extractStructuredJson('Here is the result:\n```json\n{"status":"ok"}\n```\nDone.')).toBe(
      '{"status":"ok"}',
    );
  });

  it("extracts an inline structured span from surrounding text", () => {
    expect(extractStructuredJson('Result: [{"status":"ok"}] Thanks.')).toBe('[{"status":"ok"}]');
  });
});
