import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createPragmaLogger,
  HumanInteractionCheckpointError,
  defineExpert,
  defineRuntimeDriver,
  PragmaPaths,
  encodePragmaPathSegment,
  type RuntimeNativeSessionContext,
  definePluginEntry,
  registerExecutionCommandSession,
  registerExpertToolsMcpSession,
} from "@pragma/core";
import {
  createManagementCommandApplication,
  createManagementCommandHooks,
  createManagementCommandOwnerLookup,
  MANAGEMENT_COMMAND_TOOLS,
  callManagementCommand,
} from "@pragma/local-host/management";
import {
  MANAGEMENT_COMMAND_PROTOCOL,
  ManagementCommandRequestSchema,
  type ManagementCommand,
} from "@pragma/shared/integration";
import { createManagementCommandTestFixture } from "./management-command-test-fixture.ts";

import { openRuntimeSession, createRuntimeTestFeatures } from "@pragma/core/testing";

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
    findOwner: createManagementCommandOwnerLookup(root),
    ownershipLockRoot: join(root, "state", "pragma", "owner-locks"),
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

it.each([true, false])(
  "binds checkpoint and approval to the current Execution on a warm Session (initial handler: %s)",
  { timeout: 15_000 },
  async (withInitialHandler) => {
    const f = await fixture();
    const initial = vi.fn(async () => ({ kind: "tool_approval" as const, approved: false }));
    const checkpoint = vi.fn(async () => {
      throw new HumanInteractionCheckpointError("second-execution");
    });
    const approve = vi.fn(async () => ({ kind: "tool_approval" as const, approved: true }));
    let changeSetId: string;
    const commitRequestId = randomUUID();
    const hooks = createManagementCommandHooks({
      pragmaHome: f.root,
      ports: { project: f.port, missions: {} as never },
      scope: f.scope,
      commandDirectory: f.root,
      allowedCommands: Object.keys(MANAGEMENT_COMMAND_TOOLS) as ManagementCommand[],
    });
    const agent = await defineExpert({
      id: "warm-command",
      name: "Warm command",
      description: "Current approval",
      tags: [],
      scope: "test",
      workspace: f.root,
      pragmaHome: f.root,
      hooks,
    });
    const runtime = defineRuntimeDriver<never, { context: RuntimeNativeSessionContext }>({
      descriptor: {
        id: "warm-command-test",
        kind: "warm-command-test",
        displayName: "Warm command",
      },
      features: createRuntimeTestFeatures(),
      createSession: (context) => ({ context }),
      mapEvent: () => ({ events: [] }),
      startTurn: async (native, turn) => {
        const call = async (
          command: ManagementCommand,
          input: Record<string, unknown>,
          requestId = randomUUID(),
        ) =>
          await callManagementCommand({
            endpoint: native.context.processEnvironment["PRAGMA_EXECUTION_COMMAND_ENDPOINT"],
            request: ManagementCommandRequestSchema.parse({
              protocol: MANAGEMENT_COMMAND_PROTOCOL,
              command,
              input,
              requestId,
            }),
          });
        if (turn.rawQuery === "prepare") {
          const created = await call("flow.draft.create", {
            expectedProjectRevision: 0,
            metadata: { id: "8h9j0k1m2n3p4q5r", name: "Warm Flow", description: "Warm", tags: [] },
          });
          expect(created, JSON.stringify(created)).toMatchObject({
            status: "succeeded",
            exitCode: 0,
          });
          const draftId = (created.result as Record<string, unknown>)["draftId"];
          await call("flow.draft.update", { draftId, expectedDraftRevision: 0, operations });
          const prepared = await call("flow.draft.prepare", { draftId, expectedDraftRevision: 1 });
          changeSetId = String(
            ((prepared.result as Record<string, unknown>)["changeSet"] as Record<string, unknown>)[
              "changeSetId"
            ],
          );
          return { outputText: "prepared" };
        }
        return {
          outputText: JSON.stringify(
            await call("dsl.changes.commit", { changeSetId }, commitRequestId),
          ),
        };
      },
    });
    const execution = {
      executionId: "first-execution",
      invocationId: "first-invocation",
      depth: 0,
      assertOwnership: async () => {},
    };
    const session = await openRuntimeSession(runtime, {
      agent,
      pragmaHome: f.root,
      systemSessionId: "warm-session",
      owner: { type: "expert-session", ownerId: "warm-owner", contextId: "warm-context" },
      context: { attributes: { "execution.contextId": "warm-context" } },
      executionContext: execution,
      ...(withInitialHandler ? { humanInteractionHandler: initial } : {}),
    });
    cleanup.push(() => session.close());
    await session.submit({ query: "prepare", execution: { context: execution } }).result;
    const waiting = JSON.parse(
      String(
        (
          await session.submit({
            query: "commit",
            execution: {
              context: {
                ...execution,
                executionId: "second-execution",
                invocationId: "second-invocation",
              },
              humanInteractionHandler: checkpoint,
            },
          }).result
        ).result.output,
      ),
    );
    expect(waiting).toMatchObject({
      status: "input_required",
      result: { executionId: "second-execution" },
    });
    const committed = JSON.parse(
      String(
        (
          await session.submit({
            query: "commit",
            execution: {
              context: {
                ...execution,
                executionId: "third-execution",
                invocationId: "third-invocation",
              },
              humanInteractionHandler: approve,
            },
          }).result
        ).result.output,
      ),
    );
    expect(committed.exitCode).toBe(0);
    expect(initial).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
    expect((await f.project.get()).revision).toBe(1);
  },
);

async function installHistoricalFlow(f: Awaited<ReturnType<typeof fixture>>) {
  const draftBytes = await readFile(
    new URL("./__fixtures__/legacy-flow-a32bdedb/draft.json", import.meta.url),
  );
  const changeBytes = await readFile(
    new URL("./__fixtures__/legacy-flow-a32bdedb/prepared-change.json", import.meta.url),
  );
  const draft = JSON.parse(draftBytes.toString()) as { draftId: string; draftRevision: number };
  const change = JSON.parse(changeBytes.toString()) as { changeSet: { changeSetId: string } };
  const draftPath = join(
    f.root,
    "state",
    "pragma",
    "dsl-drafts",
    `${encodePragmaPathSegment(draft.draftId)}.json`,
  );
  const changePath = join(
    f.root,
    "state",
    "pragma",
    "change-sets",
    `${encodePragmaPathSegment(change.changeSet.changeSetId)}.json`,
  );
  await mkdir(join(f.root, "state", "pragma", "dsl-drafts"), { recursive: true });
  await mkdir(join(f.root, "state", "pragma", "change-sets"), { recursive: true });
  await writeFile(draftPath, draftBytes);
  await writeFile(changePath, changeBytes);
  return {
    draft,
    changeSetId: change.changeSet.changeSetId,
    draftPath,
    changePath,
    draftBytes,
    changeBytes,
  };
}
it(
  "recovers a historically written Flow only after approval, preserves data and resumes editing",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    const old = await installHistoricalFlow(f);
    expect((await f.port.getFlowDraft(old.draft.draftId)).draftRevision).toBe(1);
    const missing = await f.invoke("flow.draft.get", { draftId: old.draft.draftId });
    expect(missing.error?.code).toBe("PERMISSION_DENIED");
    expect(missing.error).toMatchObject({
      details: { reason: "unowned_target", recovery: { command: "flow.draft.recover" } },
    });
    expect((await f.invoke("flow.draft.recover", { draftId: old.draft.draftId })).exitCode).toBe(6);
    expect(await readFile(old.draftPath)).toEqual(old.draftBytes);
    const request = ManagementCommandRequestSchema.parse({
      protocol: MANAGEMENT_COMMAND_PROTOCOL,
      requestId: randomUUID(),
      command: "flow.draft.recover",
      input: { draftId: old.draft.draftId },
    });
    const pending = await f.app.execute(request, {
      ...f.context,
      humanInteractionHandler: async () => {
        throw new HumanInteractionCheckpointError(f.context.executionContext.executionId);
      },
    });
    expect(pending.status).toBe("input_required");
    f.approve();
    const recovered = await f.app.execute(request, f.context);
    expect(recovered).toMatchObject({
      exitCode: 0,
      result: { draftId: old.draft.draftId, recovered: true },
    });
    expect(await f.app.execute(request, f.context)).toEqual(recovered);
    expect(await readFile(old.draftPath)).toEqual(old.draftBytes);
    expect((await f.invoke("flow.draft.get", { draftId: old.draft.draftId })).exitCode).toBe(0);
    const updated = await f.invoke("flow.draft.update", {
      draftId: old.draft.draftId,
      expectedDraftRevision: 1,
      operations: [{ type: "set_contracts", limits: { maxNodeVisits: 2000 } }],
    });
    expect(updated.exitCode).toBe(0);
    expect((await f.port.getFlowDraft(old.draft.draftId)).draftRevision).toBe(2);
  },
);
it(
  "recovers a historical prepared change without publishing until separate commit approval",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    const old = await installHistoricalFlow(f);
    expect(
      (
        await f.invoke("dsl.changes.read", {
          changeSetId: old.changeSetId,
          ref: "flow:8h9j0k1m2n3p4q5r",
        })
      ).exitCode,
    ).toBe(6);
    f.approve();
    expect((await f.invoke("dsl.changes.recover", { changeSetId: old.changeSetId })).exitCode).toBe(
      0,
    );
    expect(await readFile(old.changePath)).toEqual(old.changeBytes);
    expect((await f.project.get()).revision).toBe(0);
    expect(
      (
        await f.invoke("dsl.changes.read", {
          changeSetId: old.changeSetId,
          ref: "flow:8h9j0k1m2n3p4q5r",
        })
      ).exitCode,
    ).toBe(0);
    const commitRequest = ManagementCommandRequestSchema.parse({
      protocol: MANAGEMENT_COMMAND_PROTOCOL,
      command: "dsl.changes.commit",
      requestId: randomUUID(),
      input: { changeSetId: old.changeSetId },
    });
    expect(
      (
        await f.app.execute(commitRequest, {
          ...f.context,
          humanInteractionHandler: async () => ({ kind: "tool_approval", approved: false }),
        })
      ).exitCode,
    ).toBe(6);
    expect((await f.project.get()).revision).toBe(0);
    expect((await f.invoke("dsl.changes.commit", { changeSetId: old.changeSetId })).exitCode).toBe(
      0,
    );
    expect((await f.project.get()).revision).toBe(1);
  },
);
it(
  "rejects another Context's private owner and restores the same Context across Runtime Sessions",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    const old = await installHistoricalFlow(f);
    const paths = new PragmaPaths({ pragmaHome: f.root });
    const ownerRoot = join(
      paths.ownedSystemSessionRoot("previous-owner", "previous-session"),
      "management-commands",
      "v1",
      "owners",
    );
    const ownerPath = join(
      ownerRoot,
      `${createHash("sha256").update(old.draft.draftId).digest("hex")}.json`,
    );
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(
      ownerPath,
      JSON.stringify({
        schemaVersion: "pragma.management-command-owner/v1",
        missionId: randomUUID(),
        contextId: "foreign-context",
      }),
    );
    f.approve();
    expect((await f.invoke("flow.draft.recover", { draftId: old.draft.draftId })).exitCode).toBe(6);
    expect((await f.invoke("flow.draft.get", { draftId: old.draft.draftId })).exitCode).toBe(6);
    expect(await readFile(old.draftPath)).toEqual(old.draftBytes);
    await writeFile(
      ownerPath,
      JSON.stringify({
        schemaVersion: "pragma.management-command-owner/v1",
        missionId: f.scope.missionId,
        contextId: "root-context",
      }),
    );
    expect((await f.invoke("flow.draft.get", { draftId: old.draft.draftId })).exitCode).toBe(0);
    expect(await readFile(old.draftPath)).toEqual(old.draftBytes);
  },
);

it("rejects unsafe legacy data without claiming or rewriting it", { timeout: 60_000 }, async () => {
  const f = await fixture();
  const old = await installHistoricalFlow(f);
  f.approve();
  const future = JSON.parse(old.draftBytes.toString());
  future.resource.apiVersion = "pragma/v999";
  const source = JSON.stringify(future);
  await writeFile(old.draftPath, source);
  expect((await f.invoke("flow.draft.recover", { draftId: old.draft.draftId })).error?.code).toBe(
    "STORAGE_VERSION_UNSUPPORTED",
  );
  expect(await readFile(old.draftPath, "utf8")).toBe(source);
  await writeFile(old.draftPath, "{");
  expect((await f.invoke("flow.draft.recover", { draftId: old.draft.draftId })).error?.code).toBe(
    "STORAGE_CORRUPTED",
  );
  expect(await readFile(old.draftPath, "utf8")).toBe("{");
  const ownerFile = join(
    f.receiptsRoot,
    "owners",
    `${createHash("sha256").update(old.draft.draftId).digest("hex")}.json`,
  );
  await expect(readFile(ownerFile)).rejects.toMatchObject({ code: "ENOENT" });
});

it(
  "fences the command's real target even when unused fields or approval edits supply a distractor ID",
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    const old = await installHistoricalFlow(f);
    const paths = new PragmaPaths({ pragmaHome: f.root });
    const foreign = join(
      paths.ownedSystemSessionRoot("foreign-owner", "foreign-session"),
      "management-commands",
      "v1",
      "owners",
    );
    await mkdir(foreign, { recursive: true });
    await writeFile(
      join(foreign, `${createHash("sha256").update(old.changeSetId).digest("hex")}.json`),
      JSON.stringify({
        schemaVersion: "pragma.management-command-owner/v1",
        missionId: randomUUID(),
        contextId: "foreign-context",
      }),
    );
    const own = await f.invoke("flow.draft.create", {
      expectedProjectRevision: 0,
      metadata: { id: "8h9j0k1m2n3p4q5r", name: "Own", description: "Own", tags: [] },
    });
    const draftId = own.result["draftId"];
    f.approve();
    expect(
      (await f.invoke("dsl.changes.commit", { changeSetId: old.changeSetId, draftId })).exitCode,
    ).toBe(6);
    // Also fence the input actually chosen by an approval handler, not only the initial proposal.
    await f.invoke("flow.draft.update", { draftId, expectedDraftRevision: 0, operations });
    const prepared = await f.invoke("flow.draft.prepare", { draftId, expectedDraftRevision: 1 });
    const ownedChange = (prepared.result["changeSet"] as Record<string, unknown>)["changeSetId"];
    const request = ManagementCommandRequestSchema.parse({
      protocol: MANAGEMENT_COMMAND_PROTOCOL,
      requestId: randomUUID(),
      command: "dsl.changes.commit",
      input: { changeSetId: ownedChange },
    });
    const changed = await f.app.execute(request, {
      ...f.context,
      humanInteractionHandler: async () => ({
        kind: "tool_approval",
        approved: true,
        updatedInput: { draftId, changeSetId: old.changeSetId },
      }),
    });
    expect(changed.exitCode).toBe(6);
    expect((await f.project.get()).revision).toBe(0);
  },
);
