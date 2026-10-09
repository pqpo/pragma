import { describe, expect, it } from "vitest";
import { isManagementCliArgv, runManagementCli } from "../src/management-client.ts";
import { MANAGEMENT_COMMAND_PROTOCOL } from "@pragma/shared/integration";

describe("management CLI adapter", () => {
  it("loads one command help without opening a Host or exposing the full catalog", async () => {
    let stdout = "";
    const code = await runManagementCli(["flow", "draft", "get", "--help"], {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("draftId");
    expect(stdout).not.toContain("PragmaFlowStep");
  });
  it("passes a bounded Unicode stdin object to the existing handler interface", async () => {
    let stdout = "";
    const code = await runManagementCli(
      ["flow", "draft", "update", "--input", "-"],
      {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: () => undefined,
      },
      {
        readStdin: async () =>
          new TextEncoder().encode(
            JSON.stringify({
              draftId: "645e2c45-5761-4af0-ac54-9fc0a6a24512",
              expectedDraftRevision: 1,
              operations: [{ type: "set_metadata", metadata: { name: "中文" } }],
            }),
          ),
        execute: async (request) => {
          expect(request.input["expectedDraftRevision"]).toBe(1);
          expect(request.input["operations"]).toEqual([
            { type: "set_metadata", metadata: { name: "中文" } },
          ]);
          return {
            protocol: MANAGEMENT_COMMAND_PROTOCOL,
            requestId: request.requestId,
            command: request.command,
            status: "invalid",
            exitCode: 10,
            result: { diagnostics: [{ code: "flow.invalid", severity: "error" }] },
          };
        },
      },
    );
    expect(code).toBe(10);
    expect(JSON.parse(stdout).result.diagnostics[0].code).toBe("flow.invalid");
  });
});

it("preserves the requested identity and command when stdin parsing fails", async () => {
  let stdout = "";
  const requestId = "645e2c45-5761-4af0-ac54-9fc0a6a24512";
  const code = await runManagementCli(
    ["flow", "draft", "update", "--request-id", requestId, "--input", "-"],
    {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    },
    { readStdin: async () => new TextEncoder().encode("invalid JSON") },
  );
  expect(code).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    requestId,
    command: "flow.draft.update",
    status: "failed",
  });
});
it("routes management commands with a leading global format option", async () => {
  expect(isManagementCliArgv(["--format", "json", "flow", "draft", "get"])).toBe(true);
  let stdout = "";
  const code = await runManagementCli(
    ["--format", "text", "dsl", "resources", "list"],
    {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    },
    {
      execute: async (request) => ({
        protocol: MANAGEMENT_COMMAND_PROTOCOL,
        requestId: request.requestId,
        command: request.command,
        exitCode: 0,
        status: "succeeded",
        result: { items: [] },
      }),
    },
  );
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ items: [] });
});

it("preserves a parsed request identity when Commander rejects an unknown option", async () => {
  let stdout = "";
  const requestId = "645e2c45-5761-4af0-ac54-9fc0a6a24512";
  expect(
    await runManagementCli(["flow", "draft", "get", "--request-id", requestId, "--unknown"], {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    }),
  ).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    requestId,
    command: "flow.draft.get",
    status: "failed",
  });
});

it("routes Evaluation and preserves suite failure results from Unicode stdin", async () => {
  expect(isManagementCliArgv(["--json", "evaluation", "draft", "run"])).toBe(true);
  let stdout = "";
  const code = await runManagementCli(
    ["evaluation", "draft", "run", "--input", "-"],
    {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    },
    {
      readStdin: async () =>
        new TextEncoder().encode(
          JSON.stringify({ draftId: "645e2c45-5761-4af0-ac54-9fc0a6a24512", caseIds: ["审批"] }),
        ),
      execute: async (request) => {
        expect(request.command).toBe("evaluation.draft.run");
        expect(request.input["caseIds"]).toEqual(["审批"]);
        return {
          protocol: MANAGEMENT_COMMAND_PROTOCOL,
          requestId: request.requestId,
          command: request.command,
          status: "invalid",
          exitCode: 10,
          result: {
            suite: { passed: false },
            requestedCases: [{ id: "审批", passed: false }],
            coverage: { missing: ["transition"] },
          },
        };
      },
    },
  );
  expect(code).toBe(10);
  expect(JSON.parse(stdout).result.coverage.missing).toEqual(["transition"]);
});
