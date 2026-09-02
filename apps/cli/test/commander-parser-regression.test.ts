import { describe, expect, it } from "vitest";

import { parseCliArgv } from "../src/parser/argv.js";

describe("Commander parser compatibility", () => {
  it("rejects duplicate single-value options", () => {
    expect(() =>
      parseCliArgv(["expert", "discover", "--limit", "1", "--limit", "2"]),
    ).toThrow("Option --limit may only be specified once.");
  });

  it("continues to collect repeatable choices", () => {
    const parsed = parseCliArgv([
      "mission",
      "respond",
      "0123456789abcdef",
      "--interaction",
      "interaction-1",
      "--choice",
      "first",
      "--choice=second",
    ]);

    expect(parsed.command).toMatchObject({ choices: ["first", "second"] });
  });
});
