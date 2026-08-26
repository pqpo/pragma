import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createBoundedStdinReader,
  MAX_RUN_INPUT_BYTES,
  readBoundedJson,
  readBoundedUtf8,
} from "../src/input.ts";

describe("CLI bounded input", () => {
  it("reads injected stdin incrementally and stops at the byte limit", async () => {
    const source = Readable.from([
      Buffer.alloc(MAX_RUN_INPUT_BYTES - 1, "a"),
      Buffer.from("too-large"),
      Buffer.from("must-not-be-read"),
    ]);
    const destroy = vi.spyOn(source, "destroy");

    await expect(createBoundedStdinReader(source)()).rejects.toMatchObject({ reason: "too_large" });
    expect(destroy).toHaveBeenCalled();
  });

  it("keeps the test reader injection while applying the same limit", async () => {
    await expect(
      readBoundedUtf8("-", async () => new Uint8Array(MAX_RUN_INPUT_BYTES + 1)),
    ).rejects.toMatchObject({ reason: "too_large" });
    await expect(
      readBoundedJson("-", async () => new TextEncoder().encode('{"value":1}')),
    ).resolves.toEqual({ value: 1 });
  });
});
