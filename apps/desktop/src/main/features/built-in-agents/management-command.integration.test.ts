import { compileBuiltInAgent, BUILT_IN_PRAGMA_REF } from "@pragma/built-in-agents";
import { createDesktopAdapterHost } from "../missions/mission-adapter-host.ts";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createStaticRuntimeResolver,
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
  type ExpertAgentHumanInteractionHandler,
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
import {
  createManagementCommandTestFixture,
  PROBE_AUTHORING_RUNTIME_REF,
} from "./management-command-test-fixture.ts";

import { createPhaseThreeCommandTestFixture } from "./phase-three-command-test-fixture.ts";

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

async function fixture(
  requireCreateApproval: false | "definition" | "plugin" = false,
  approvalTool = "create_flow_draft",
  phaseThree = false,
  onStorageTrashed?: () => void,
) {
  const root = await mkdtemp(join(tmpdir(), "pragma-command-boundary-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const { project, port } = createManagementCommandTestFixture(root, true);
  const expert = await defineExpert({
    id: "command-test",
    name: "Command test",
    description: "Boundary test",
    tags: [],
    scope: "test",
    workspace: root,
    ...(requireCreateApproval === "definition"
      ? { executionToolApprovals: { [approvalTool]: { mode: "required" as const } } }
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
  const scope: { missionId: string; workspacePath: string } = {
    missionId: randomUUID(),
    workspacePath: root,
  };
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
    humanInteractionHandler: (async () => ({
      kind: "tool_approval" as const,
      approved,
    })) as ExpertAgentHumanInteractionHandler,
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
  const runtime = defineRuntimeDriver<never, { id: string }>({
    descriptor: {
      id: "command-host-test",
      kind: "command-host-test",
      displayName: "Command Host test",
    },
    features: createRuntimeTestFeatures(),
    createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
    restoreSession: ({ systemSessionId }) => ({ id: systemSessionId }),
    readSession: (native) => ({ runtimeSessionId: native.id }),
    mapEvent: () => ({ events: [] }),
    startTurn: async (_native, turn) => {
      if (turn.rawQuery.includes("wait forever"))
        await new Promise<void>((resolve) => {
          if (turn.signal.aborted) resolve();
          else turn.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      return { outputText: "ok" };
    },
  });
  const host = phaseThree
    ? await createPhaseThreeCommandTestFixture(
        root,
        createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
        root,
        onStorageTrashed,
      )
    : undefined;
  if (host !== undefined) cleanup.push(host.dispose);
  const app = createManagementCommandApplication({
    ports: {
      project: port,
      missions: host?.missionPort ?? ({} as never),
      ...(host === undefined ? {} : { automations: host.automations, resources: host.resources }),
    },
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
      "manage",
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
    if (!stdout)
      throw new Error(
        "Command client returned no structured stdout; rebuild Desktop command client before this suite.",
      );
    return JSON.parse(stdout) as {
      status: string;
      exitCode: number;
      result: Record<string, unknown>;
      error?: { code: string };
    };
  };
  return {
    root,
    host,
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

describe("DSL and Evaluation CLI real process", { timeout: 60_000 }, () => {
  it("authors related files, freezes one submission, fences owners and commits atomically", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const input = {
      targets: [
        {
          mode: "create",
          key: "writer",
          kind: "Expert",
          name: "Writer",
          description: "Write copy",
        },
        {
          mode: "create",
          key: "team",
          kind: "ExpertTeam",
          name: "Writing Team",
          description: "Coordinate copy",
        },
      ],
    };
    const started = await f.invoke("dsl.draft.start", input, requestId);
    expect(started.exitCode).toBe(0);
    expect(await f.invoke("dsl.draft.start", input, requestId)).toEqual(started);
    const draftId = started.result["draftId"] as string;
    const resources = started.result["resources"] as {
      key: string;
      ref: string;
      filePath: string;
    }[];
    const writer = resources.find((r) => r.key === "writer")!;
    const team = resources.find((r) => r.key === "team")!;
    expect((await f.invoke("dsl.draft.prepare", { draftId })).exitCode).toBe(10);
    await writeFile(writer.filePath, cliExpert(writer.ref.slice(7)));
    await writeFile(team.filePath, cliTeam(team.ref.slice(5), writer.ref));
    expect((await f.invoke("dsl.draft.inspect", { draftId })).exitCode).toBe(0);
    const listed = await f.invoke("dsl.draft.list", { limit: 1 });
    expect(listed.result["items"]).toEqual([expect.objectContaining({ draftId })]);
    const prepareId = randomUUID();
    const prepared = await f.invoke("dsl.draft.prepare", { draftId }, prepareId);
    expect(prepared.exitCode).toBe(0);
    const changeSetId = (prepared.result["changeSet"] as Record<string, unknown>)[
      "changeSetId"
    ] as string;
    expect(await f.invoke("dsl.draft.prepare", { draftId }, prepareId)).toEqual(prepared);
    // Crash after candidate publication but before the final draft/outer receipt replacement.
    const recordPath = join(
      f.root,
      "state",
      "pragma",
      "dsl-resource-drafts",
      encodePragmaPathSegment(draftId),
      "draft.json",
    );
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.state = "editing";
    delete record.submissionHash;
    delete record.preparedChangeSetId;
    await writeFile(recordPath, JSON.stringify(record));
    const operation = createHash("sha256")
      .update(JSON.stringify([f.scope.missionId, "root-context", prepareId]))
      .digest("hex");
    const receiptPath = join(f.receiptsRoot, `${operation}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.state = "pending";
    delete receipt.result;
    await writeFile(receiptPath, JSON.stringify(receipt));
    const prepareJournalPath = join(recordPath, "..", "command-prepare.json");
    const prepareJournal = await readFile(prepareJournalPath, "utf8");
    await writeFile(
      prepareJournalPath,
      JSON.stringify({
        ...JSON.parse(prepareJournal),
        schemaVersion: "pragma.dsl-command-prepare/v99",
      }),
    );
    expect((await f.invoke("dsl.draft.inspect", { draftId })).error?.code).toBe(
      "STORAGE_VERSION_UNSUPPORTED",
    );
    expect(await readFile(recordPath, "utf8")).toBe(JSON.stringify(record));
    await writeFile(prepareJournalPath, prepareJournal);
    const ownContext = f.context.runContext.attributes["execution.contextId"];
    f.context.runContext.attributes["execution.contextId"] = "foreign-list-context";
    expect((await f.invoke("dsl.draft.list", { limit: 1 })).result["items"]).toEqual([]);
    expect(await readFile(recordPath, "utf8")).toBe(JSON.stringify(record));
    expect((await f.invoke("dsl.draft.inspect", { draftId })).exitCode).toBe(6);
    const ownerPath = join(recordPath, "..", "owner.json");
    const ownerBytes = await readFile(ownerPath, "utf8");
    const initializingOwner = JSON.stringify({ ...JSON.parse(ownerBytes), state: "initializing" });
    await writeFile(ownerPath, initializingOwner);
    expect((await f.invoke("dsl.draft.list", { limit: 1 })).result["items"]).toEqual([]);
    expect(await readFile(ownerPath, "utf8")).toBe(initializingOwner);
    expect(await readFile(recordPath, "utf8")).toBe(JSON.stringify(record));
    await writeFile(ownerPath, ownerBytes);
    f.context.runContext.attributes["execution.contextId"] = ownContext;
    expect((await f.invoke("dsl.draft.inspect", { draftId })).exitCode).toBe(0);
    expect((await f.invoke("dsl.draft.list", { limit: 1 })).result["items"]).toEqual([
      expect.objectContaining({ draftId, state: "prepared" }),
    ]);
    expect((await f.invoke("dsl.draft.prepare", { draftId }, prepareId)).result).toEqual(
      prepared.result,
    );
    expect(JSON.parse(await readFile(recordPath, "utf8")).state).toBe("prepared");
    const oldContext = f.context.runContext.attributes["execution.contextId"];
    f.context.runContext.attributes["execution.contextId"] = "foreign";
    expect((await f.invoke("dsl.draft.inspect", { draftId })).exitCode).toBe(6);
    expect((await f.invoke("dsl.changes.commit", { changeSetId })).exitCode).toBe(6);
    f.context.runContext.attributes["execution.contextId"] = oldContext;
    expect((await f.invoke("dsl.changes.commit", { changeSetId })).exitCode).toBe(6);
    expect((await f.project.get()).revision).toBe(0);
    f.approve();
    expect((await f.invoke("dsl.changes.commit", { changeSetId })).exitCode).toBe(0);
    expect((await f.project.get()).resources.map((r) => r.kind).sort()).toEqual([
      "Expert",
      "ExpertTeam",
      "RuntimeProfile",
    ]);
    expect(
      (
        await f.invoke("dsl.changes.prepare", {
          expectedProjectRevision: 1,
          sources: [cliExpert(writer.ref.slice(7))],
        })
      ).exitCode,
    ).toBe(10);
    const discarded = await f.invoke("dsl.draft.start", {
      targets: [{ mode: "edit", ref: writer.ref }],
    });
    expect(
      (await f.invoke("dsl.draft.discard", { draftId: discarded.result["draftId"] })).exitCode,
    ).toBe(0);
  });

  it("recovers actual historical file and Evaluation drafts only after approval, preserving their bytes", async () => {
    const f = await fixture();
    const source = new URL("./__fixtures__/legacy-authoring-a69bd99d/", import.meta.url);
    const provenance = JSON.parse(await readFile(new URL("provenance.json", source), "utf8")) as {
      missionId: string;
      dslDraftId: string;
      evaluationDraftId: string;
    };
    f.scope.missionId = provenance.missionId;
    const target = join(f.root, "state", "pragma", "dsl-resource-drafts");
    await cp(new URL("dsl-resource-drafts/", source), target, { recursive: true });
    await cp(new URL("workspace-files/", source), join(f.root, ".pragma"), { recursive: true });
    const directory = join(target, encodePragmaPathSegment(provenance.dslDraftId));
    const fixtureWorkspaceRoot = await realpath(f.root);
    for (const name of ["draft.json", "owner.json"]) {
      const path = join(directory, name);
      await writeFile(
        path,
        relocateHistoricalDraftFixture(await readFile(path, "utf8"), fixtureWorkspaceRoot),
      );
    }
    const before = await readFile(join(directory, "draft.json"), "utf8");
    expect((await f.invoke("dsl.draft.list", { limit: 1 })).result["items"]).toEqual([]);
    expect(await readFile(join(directory, "draft.json"), "utf8")).toBe(before);
    expect((await f.invoke("dsl.draft.inspect", { draftId: provenance.dslDraftId })).exitCode).toBe(
      6,
    );
    expect((await f.invoke("dsl.draft.recover", { draftId: provenance.dslDraftId })).exitCode).toBe(
      6,
    );
    f.approve();
    await writeFile(
      join(directory, "draft.json"),
      JSON.stringify({ ...JSON.parse(before), schemaVersion: "pragma.dsl-draft/v99" }),
    );
    expect(
      (await f.invoke("dsl.draft.recover", { draftId: provenance.dslDraftId })).error?.code,
    ).toBe("STORAGE_VERSION_UNSUPPORTED");
    await writeFile(join(directory, "draft.json"), before);

    expect((await f.invoke("dsl.draft.recover", { draftId: provenance.dslDraftId })).exitCode).toBe(
      0,
    );
    expect(await readFile(join(directory, "draft.json"), "utf8")).toBe(before);
    expect((await f.invoke("dsl.draft.inspect", { draftId: provenance.dslDraftId })).exitCode).toBe(
      0,
    );
    const evaluationPath = join(
      f.root,
      "state",
      "pragma",
      "evaluation-drafts",
      `${encodePragmaPathSegment(provenance.evaluationDraftId)}.json`,
    );
    const evaluationBytes = await readFile(new URL("evaluation.json", source));
    await mkdir(join(f.root, "state", "pragma", "evaluation-drafts"), { recursive: true });
    await writeFile(evaluationPath, evaluationBytes);
    expect(
      (await f.invoke("evaluation.draft.get", { draftId: provenance.evaluationDraftId })).exitCode,
    ).toBe(6);
    expect(
      (await f.invoke("evaluation.draft.recover", { draftId: provenance.evaluationDraftId }))
        .exitCode,
    ).toBe(0);
    expect(await readFile(evaluationPath)).toEqual(evaluationBytes);
    f.context.runContext.attributes["execution.contextId"] = "other";
    expect(
      (await f.invoke("evaluation.draft.recover", { draftId: provenance.evaluationDraftId }))
        .exitCode,
    ).toBe(6);
  });

  it("refuses a changed approved payload when recovering a pending DSL start", async () => {
    const f = await fixture("definition", "start_dsl_draft");
    f.approve();
    const requestId = randomUUID();
    const input = {
      targets: [
        { mode: "create", key: "writer", kind: "Expert", name: "Writer", description: "Original" },
      ],
    };
    const created = await f.invoke("dsl.draft.start", input, requestId);
    expect(created.exitCode).toBe(0);
    const op = createHash("sha256")
      .update(JSON.stringify([f.scope.missionId, "root-context", requestId]))
      .digest("hex");
    const receiptPath = join(f.receiptsRoot, `${op}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.state = "pending";
    delete receipt.result;
    await writeFile(receiptPath, JSON.stringify(receipt));
    f.context.humanInteractionHandler = async () => ({
      kind: "tool_approval",
      approved: true,
      updatedInput: { targets: [{ ...input.targets[0]!, description: "Changed approval" }] },
    });
    const result = await f.invoke("dsl.draft.start", input, requestId);
    expect(result.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (await f.port.listDslDrafts({ missionId: f.scope.missionId, limit: 25 })).items,
    ).toHaveLength(1);
  });

  it("runs, repairs, rebases and independently publishes Evaluation with durable mutation retries", async () => {
    const f = await fixture();
    f.approve();
    const flow = await f.invoke("flow.draft.create", {
      expectedProjectRevision: 0,
      metadata: { id: "8h9j0k1m2n3p4q5r", name: "Approval", description: "Boundary", tags: [] },
    });
    const flowId = flow.result["draftId"] as string;
    expect(
      (
        await f.invoke("flow.draft.update", {
          draftId: flowId,
          expectedDraftRevision: 0,
          operations,
        })
      ).exitCode,
    ).toBe(0);
    const fp = await f.invoke("flow.draft.prepare", { draftId: flowId, expectedDraftRevision: 1 });
    expect(
      (
        await f.invoke("dsl.changes.commit", {
          changeSetId: (fp.result["changeSet"] as Record<string, unknown>)["changeSetId"],
        })
      ).exitCode,
    ).toBe(0);
    const input = {
      mode: "create",
      expectedProjectRevision: 1,
      targetRef: "flow:8h9j0k1m2n3p4q5r",
      metadata: { id: "7h8j9k0m1n2p3q4r", name: "审批测评", description: "Independent", tags: [] },
    };
    const createId = randomUUID();
    const created = await f.invoke("evaluation.draft.create", input, createId);
    expect(created.exitCode).toBe(0);
    expect(await f.invoke("evaluation.draft.create", input, createId)).toEqual(created);
    const draftId = created.result["draftId"] as string;
    const testCase = {
      id: "yes",
      name: "Approve",
      input: {},
      mocks: {
        approve: {
          expectInput: {},
          expectPrompt: "wrong",
          output: { selection: "yes" },
        },
      },
      expect: { status: "succeeded", path: ["approve"], output: { selection: "yes" } },
    };
    const update = {
      draftId,
      expectedDraftRevision: 0,
      operations: [{ type: "upsert_case", case: testCase }],
    };
    const updateId = randomUUID();
    expect((await f.invoke("evaluation.draft.update", update, updateId)).exitCode).toBe(0);
    expect((await f.invoke("evaluation.draft.run", { draftId, caseIds: ["yes"] })).exitCode).toBe(
      10,
    );
    expect((await f.invoke("evaluation.draft.cases", { draftId, caseIds: ["yes"] })).exitCode).toBe(
      0,
    );
    expect(
      (await f.invoke("evaluation.draft.prepare", { draftId, expectedDraftRevision: 1 })).exitCode,
    ).toBe(10);
    // A pending outer receipt recovers the original aggregate mutation, not a second revision increment.
    const op = createHash("sha256")
      .update(JSON.stringify([f.scope.missionId, "root-context", updateId]))
      .digest("hex");
    const path = join(f.receiptsRoot, `${op}.json`);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    delete receipt.result;
    receipt.state = "pending";
    await writeFile(path, JSON.stringify(receipt));
    const mutationPath = join(f.receiptsRoot, "mutations", `${encodePragmaPathSegment(op)}.json`);
    const mutationBytes = await readFile(mutationPath, "utf8");
    await writeFile(
      mutationPath,
      JSON.stringify({
        ...JSON.parse(mutationBytes),
        schemaVersion: "pragma.evaluation-command-mutation/v99",
      }),
    );
    expect((await f.invoke("evaluation.draft.update", update, updateId)).error?.code).toBe(
      "STORAGE_VERSION_UNSUPPORTED",
    );
    await writeFile(mutationPath, mutationBytes);
    expect((await f.invoke("evaluation.draft.update", update, updateId)).exitCode).toBe(0);
    expect((await f.port.getEvaluationDraft(draftId)).draftRevision).toBe(1);
    const fixed = {
      ...testCase,
      mocks: { approve: { ...testCase.mocks.approve, expectPrompt: "发布？" } },
    };
    expect(
      (
        await f.invoke("evaluation.draft.update", {
          draftId,
          expectedDraftRevision: 0,
          operations: [{ type: "upsert_case", case: fixed }],
        })
      ).exitCode,
    ).not.toBe(0);
    expect(
      (
        await f.invoke("evaluation.draft.update", {
          draftId,
          expectedDraftRevision: 1,
          operations: [{ type: "upsert_case", case: fixed }],
        })
      ).exitCode,
    ).toBe(0);
    const run = await f.invoke("evaluation.draft.run", { draftId, caseIds: ["yes"] });
    expect(run.result["coverage"]).toMatchObject({ missing: [] });
    expect(run.exitCode).toBe(0);
    const prepareId = randomUUID();
    const prepared = await f.invoke(
      "evaluation.draft.prepare",
      { draftId, expectedDraftRevision: 2 },
      prepareId,
    );
    expect(prepared.exitCode).toBe(0);
    expect(
      await f.invoke("evaluation.draft.prepare", { draftId, expectedDraftRevision: 2 }, prepareId),
    ).toEqual(prepared);
    expect(
      (
        await f.invoke("dsl.changes.commit", {
          changeSetId: (prepared.result["changeSet"] as Record<string, unknown>)["changeSetId"],
        })
      ).exitCode,
    ).toBe(0);
    const snapshot = await f.project.get();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.resources.map((r) => r.kind).sort()).toEqual(["Evaluation", "Flow"]);
    expect((await f.invoke("evaluation.draft.discard", { draftId })).exitCode).toBe(0);
  });
});

function cliExpert(id: string) {
  return `apiVersion: ${PRAGMA_DSL_WRITE_API_VERSION}\nkind: Expert\nmetadata:\n  id: ${id}\n  name: Writer\n  description: Write copy\n  tags: []\nspec:\n  scope: Write.\n  instructions: Write concise text.\n  runtime:\n    ref: ${PROBE_AUTHORING_RUNTIME_REF}\n  capabilities: []\n  toolApprovals: {}\n  contextStores: []\n  plugins: []\n  tools: []\n`;
}
function cliTeam(id: string, ref: string) {
  return `apiVersion: ${PRAGMA_DSL_WRITE_API_VERSION}\nkind: ExpertTeam\nmetadata:\n  id: ${id}\n  name: Team\n  description: Coordinate copy\n  tags: []\nspec:\n  coordinator:\n    ref: ${ref}\n  members:\n    - ref: ${ref}\n  instructions: Collaborate.\n  contextStores: []\n  delegation:\n    permissions:\n      interact: {}\n    maxConcurrency: 2\n    maxDepth: 2\n    runtimes: {}\n`;
}

function relocateHistoricalDraftFixture(source: string, workspaceRoot: string): string {
  return JSON.stringify(
    JSON.parse(source, (_key, value: unknown) => {
      if (typeof value !== "string") return value;
      const prefix = ["/private__FIXTURE_ROOT__", "__FIXTURE_ROOT__"].find((marker) =>
        value.startsWith(marker),
      );
      return prefix === undefined
        ? value
        : join(workspaceRoot, ...value.slice(prefix.length).split("/"));
    }),
  );
}

it("relocates the entire historical workspace alias without changing protocol fields", () => {
  const source = JSON.stringify({
    schemaVersion: "pragma.dsl-draft/v1",
    workspacePath: "/private__FIXTURE_ROOT__",
    resources: [
      {
        filePath: "/private__FIXTURE_ROOT__/.pragma/dsl-drafts/example/worktree/expert.yaml",
        ref: "expert:d1gsrmjmw5t2ca0s",
      },
    ],
    ordinaryMarkerPath: "__FIXTURE_ROOT__/plain.yaml",
  });
  const target = join(tmpdir(), 'historical-fixture-"quoted"');
  expect(JSON.parse(relocateHistoricalDraftFixture(source, target))).toEqual({
    schemaVersion: "pragma.dsl-draft/v1",
    workspacePath: target,
    resources: [
      {
        filePath: join(target, ".pragma", "dsl-drafts", "example", "worktree", "expert.yaml"),
        ref: "expert:d1gsrmjmw5t2ca0s",
      },
    ],
    ordinaryMarkerPath: join(target, "plain.yaml"),
  });
});

async function markCommandPending(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  const operationId = createHash("sha256")
    .update(JSON.stringify([f.scope.missionId, "root-context", requestId]))
    .digest("hex");
  const path = join(f.receiptsRoot, `${operationId}.json`);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...receipt, state: "pending", result: undefined }));
  return operationId;
}

describe(
  "phase-three management commands through real CLI and shared Host",
  { timeout: 60_000 },
  () => {
    it("preserves inherited Mission and Automation port methods and their receiver", async () => {
      const f = await fixture(false, "create_flow_draft", true);
      const h = f.host!;
      const missionList = h.missionPort.list;
      const automationList = h.automations.list;
      Object.defineProperty(h.missionPort, "list", {
        configurable: true,
        enumerable: true,
        value: function (this: typeof h.missionPort, input: Parameters<typeof missionList>[0]) {
          expect(this).toBe(h.missionPort);
          return missionList.call(this, input);
        },
      });
      Object.defineProperty(h.automations, "list", {
        configurable: true,
        enumerable: true,
        value: function (this: typeof h.automations, input: Parameters<typeof automationList>[0]) {
          expect(this).toBe(h.automations);
          return automationList.call(this, input);
        },
      });
      for (const port of [h.missionPort, h.automations]) {
        Object.setPrototypeOf(port, { ...port });
        for (const key of Object.keys(port)) Reflect.deleteProperty(port, key);
      }
      expect((await f.invoke("mission.list", {})).status).toBe("succeeded");
      expect((await f.invoke("automation.list", {})).status).toBe("succeeded");
    });

    it("discovers resources, starts one owner, queries work, sends and interrupts", async () => {
      const f = await fixture(false, "create_flow_draft", true);
      const h = f.host!;
      expect((await f.invoke("workspace.list", {})).result).toMatchObject({
        items: [expect.objectContaining({ workspaceId: await realpath(f.root) })],
      });
      expect((await f.invoke("home-project.list", {})).result).toMatchObject({
        items: [expect.objectContaining({ projectId: h.preset.id })],
      });
      expect((await f.invoke("home-project.get", { projectId: h.preset.id })).result).toMatchObject(
        { contextStoreIds: [h.contextStore.id] },
      );
      expect((await f.invoke("knowledge-store.list", {})).result).toMatchObject({
        items: [expect.objectContaining({ storeId: h.contextStore.id })],
      });
      const input = {
        goal: "Reply ok",
        executorRef: h.executor.ref,
        workspaceId: f.root,
        contextStoreIds: [h.contextStore.id],
      };
      expect((await f.invoke("mission.create", input)).status).toBe("failed");
      expect(await h.missions.list()).toEqual([]);
      f.approve();
      const requestId = randomUUID();
      const created = await f.invoke("mission.create", input, requestId);
      expect(created, JSON.stringify(created)).toMatchObject({
        status: "succeeded",
        result: { executorRef: h.executor.ref, contextStoreIds: [h.contextStore.id] },
      });
      const missionId = String(created.result["missionId"]);
      expect((await f.invoke("mission.create", input, requestId)).result["missionId"]).toBe(
        missionId,
      );
      expect(await h.missions.list()).toHaveLength(1);
      const identity = await markCommandPending(f, requestId);
      await rm(
        join(
          f.root,
          "state",
          "pragma",
          "operations",
          `${encodePragmaPathSegment(identity)}.task.json`,
        ),
      );
      expect((await f.invoke("mission.create", input, requestId)).result["missionId"]).toBe(
        missionId,
      );
      expect(await h.missions.list()).toHaveLength(1);
      await vi.waitFor(
        async () => expect((await h.missions.get(missionId)).execution?.status).toBe("succeeded"),
        { timeout: 15_000 },
      );
      expect((await f.invoke("mission.list", {})).result).toMatchObject({
        items: [expect.objectContaining({ missionId })],
      });
      expect((await f.invoke("mission.get", { missionId })).result).toMatchObject({ missionId });
      const work = await f.invoke("mission.work.list", { missionId });
      expect(work, JSON.stringify(work)).toMatchObject({ status: "succeeded" });
      const items = work.result["items"] as { workItemId: string }[];
      expect(items.length).toBeGreaterThan(0);
      expect(
        (await f.invoke("mission.work.get", { missionId, workItemId: items[0]!.workItemId }))
          .result,
      ).toMatchObject({ workItemId: items[0]!.workItemId });
      expect((await f.invoke("mission.send", { missionId, content: "wait forever" })).status).toBe(
        "succeeded",
      );
      await vi.waitFor(
        async () => expect((await h.missions.get(missionId)).execution?.status).toBe("running"),
        { timeout: 15_000 },
      );
      expect((await f.invoke("mission.interrupt", { missionId })).status).toBe("succeeded");
      await vi.waitFor(
        async () => expect((await h.missions.get(missionId)).execution?.status).toBe("cancelled"),
        { timeout: 15_000 },
      );
    });

    it("saves, changes, disables, resets and deletes Automations without deleting Missions", async () => {
      let failAfterCleanup = false;
      const f = await fixture(false, "create_flow_draft", true, () => {
        if (failAfterCleanup) {
          failAfterCleanup = false;
          throw new Error("Crash after cleanup before progress");
        }
      });
      const h = f.host!;
      const resource = {
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Automation",
        metadata: {
          id: "000000000000a111",
          name: "Command schedule",
          description: "Test",
          tags: [],
        },
        spec: {
          adapter: "pragma.automation.schedule@v1",
          binding: "binding:desktop-automation",
          config: {
            trigger: { kind: "calendar", frequency: "daily", time: "09:00", timezone: "UTC" },
          },
          enabled: true,
          route: { executor: { ref: h.executor.ref }, input: { kind: "prompt", value: "ok" } },
          interaction: { mode: "reuse-session" },
          delivery: { adapter: "pragma.automation.delivery.local@v1" },
        },
      };
      const input = () => ({
        expectedProjectRevision: 1,
        source: JSON.stringify(resource),
        workspaceId: f.root,
        toolPermissionMode: "request-approval",
      });
      expect((await f.invoke("automation.save", input())).status).toBe("failed");
      expect((await h.project.get()).revision).toBe(1);
      f.approve();
      const requestId = randomUUID();
      const apply = h.project.applyTransactional.bind(h.project);
      vi.spyOn(h.project, "applyTransactional").mockImplementationOnce(async (...args) => {
        await apply(...args);
        throw new Error("Crash after publication before binding");
      });
      expect((await f.invoke("automation.save", input(), requestId)).status).toBe("failed");
      expect((await h.project.get()).revision).toBe(2);
      await markCommandPending(f, requestId);
      const saved = await f.invoke("automation.save", input(), requestId);
      expect(saved, JSON.stringify(saved)).toMatchObject({
        status: "succeeded",
        result: { enabled: true },
      });
      const ref = String(saved.result["ref"]);
      const binding = await h.store.getBinding(ref);
      expect((await f.invoke("automation.save", input(), requestId)).result).toEqual(saved.result);
      expect((await h.project.get()).revision).toBe(2);
      expect((await f.invoke("automation.list", {})).result).toMatchObject({
        items: [expect.objectContaining({ ref })],
      });
      const historical = await h.creator.create({
        workspace: f.root,
        missionInput: { kind: "prompt", value: "history" },
        executorRef: h.executor.ref,
      });
      await h.store.updateState(ref, binding!.generation, (state) => ({
        ...state,
        missionId: historical.id,
      }));
      resource.spec.enabled = false;
      expect(
        (await f.invoke("automation.save", { ...input(), expectedProjectRevision: 1 })).status,
      ).toBe("failed");
      expect(
        (await f.invoke("automation.save", { ...input(), expectedProjectRevision: 2 })).result,
      ).toMatchObject({ enabled: false });
      const resetRequest = randomUUID();
      const saveBinding = h.store.saveBinding.bind(h.store);
      vi.spyOn(h.store, "saveBinding").mockImplementationOnce(async (value) => {
        await saveBinding(value);
        throw new Error("Crash after binding");
      });
      expect((await f.invoke("automation.reset-session", { ref }, resetRequest)).status).toBe(
        "failed",
      );
      const pendingGeneration = (await h.store.getBinding(ref))!.generation;
      await markCommandPending(f, resetRequest);
      failAfterCleanup = true;
      expect((await f.invoke("automation.reset-session", { ref }, resetRequest)).status).toBe(
        "failed",
      );
      const event = {
        eventId: "accepted-after-cleanup",
        scheduledFor: new Date().toISOString(),
        missionId: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await h.store.updateState(ref, pendingGeneration, (state) => ({ ...state, queue: [event] }));
      await markCommandPending(f, resetRequest);
      expect((await f.invoke("automation.reset-session", { ref }, resetRequest)).status).toBe(
        "succeeded",
      );
      expect((await h.store.getState(ref, pendingGeneration)).queue).toEqual([event]);
      const reset = await h.store.getBinding(ref);
      expect(reset?.generation).not.toBe(binding?.generation);
      expect(reset?.generation).toBe(pendingGeneration);
      expect((await f.invoke("automation.reset-session", { ref }, resetRequest)).status).toBe(
        "succeeded",
      );
      expect((await h.store.getBinding(ref))?.generation).toBe(reset?.generation);
      expect(
        (await f.invoke("automation.delete", { ref, expectedProjectRevision: 3 })).result,
      ).toMatchObject({ deleted: true });
      expect(await h.store.getBinding(ref)).toBeUndefined();
      expect((await h.missions.get(historical.id)).id).toBe(historical.id);
    });
  },
);

it("assembles the production CLI grants and hooks with no selected management tools", async () => {
  const f = await fixture();
  let result: unknown;
  let endpoint: string | undefined;
  const runtime = defineRuntimeDriver<never, { context: RuntimeNativeSessionContext }>({
    descriptor: {
      id: "empty-management-test",
      kind: "empty-management-test",
      displayName: "Empty management test",
    },
    features: createRuntimeTestFeatures(),
    createSession: (context) => ({ context }),
    mapEvent: () => ({ events: [] }),
    startTurn: async (native) => {
      endpoint = native.context.processEnvironment["PRAGMA_EXECUTION_COMMAND_ENDPOINT"];
      result = await callManagementCommand({
        endpoint,
        request: {
          protocol: MANAGEMENT_COMMAND_PROTOCOL,
          requestId: randomUUID(),
          command: "dsl.resources.list",
          input: {},
        },
      });
      return { outputText: "ok" };
    },
  });
  const compiled = await compileBuiltInAgent({
    ref: BUILT_IN_PRAGMA_REF,
    environmentId: "desktop",
    definitionStateRoot: join(f.root, "definitions"),
    workspace: f.root,
    pragmaHome: f.root,
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
    adapterHost: createDesktopAdapterHost(
      {
        capabilityStore: {} as never,
        capabilityCredentials: {} as never,
        capabilitiesPath: f.root,
        pragmaHome: f.root,
        pragmaManagement: { project: f.port, missions: {} as never },
        pragmaManagementScope: f.scope,
        pragmaCommandDistribution: async () => ({ directory: f.root }),
      },
      f.root,
    ),
    resolveExternalInvocable: async (ref) => ({
      resource: {
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Expert",
        metadata: {
          id: ref.slice("expert:".length),
          avatarId: "pragma.avatar.expert.default",
          name: "Delegate",
          description: "Test",
          tags: [],
        },
        spec: {
          scope: "test",
          instructions: "test",
          tools: [],
          capabilities: [],
          plugins: [],
          contextStores: [],
          toolApprovals: {},
        },
      },
      value: f.context.agent,
    }),
  });
  expect(compiled.value.tools?.map((tool) => tool.name)).toEqual([
    "call_store_revision_agent",
    "call_skill_revision_agent",
  ]);
  expect(compiled.value.skills?.skills).toHaveLength(1);
  const session = await openRuntimeSession(runtime, {
    agent: compiled.value,
    pragmaHome: f.root,
    systemSessionId: "empty-management-session",
    owner: {
      type: "expert-session",
      ownerId: "empty-management-owner",
      contextId: "empty-context",
    },
    context: { attributes: { "execution.contextId": "empty-context" } },
    executionContext: f.context.executionContext,
  });
  await session.submit({ query: "check", execution: { context: f.context.executionContext } })
    .result;
  expect(endpoint).toBeTruthy();
  expect(result).toMatchObject({ status: "succeeded", origin: { missionId: f.scope.missionId } });
  await session.close();
  await expect(
    callManagementCommand({
      endpoint,
      request: {
        protocol: MANAGEMENT_COMMAND_PROTOCOL,
        requestId: randomUUID(),
        command: "dsl.resources.list",
        input: {},
      },
    }),
  ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
});
