import { describe, expect, it } from "vitest";

import {
  createRunRedactor,
  resolveLateBoundSecrets,
  type SecretStore,
} from "../src/index.ts";

describe("Local Host run redaction", () => {
  it("redacts registered values and structured secret fields recursively", () => {
    const redactor = createRunRedactor();
    redactor.registerSecret("super-secret-value");

    expect(
      redactor.redactJson({
        message: "request included super-secret-value",
        credentials: { apiKey: "also-hidden" },
        nested: ["super-secret-value"],
      }),
    ).toEqual({
      message: "request included [REDACTED]",
      credentials: "[REDACTED]",
      nested: ["[REDACTED]"],
    });
  });

  it("late-binds values and disposes every handle on completion", async () => {
    const disposed: string[] = [];
    const store: SecretStore = {
      inspect: async () => ({ status: "ready", backend: "unsupported" }),
      get: async (ref) => ({
        bytes: () => new TextEncoder().encode(ref.secretId),
        utf8: () => `value-${ref.secretId}`,
        dispose: () => disposed.push(ref.secretId),
      }),
      put: async () => {
        throw new Error("not used");
      },
      delete: async () => undefined,
      listMetadata: async () => [],
    };
    const first = { secretId: "first", revision: "1" } as never;
    const second = { secretId: "second", revision: "1" } as never;

    const resolved = await resolveLateBoundSecrets(store, [
      { name: "FIRST", ref: first },
      { name: "SECOND", ref: second },
    ]);
    expect(resolved.values).toEqual({ FIRST: "value-first", SECOND: "value-second" });
    expect(resolved.redactor.redactText("value-first value-second")).toBe(
      "[REDACTED] [REDACTED]",
    );
    resolved.dispose();
    resolved.dispose();
    expect(disposed).toEqual(["first", "second"]);
  });
});
