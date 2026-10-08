import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPragmaLogger,
  HumanInteractionCheckpointError,
  defineExpert,
  definePluginEntry,
  registerExecutionCommandSession,
  registerExpertToolsMcpSession,
} from "@pragma/core";
import {
  createManagementCommandApplication,
  MANAGEMENT_COMMAND_TOOLS,
  callManagementCommand,
} from "@pragma/local-host/management";
import {
  MANAGEMENT_COMMAND_PROTOCOL,
  ManagementCommandRequestSchema,
  type ManagementCommand,
} from "@pragma/shared/integration";
import { createManagementCommandTestFixture } from "./management-command-test-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const exec = promisify(execFile);
const clientPath = resolve("out/main/pragma-command-client.js");
const operations = [
  {
    type: "upsert_step",
    stepId: "approve",
    step: {
      human: {
        selectionMode: "single",
        prompt: { segments: [{ text: "发布？" }] },
        options: [
          { value: "yes", label: "同意" },
          { value: "no", label: "拒绝" },
        ],
      },
    },
  },
  { type: "set_start", stepId: "approve" },
  { type: "set_transition", stepId: "approve", transition: { end: true } },
];

async function fixture(requireCreateApproval: false | "definition" | "plugin" = false) {
  const root = await mkdtemp(join(tmpdir(), "pragma-command-boundary-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const { project, port } = createManagementCommandTestFixture(root);
  const expert = await defineExpert({
    id: "command-test",
    name: "Command test",
    description: "Boundary test",
    tags: [],
    scope: "test",
    workspace: root,
    ...(requireCreateApproval === "definition"
      ? { executionToolApprovals: { create_flow_draft: { mode: "required" as const } } }
      : {}),
    ...(requireCreateApproval === "plugin"
      ? {
          plugins: [
            {
              entry: definePluginEntry({
                manifest: {
                  schemaVersion: "pragma.plugin/v2",
                  id: "approval-policy",
                  name: "Approval policy",
                  description: "Boundary test",
                  version: "1.0.0",
                  tags: [],
                  runtime: {
                    type: "expert-agent-plugin",
                    entry: "./index.mjs",
                    trust: "trusted-host",
                  },
                  capabilities: [],
                  configuration: { type: "object", properties: {}, additionalProperties: false },
                  permissions: { filesystem: [], shell: [], network: [], environment: [] },
                },
                setup: () => ({
                  toolApprovals: [
                    { toolName: "create_flow_draft", approval: { mode: "required" } },
                  ],
                }),
              }),
            },
          ],
        }
      : {}),
  });
  const scope = { missionId: randomUUID(), workspacePath: root };
  const executionId = randomUUID();
  const invocationId = randomUUID();
  const controller = new AbortController();
  let approved = false;
  const context = {
    agent: expert,
    executionContext: {
      executionId,
      invocationId,
      depth: 0,
      assertOwnership: async () => {
        controller.signal.throwIfAborted();
      },
    },
    humanInteractionHandler: async () => ({ kind: "tool_approval" as const, approved }),
    runContext: {
      attributes: {
        "execution.executionId": executionId,
        "execution.invocationId": invocationId,
        "execution.contextId": "root-context",
      },
    },
    logger: createPragmaLogger(expert.loggerProvider, { component: "command-test" }),
    state: {},
    signal: controller.signal,
  };
  const receiptsRoot = join(root, "command-receipts");
  const app = createManagementCommandApplication({
    ports: { project: port, missions: {} as never },
    scope,
    receiptsRoot,
    allowedCommands: Object.keys(MANAGEMENT_COMMAND_TOOLS) as ManagementCommand[],
  });
  const registration = await registerExecutionCommandSession({
    logger: context.logger,
    inputSchema: z.toJSONSchema(ManagementCommandRequestSchema),
    execute: async (input) => app.execute(ManagementCommandRequestSchema.parse(input), context),
  });
  cleanup.push(registration.dispose);
  const invoke = async (
    command: ManagementCommand,
    input: Record<string, unknown>,
    requestId = randomUUID(),
  ) => {
    const inputPath = join(root, `${randomUUID()}.json`);
    await writeFile(inputPath, JSON.stringify(input));
    const args = [
      clientPath,
      ...command.split("."),
      "--input",
      inputPath,
      "--request-id",
      requestId,
      "--format",
      "json",
    ];
    let stdout: string;
    try {
      stdout = (
        await exec(process.execPath, args, {
          cwd: root,
          env: {
            ...process.env,
            PRAGMA_EXECUTION_COMMAND_ENDPOINT: registration.url,
            PRAGMA_EXECUTION_WORKSPACE: root,
          },
        })
      ).stdout;
    } catch (error) {
      stdout = (error as { stdout: string }).stdout;
    }
    return JSON.parse(stdout) as {
      status: string;
      exitCode: number;
      result: Record<string, unknown>;
      error?: { code: string };
    };
  };
  return {
    root,
    project,
    port,
    scope,
    context,
    receiptsRoot,
    app,
    registration,
    invoke,
    approve: () => {
      approved = true;
    },
    controller,
  };
}

describe("Flow CLI real process and Host boundary", { timeout: 60_000 }, () => {
  it("creates, repairs, conflicts, prepares, rejects and commits through the same handlers", async () => {
    const f = await fixture();
    const id = randomUUID();
    const input = {
      expectedProjectRevision: 0,
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "发布审批",
        description: "Flow CLI regression",
        tags: [],
      },
    };
    const created = await f.invoke("flow.draft.create", input, id);
    const replay = await f.invoke("flow.draft.create", input, id);
    expect(replay).toEqual(created);
    expect(
      (
        await f.invoke(
          "flow.draft.create",
          { ...input, metadata: { ...input.metadata, name: "Other" } },
          id,
        )
      ).error?.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    const draftId = created.result["draftId"];
    expect((await f.invoke("flow.draft.validate", { draftId })).exitCode).toBe(10);
    const update = { draftId, expectedDraftRevision: 0, operations };
    const updateId = randomUUID();
    const first = await f.invoke("flow.draft.update", update, updateId);
    expect(first.exitCode).toBe(0);
    expect(await f.invoke("flow.draft.update", update, updateId)).toEqual(first);
    expect((await f.invoke("flow.draft.update", update)).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    const prepared = await f.invoke("flow.draft.prepare", { draftId, expectedDraftRevision: 1 });
    expect(prepared.exitCode).toBe(0);
    const changeSetId = (prepared.result["changeSet"] as Record<string, unknown>)["changeSetId"];
    const rejected = await f.invoke("dsl.changes.commit", { changeSetId });
    expect(rejected.exitCode).toBe(6);
    expect((await f.project.get()).revision).toBe(0);
    const checkpoint = await f.app.execute(
      ManagementCommandRequestSchema.parse({
        protocol: MANAGEMENT_COMMAND_PROTOCOL,
        requestId: randomUUID(),
        command: "dsl.changes.commit",
        input: { changeSetId },
      }),
      {
        ...f.context,
        humanInteractionHandler: async () => {
          throw new HumanInteractionCheckpointError(f.context.executionContext.executionId);
        },
      },
    );
    expect(checkpoint.status).toBe("input_required");
    expect(checkpoint.exitCode).toBe(0);
    expect((await f.project.get()).revision).toBe(0);
    f.approve();
    const commitId = randomUUID();
    const committed = await f.invoke("dsl.changes.commit", { changeSetId }, commitId);
    expect(committed.exitCode).toBe(0);
    expect(await f.invoke("dsl.changes.commit", { changeSetId }, commitId)).toEqual(committed);
    expect((await f.project.get()).revision).toBe(1);
    expect((await f.invoke("flow.draft.discard", { draftId })).exitCode).toBe(0);
  });

  it("recovers an update journal and a committed publication when the outer receipt is pending", async () => {
    const f = await fixture();
    const created = await f.invoke("flow.draft.create", {
      expectedProjectRevision: 0,
      metadata: { id: "8h9j0k1m2n3p4q5r", name: "Recovery", description: "Recovery", tags: [] },
    });
    const draftId = created.result["draftId"];
    const updateId = randomUUID();
    const update = { draftId, expectedDraftRevision: 0, operations };
    const applied = await f.invoke("flow.draft.update", update, updateId);
    const key = createHash("sha256")
      .update(JSON.stringify([f.scope.missionId, "root-context", updateId]))
      .digest("hex");
    const path = join(f.receiptsRoot, `${key}.json`);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...receipt, state: "pending", result: undefined }));
    expect(await f.invoke("flow.draft.update", update, updateId)).toEqual(applied);
    const resumed = await f.app.execute(
      ManagementCommandRequestSchema.parse({
        protocol: MANAGEMENT_COMMAND_PROTOCOL,
        requestId: updateId,
        command: "flow.draft.update",
        input: update,
      }),
      {
        ...f.context,
        executionContext: {
          ...f.context.executionContext,
          executionId: randomUUID(),
          invocationId: randomUUID(),
        },
      },
    );
    expect(resumed).toEqual(applied);
    expect((await f.port.getFlowDraft(String(draftId))).draftRevision).toBe(1);
    f.approve();
    const prepared = await f.invoke("flow.draft.prepare", { draftId, expectedDraftRevision: 1 });
    const changeSetId = String(
      (prepared.result["changeSet"] as Record<string, unknown>)["changeSetId"],
    );
    // Publication survived, original Host operation receipt did not.
    await f.port.commit({ changeSetId, operationId: "original" });
    await rm(join(f.root, "state", "pragma", "operations"), { recursive: true });
    const replay = await f.port.commit({ changeSetId, operationId: "recovered" });
    expect(replay.projectRevision).toBe(1);
    expect((await f.project.get()).revision).toBe(1);
  });

  it("isolates Mission/Context grants, hidden schemas, cancellation and revoked credentials", async () => {
    const f = await fixture();
    const native = await registerExpertToolsMcpSession({
      agent: f.context.agent,
      getContext: () => f.context.runContext,
      logger: f.context.logger,
      state: {},
    });
    cleanup.push(native.dispose);
    expect(native.toolCatalog.some((tool) => tool.name.includes("flow_draft"))).toBe(false);
    expect(f.registration.toolCatalog).toEqual([]);
    const created = await f.invoke("flow.draft.create", {
      expectedProjectRevision: 0,
      metadata: { id: "8h9j0k1m2n3p4q5r", name: "Owned", description: "Owned", tags: [] },
    });
    const request = ManagementCommandRequestSchema.parse({
      protocol: MANAGEMENT_COMMAND_PROTOCOL,
      requestId: randomUUID(),
      command: "flow.draft.get",
      input: { draftId: created.result["draftId"] },
    });
    const foreign = {
      ...f.context,
      runContext: {
        attributes: { ...f.context.runContext.attributes, "execution.contextId": "other-context" },
      },
    };
    expect((await f.app.execute(request, foreign)).error?.code).toBe("PERMISSION_DENIED");
    const deniedAgent = await defineExpert({
      id: "denied-command-test",
      name: "Denied command test",
      description: "Denied policy",
      tags: [],
      scope: "test",
      workspace: f.root,
      toolPolicy: { mode: "all", deniedTools: ["get_flow_draft"] },
    });
    const denied = { ...f.context, agent: deniedAgent };
    expect((await f.app.execute(request, denied)).error?.code).toBe("PERMISSION_DENIED");
    let futureCalls = 0;
    const future = await registerExecutionCommandSession({
      protocolVersion: "2",
      logger: f.context.logger,
      inputSchema: z.toJSONSchema(ManagementCommandRequestSchema),
      execute: async () => {
        futureCalls += 1;
        return {};
      },
    });
    cleanup.push(future.dispose);
    await expect(callManagementCommand({ endpoint: future.url, request })).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    expect(futureCalls).toBe(0);
    const commandCancellation = new AbortController();
    commandCancellation.abort();
    await expect(
      callManagementCommand({
        endpoint: f.registration.url,
        request,
        signal: commandCancellation.signal,
      }),
    ).rejects.toMatchObject({ code: "INTERRUPTED" });
    f.controller.abort();
    expect((await f.app.execute(request, f.context)).exitCode).toBe(130);
    await f.registration.dispose();
    await expect(
      callManagementCommand({ endpoint: f.registration.url, request }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await expect(callManagementCommand({ request })).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });
});

it.each(["definition", "plugin"] as const)(
  "retains %s approval for commands absent from the visible tool catalog",
  async (source) => {
    const f = await fixture(source);
    const result = await f.invoke("flow.draft.create", {
      expectedProjectRevision: 0,
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Approval boundary",
        description: "Approval regression",
        tags: [],
      },
    });
    expect(result.exitCode).toBe(6);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(f.context.agent.tools).toBeUndefined();
    await expect(readFile(join(f.root, "state", "pragma", "dsl-drafts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("reports corrupt and unsupported receipt families without replaying mutations", async () => {
  const f = await fixture();
  const request = ManagementCommandRequestSchema.parse({
    protocol: MANAGEMENT_COMMAND_PROTOCOL,
    requestId: randomUUID(),
    command: "flow.draft.create",
    input: {
      expectedProjectRevision: 0,
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Storage failure",
        description: "Receipt regression",
        tags: [],
      },
    },
  });
  const operationId = createHash("sha256")
    .update(JSON.stringify([f.scope.missionId, "root-context", request.requestId]))
    .digest("hex");
  const receiptPath = join(f.receiptsRoot, `${operationId}.json`);
  await mkdir(f.receiptsRoot, { recursive: true });
  for (const raw of ["{", "null", "{}"]) {
    await writeFile(receiptPath, raw);
    expect((await f.app.execute(request, f.context)).error?.code).toBe("STORAGE_CORRUPTED");
    expect(await readFile(receiptPath, "utf8")).toBe(raw);
  }
  await writeFile(receiptPath, JSON.stringify({ schemaVersion: "pragma.management-request/v2" }));
  expect((await f.app.execute(request, f.context)).error?.code).toBe("STORAGE_VERSION_UNSUPPORTED");
  const targetId = randomUUID();
  const ownerPath = join(
    f.receiptsRoot,
    "owners",
    `${createHash("sha256").update(targetId).digest("hex")}.json`,
  );
  await mkdir(join(f.receiptsRoot, "owners"), { recursive: true });
  const read = { ...request, command: "flow.draft.get" as const, input: { draftId: targetId } };
  await writeFile(
    ownerPath,
    JSON.stringify({ schemaVersion: "pragma.management-command-owner/v2" }),
  );
  expect((await f.app.execute(read, f.context)).error?.code).toBe("STORAGE_VERSION_UNSUPPORTED");
  await writeFile(ownerPath, "{");
  expect((await f.app.execute(read, f.context)).error?.code).toBe("STORAGE_CORRUPTED");
  expect((await f.project.get()).revision).toBe(0);
  await expect(readFile(join(f.root, "state", "pragma", "dsl-drafts"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it(
  "isolates concurrent CLI transport request IDs on the same Execution endpoint",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const registration = await registerExecutionCommandSession({
      logger: f.context.logger,
      inputSchema: z.toJSONSchema(ManagementCommandRequestSchema),
      execute: async (input) => {
        const request = ManagementCommandRequestSchema.parse(input);
        entered += 1;
        if (entered === 2) release();
        await both;
        return {
          protocol: request.protocol,
          command: request.command,
          requestId: request.requestId,
          status: "succeeded",
          exitCode: 0,
          result: { ownRequestId: request.requestId },
        };
      },
    });
    cleanup.push(registration.dispose);
    const requests = Array.from({ length: 2 }, () =>
      ManagementCommandRequestSchema.parse({
        protocol: MANAGEMENT_COMMAND_PROTOCOL,
        requestId: randomUUID(),
        command: "dsl.resources.list",
        input: {},
      }),
    );
    const result = await Promise.allSettled(
      requests.map(
        async (request) =>
          await callManagementCommand({
            request,
            endpoint: registration.url,
            signal: AbortSignal.timeout(5_000),
          }),
      ),
    );
    expect(entered).toBe(2);
    expect(
      result.map((item, index) =>
        item.status === "fulfilled"
          ? item.value.requestId === requests[index]!.requestId
          : item.reason,
      ),
    ).toEqual([true, true]);
  },
);

it(
  "revokes the active per-request transport when its Execution lease closes",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let transportAborted = false;
    const registration = await registerExecutionCommandSession({
      logger: f.context.logger,
      inputSchema: z.toJSONSchema(ManagementCommandRequestSchema),
      execute: async (_input, signal) => {
        entered();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              transportAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return {};
      },
    });
    cleanup.push(registration.dispose);
    const request = ManagementCommandRequestSchema.parse({
      protocol: MANAGEMENT_COMMAND_PROTOCOL,
      requestId: randomUUID(),
      command: "dsl.resources.list",
      input: {},
    });
    const pending = callManagementCommand({
      request,
      endpoint: registration.url,
      signal: AbortSignal.timeout(5_000),
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await started;
    await registration.dispose();
    await rejected;
    expect(transportAborted).toBe(true);
  },
);
