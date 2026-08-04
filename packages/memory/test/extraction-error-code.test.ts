import { z } from "zod";
import { describe, expect, it } from "vitest";

import { extractionErrorCode } from "../src/pipeline/extraction-error-code.ts";

describe("extractionErrorCode", () => {
  it("turns structured validation failures into a stable diagnostic code", () => {
    const validation = z.object({ value: z.string() }).safeParse({ value: 1 });
    if (validation.success) throw new Error("Expected the fixture to fail validation.");

    expect(extractionErrorCode(validation.error, "episodic_extraction")).toBe(
      "episodic_extraction_validation_failed",
    );
  });

  it("keeps an explicit stable error prefix and rejects serialized error text", () => {
    expect(
      extractionErrorCode(
        new Error("memory_curator_failed:runtime unavailable"),
        "episodic_extraction",
      ),
    ).toBe("memory_curator_failed");
    expect(extractionErrorCode(new Error('[{"origin":"string"}]'), "semantic_extraction")).toBe(
      "semantic_extraction_failed",
    );
  });

  it("normalizes external error codes to the documented lowercase format", () => {
    expect(
      extractionErrorCode(
        Object.assign(new Error("Invalid API key"), { code: " API_KEY_INVALID " }),
        "semantic_extraction",
      ),
    ).toBe("api_key_invalid");
  });
});
