import { describe, expect, it } from "vitest";

import { createPiSessionBashTool } from "../src/adapter.ts";

describe("PI session Bash environment", () => {
  it("isolates concurrent Bash child environments without mutating the host", async () => {
    const hostValue = process.env["PI_SESSION_TOKEN"];
    const first = createPiSessionBashTool({
      cwd: process.cwd(),
      processEnvironment: { PI_SESSION_TOKEN: "token-a" },
    });
    const second = createPiSessionBashTool({
      cwd: process.cwd(),
      processEnvironment: { PI_SESSION_TOKEN: "token-b" },
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

function readText(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content
    .flatMap((content) => (content.type === "text" ? [content.text ?? ""] : []))
    .join("");
}
