import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  extractionErrorCode,
  extractionFailureDiagnostic,
} from "../src/pipeline/extraction-error-code.ts";

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

  it("preserves actionable Runtime diagnostics while redacting credentials", () => {
    const startedAt = new Date("2026-08-05T08:00:00.000Z");
    const error = Object.assign(new Error("429 rate limit exceeded token=secret-value"), {
      code: "rate_limit_exceeded",
      retryable: true,
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      endpoint: "https://user:pass@example.com/v1/responses?api_key=secret",
      statusCode: 429,
      requestId: "request-a",
      outputDiagnostic: {
        responseBytes: 9000,
        responseCharacters: 8500,
        parsePosition: 8514,
        closingBoundaryFound: false,
        finishReason: "length",
        truncated: true,
        usage: {
          measurement: "reported",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
        },
      },
    });

    const result = extractionFailureDiagnostic(error, "skill_extraction", {
      phase: "curator_run",
      startedAt,
      now: new Date("2026-08-05T08:00:30.000Z"),
    });

    expect(result.diagnostic).toMatchObject({
      code: "rate_limit_exceeded",
      message: "429 rate limit exceeded token=[REDACTED]",
      phase: "curator_run",
      durationMs: 30_000,
      retryable: true,
      runtime: {
        runtimeId: "runtime-a",
        providerId: "provider-a",
        modelId: "model-a",
        endpoint: "https://example.com/v1/responses",
      },
      transport: { httpStatus: 429, requestId: "request-a" },
      output: {
        responseBytes: 9000,
        responseCharacters: 8500,
        parsePosition: 8514,
        closingBoundaryFound: false,
        truncated: true,
      },
    });
    expect(result.stack).toContain("429 rate limit exceeded");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("user:pass");
  });
});
