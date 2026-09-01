import { describe, expect, it } from "vitest";

import { executeSourceCommand } from "../src/commands/source.ts";
import type { CliCommandContext } from "../src/commands/types.ts";
import { parseCliArgv } from "../src/parser/argv.ts";

describe("Bundle Source CLI parser", () => {
  it("parses Source initialization", () => {
    expect(
      parseCliArgv(["source", "init", "./source", "--id", "official", "--name", "Official"])
        .command,
    ).toEqual({
      kind: "source-init",
      directory: "./source",
      id: "official",
      name: "Official",
    });
  });

  it("parses interactive Bundle addition without publishing options", () => {
    expect(
      parseCliArgv(["source", "add", "./review.pragma", "--directory", "./source"]).command,
    ).toEqual({
      kind: "source-add",
      directory: "./source",
      bundlePath: "./review.pragma",
    });
  });

  it("does not expose the generated Registry workflow", () => {
    expect(() => parseCliArgv(["registry", "build", "."])).toThrow(/unknown command/iu);
    expect(() => parseCliArgv(["source", "publish", "bundle.pragma"])).toThrow(
      /requires init or add/u,
    );
  });

  it("requires a controlling terminal for the guided add flow", async () => {
    await expect(
      executeSourceCommand({ kind: "source-add", directory: ".", bundlePath: "bundle.pragma" }, {
        interactive: "never",
        terminal: { isControllingTerminal: () => false, readLine: async () => "" },
      } as CliCommandContext),
    ).rejects.toThrow(/interactive controlling terminal/u);
  });
});
