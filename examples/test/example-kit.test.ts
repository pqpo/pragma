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
      defaultModelName: "openai/gpt-example",
      providers: [
        {
          provider: "openai",
          modelNames: ["gpt-example"],
          baseApi: "https://api.example.com/v1",
          api: "openai-responses",
          key: "test-key",
        },
      ],
    });
  });

  it("fails early when required model configuration is missing", () => {
    expect(() => createExampleModelsConfig({})).toThrow("PRAGMA_MODEL_PROVIDER");
  });

  it("rejects an unsupported model API", () => {
    expect(() =>
      createExampleModelsConfig({
        PRAGMA_MODEL_PROVIDER: "openai",
        PRAGMA_MODEL_NAME: "gpt-example",
        PRAGMA_MODEL_BASE_API: "https://api.example.com/v1",
        PRAGMA_MODEL_API: "unsupported",
        PRAGMA_MODEL_API_KEY: "test-key",
      }),
    ).toThrow("Unsupported PRAGMA_MODEL_API");
  });
});
