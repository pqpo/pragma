import { describe, expect, it } from "vitest";

import { parseCliArgv } from "../src/parser/argv.ts";

describe("Registry CLI parser", () => {
  it("parses repository and package initialization", () => {
    expect(
      parseCliArgv(["registry", "init", "./registry", "--id", "official", "--name", "Official"])
        .command,
    ).toEqual({
      kind: "registry-init",
      directory: "./registry",
      id: "official",
      name: "Official",
    });
    expect(
      parseCliArgv([
        "registry",
        "package",
        "init",
        "review-assistant",
        "--category",
        "development/coding",
        "--directory",
        "./registry",
      ]).command,
    ).toMatchObject({
      kind: "registry-package-init",
      packageId: "review-assistant",
      categoryId: "development/coding",
    });
  });

  it("parses publishing and local PR preparation without forge-specific options", () => {
    expect(
      parseCliArgv([
        "registry",
        "publish",
        "./review.pragma",
        "--package",
        "review-assistant",
        "--version",
        "1.2.0",
        "--channel",
        "stable",
        "--prepare-pr",
      ]).command,
    ).toEqual({
      kind: "registry-publish",
      directory: ".",
      packageId: "review-assistant",
      version: "1.2.0",
      bundlePath: "./review.pragma",
      channel: "stable",
      preparePr: true,
    });
  });
});
