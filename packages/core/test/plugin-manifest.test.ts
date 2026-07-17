import { describe, expect, it } from "vitest";

import { ExpertAgentPluginManifestSchema, resolveExpertAgentPluginConfig } from "../src/index.ts";

const manifestInput = {
  schemaVersion: "pragma.plugin/v2" as const,
  id: "example",
  name: "Example",
  description: "Example plugin",
  version: "1.0.0",
  tags: [],
  runtime: {
    type: "expert-agent-plugin" as const,
    entry: "./index.mjs",
    trust: "trusted-host" as const,
  },
  capabilities: [],
  configuration: {
    type: "object",
    properties: {
      feature: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
        },
        additionalProperties: false,
      },
      token: { type: "string", minLength: 1, "x-pragma-secret": true },
    },
    required: ["token"],
    additionalProperties: false,
  },
  permissions: { filesystem: [], shell: [], network: [], environment: [] },
};

describe("Expert plugin manifest v2", () => {
  it("merges nested JSON Schema defaults and explicit user configuration", () => {
    const manifest = ExpertAgentPluginManifestSchema.parse(manifestInput);
    expect(
      resolveExpertAgentPluginConfig(manifest, [
        { feature: { enabled: false } },
        { token: "secret" },
      ]),
    ).toEqual({ feature: { enabled: false }, token: "secret" });
  });

  it("rejects unknown configuration and missing required values", () => {
    const manifest = ExpertAgentPluginManifestSchema.parse(manifestInput);
    expect(() =>
      resolveExpertAgentPluginConfig(manifest, [{ token: "secret", typo: true }]),
    ).toThrow("config is invalid");
    expect(() => resolveExpertAgentPluginConfig(manifest, [])).toThrow("config is invalid");
  });

  it("rejects escaping entries, secret defaults, and implicit trust", () => {
    expect(
      ExpertAgentPluginManifestSchema.safeParse({
        ...manifestInput,
        runtime: { ...manifestInput.runtime, entry: "../outside.mjs" },
      }).success,
    ).toBe(false);
    expect(
      ExpertAgentPluginManifestSchema.safeParse({
        ...manifestInput,
        configuration: {
          ...manifestInput.configuration,
          properties: {
            ...manifestInput.configuration.properties,
            token: {
              ...manifestInput.configuration.properties.token,
              default: "plaintext",
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ExpertAgentPluginManifestSchema.safeParse({
        ...manifestInput,
        runtime: { type: "expert-agent-plugin", entry: "./index.mjs" },
      }).success,
    ).toBe(false);
    expect(
      ExpertAgentPluginManifestSchema.safeParse({
        ...manifestInput,
        configuration: { ...manifestInput.configuration, requred: ["token"] },
      }).success,
    ).toBe(false);
  });
});
