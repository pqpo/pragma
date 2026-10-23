import { describe, expect, it } from "vitest";
import { isManagementCliArgv, runManagementCli } from "../src/management-client.ts";
import {
  MANAGEMENT_COMMAND_PROTOCOL,
  MANAGED_RESOURCE_QUERY_SCHEMAS,
  ManagedResourceCommandSchema,
  ManagementCommandDescriptionSchema,
} from "@pragma/shared/integration";

describe("management CLI adapter", () => {
  it.each(ManagedResourceCommandSchema.options)(
    "describes %s input/output, access and valid examples without connecting to a Host",
    async (command) => {
      let stdout = "";
      const result = await runManagementCli(
        ["manage", ...command.split("."), "--describe", "--format", "json"],
        {
          writeStdout: (text) => {
            stdout += text;
          },
          writeStderr: () => undefined,
        },
        {
          execute: async () => {
            throw new Error("Description must not execute a command");
          },
        },
      );
      expect(result).toBe(0);
      const description = ManagementCommandDescriptionSchema.parse(JSON.parse(stdout));
      expect(description).toMatchObject({ command, readOnly: true, requiresExecution: true });
      expect(description.outputSchema).toHaveProperty("properties.result");
      expect(description.outputSchema).toHaveProperty("properties.status");
      expect(description.resultSchema).toHaveProperty("properties");
      for (const schema of [
        description.inputSchema,
        description.outputSchema,
        description.resultSchema,
      ])
        assertLocalSchemaRefs(schema, schema);
      expect(description.examples).toHaveLength(1);
      expect(
        MANAGED_RESOURCE_QUERY_SCHEMAS[command].input.safeParse(description.examples[0]!.input)
          .success,
      ).toBe(true);
    },
  );

  it("describes approval-free mutations as mutations and refuses actual queries without an Execution", async () => {
    let stdout = "";
    const io = {
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: () => undefined,
    };
    expect(await runManagementCli(["manage", "flow", "draft", "create", "--describe"], io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ readOnly: false, requiresExecution: true });
    stdout = "";
    expect(await runManagementCli(["manage", "skill", "list"], io, { endpoint: "" })).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      status: "failed",
      error: { code: "PERMISSION_DENIED" },
    });
  });
  it("loads one command help without opening a Host or exposing the full catalog", async () => {
    let stdout = "";
    const code = await runManagementCli(["manage", "flow", "draft", "get", "--help"], {
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
      ["manage", "flow", "draft", "update", "--input", "-"],
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

function assertLocalSchemaRefs(value: unknown, root: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertLocalSchemaRefs(child, root);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
      let resolved: unknown = root;
      for (const part of child
        .slice(2)
        .split("/")
        .map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        resolved =
          typeof resolved === "object" && resolved !== null
            ? (resolved as Record<string, unknown>)[part]
            : undefined;
      }
      expect(resolved, child).toBeDefined();
    }
    assertLocalSchemaRefs(child, root);
  }
}

it("preserves the requested identity and command when stdin parsing fails", async () => {
  let stdout = "";
  const requestId = "645e2c45-5761-4af0-ac54-9fc0a6a24512";
  const code = await runManagementCli(
    ["manage", "flow", "draft", "update", "--request-id", requestId, "--input", "-"],
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
  expect(isManagementCliArgv(["--format", "json", "manage", "flow", "draft", "get"])).toBe(true);
  let stdout = "";
  const code = await runManagementCli(
    ["--format", "text", "manage", "dsl", "resources", "list"],
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
    await runManagementCli(
      ["manage", "flow", "draft", "get", "--request-id", requestId, "--unknown"],
      {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: () => undefined,
      },
    ),
  ).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    requestId,
    command: "flow.draft.get",
    status: "failed",
  });
});

it("routes Evaluation and preserves suite failure results from Unicode stdin", async () => {
  expect(isManagementCliArgv(["--json", "manage", "evaluation", "draft", "run"])).toBe(true);
  let stdout = "";
  const code = await runManagementCli(
    ["manage", "evaluation", "draft", "run", "--input", "-"],
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

it("uses an explicit manage namespace and leaves user Mission/Flow entrypoints intact", async () => {
  for (const argv of [
    ["mission", "list"],
    ["mission", "get", "id"],
    ["flow", "run", "ref"],
    ["dsl", "resources", "list"],
  ])
    expect(isManagementCliArgv(argv)).toBe(false);
  for (const argv of [
    ["manage", "mission", "list"],
    ["--json", "manage", "flow", "draft", "get"],
    ["manage", "automation", "save"],
  ])
    expect(isManagementCliArgv(argv)).toBe(true);
  for (const command of [
    ["mission", "work", "get"],
    ["workspace", "list"],
    ["automation", "save"],
  ]) {
    let output = "";
    expect(
      await runManagementCli(["manage", ...command, "--help"], {
        writeStdout: (text) => {
          output += text;
        },
        writeStderr: () => undefined,
      }),
    ).toBe(0);
    expect(output).toContain(`pragma manage ${command.join(" ")}`);
    expect(output).toContain("Input Schema");
  }
});
