import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createPiSessionBashTool } from "../src/adapter.ts";

describe("PI session Bash environment", () => {
  it("isolates concurrent Bash child environments without mutating the host", async () => {
    const hostValue = process.env["PI_SESSION_TOKEN"];
    const shellPath = resolveTestShellPath();
    const first = createPiSessionBashTool({
      cwd: process.cwd(),
      processEnvironment: { PI_SESSION_TOKEN: "token-a" },
      shellPath,
    });
    const second = createPiSessionBashTool({
      cwd: process.cwd(),
      processEnvironment: { PI_SESSION_TOKEN: "token-b" },
      shellPath,
    });

    const [firstResult, secondResult] = await Promise.all([
      first.execute(
        "first",
        { command: "printf '%s' \"$PI_SESSION_TOKEN\"" },
        undefined,
        undefined,
        undefined as never,
      ),
      second.execute(
        "second",
        { command: "printf '%s' \"$PI_SESSION_TOKEN\"" },
        undefined,
        undefined,
        undefined as never,
      ),
    ]);

    expect(readText(firstResult)).toBe("token-a");
    expect(readText(secondResult)).toBe("token-b");
    expect(process.env["PI_SESSION_TOKEN"]).toBe(hostValue);
  });
});

function resolveTestShellPath(): string {
  if (process.platform !== "win32") return process.env["SHELL"] ?? "/bin/bash";
  const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  return resolve(gitExecPath, "../../../bin/bash.exe");
}

function readText(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content
    .flatMap((content) => (content.type === "text" ? [content.text ?? ""] : []))
    .join("");
}
