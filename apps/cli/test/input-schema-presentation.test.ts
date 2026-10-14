import { expect, it } from "vitest";
import { presentRunOutcome, presentSuccess } from "../src/presenters/index.ts";

const missionId = "11111111-1111-4111-8111-111111111111";
function presentation(command: string) {
  const output: string[] = [];
  return {
    output,
    input: {
      io: { writeStdout: (s: string) => output.push(s), writeStderr: () => {} },
      format: "text" as const,
      command,
      requestId: missionId,
      cliVersion: "test",
      startedAt: new Date(),
    },
  };
}
it("describes required Flow input without dumping the full Schema", () => {
  const { input, output } = presentation("flow.describe");
  presentSuccess(input, {
    ref: { kind: "flow", id: "aaaaaaaaaaaaaaaa" },
    name: "Flow",
    inputSchema: {
      type: "object",
      required: ["region", "settings"],
      properties: {
        region: { type: "string", enum: ["west", "east"] },
        settings: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer", minimum: 2 }, optional: { type: "string" } },
        },
      },
    },
  });
  const text = output.join("");
  expect(text).toContain('REQUIRED: region; type="string"');
  expect(text).toContain('{"region":"west","settings":{"count":2}}');
  expect(text).toContain("FULL INPUT SCHEMA: pragma flow describe flow:aaaaaaaaaaaaaaaa --json");
  expect(text).not.toContain('"optional"');
});
it("renders multiline final strings verbatim for run and get", () => {
  const { input, output } = presentation("mission.get");
  presentRunOutcome(input, { status: "succeeded", result: "line one\nline two" });
  presentSuccess(input, {
    schemaVersion: "pragma.mission-result/v2",
    missionId,
    title: "Task",
    available: true,
    status: "succeeded",
    result: "line one\nline two",
  });
  expect(output[0]).toBe("line one\nline two\n");
  expect(output[1]).toContain("RESULT:\nline one\nline two\n");
});
