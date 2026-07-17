import { describe, expect, it } from "vitest";

import { createExampleModelsConfig } from "../src/support/example-kit.ts";

describe("example model configuration", () => {
  it("maps documented environment variables to an Expert model configuration", () => {
    expect(
      createExampleModelsConfig({
        PRAGMA_MODEL_PROVIDER: "openai",
        PRAGMA_MODEL_NAME: "gpt-example",
        PRAGMA_MODEL_BASE_API: "https://api.example.com/v1",
        PRAGMA_MODEL_API: "openai-responses",
        PRAGMA_MODEL_API_KEY: "test-key",
      }),
    ).toEqual({
      default: { model: { providerId: "openai", modelId: "gpt-example" } },
    });
  });

  it("fails early when required model configuration is missing", () => {
    expect(() => createExampleModelsConfig({})).toThrow("PRAGMA_MODEL_PROVIDER");
  });

  it("fails early when the model ID is missing", () => {
    expect(() =>
      createExampleModelsConfig({
        PRAGMA_MODEL_PROVIDER: "openai",
      }),
    ).toThrow("PRAGMA_MODEL_NAME");
  });
});
