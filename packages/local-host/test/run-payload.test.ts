import { describe, expect, it } from "vitest";

import {
  canonicalRunPayloadJson,
  canonicalizeRunPayload,
  hashCanonicalRunPayload,
} from "../src/run-payload.ts";

const workspace = {
  canonicalPath: "/tmp/pragma-workspace",
  identityHash: `sha256:${"b".repeat(64)}`,
} as const;

describe("canonical run payload", () => {
  it("sorts object keys, normalizes prompts, and excludes presentation choices", () => {
    const first = canonicalizeRunPayload({
      command: "expert.run",
      executor: { kind: "expert", id: "0123456789abcdef" },
      workspace,
      prompt: "  hello\r\nworld  ",
      input: { z: 1, a: { d: true, c: false } },
    });
    const second = canonicalizeRunPayload({
      command: "expert.run",
      executor: { id: "0123456789abcdef", kind: "expert" },
      workspace,
      prompt: "hello\nworld",
      input: { a: { c: false, d: true }, z: 1 },
    });

    expect(first).toEqual(second);
    expect(canonicalRunPayloadJson({
      command: "expert.run",
      executor: { kind: "expert", id: "0123456789abcdef" },
      workspace,
      prompt: "hello",
    })).toBe(
      '{"command":"expert.run","executor":{"id":"0123456789abcdef","kind":"expert"},"prompt":"hello","workspace":{"canonicalPath":"/tmp/pragma-workspace","identityHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}',
    );
  });

  it("emits a sha256 payload hash fixture", () => {
    expect(
      hashCanonicalRunPayload({
        command: "expert.run",
        executor: { kind: "expert", id: "0123456789abcdef" },
        workspace,
        prompt: "hello",
      }),
    ).toBe("sha256:b418f47bad5a8ec3554d86c757d95a61f4b01e5e7ba91ade0f097a1f8008a434");
  });
});
