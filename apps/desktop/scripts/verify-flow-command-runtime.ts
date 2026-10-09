import { createPhaseThreeCommandTestFixture } from "../src/main/features/built-in-agents/phase-three-command-test-fixture.ts";
import { createLocalHostPragmaProjectPort } from "@pragma/local-host";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  createLoggerProvider,
  PragmaPaths,
  encodePragmaPathSegment,
  type RuntimeAdapter,
  type RuntimeModelSelection,
  type RuntimeUsageObservation,
  type RuntimeStreamEvent,
} from "@pragma/core";
import {
  createSqliteExecutionStore,
  createNativeOsKeychain,
  createSecretStore,
} from "@pragma/local-host";
import {
  createManagementCommandHooks,
  MANAGEMENT_COMMAND_TOOLS,
} from "@pragma/local-host/management";
import {
  compileBuiltInAgent,
  builtInAgentResource,
  BUILT_IN_PRAGMA_REF,
  createPragmaManagementTools,
  PRAGMA_MANAGEMENT_BINDING_REF,
} from "@pragma/built-in-agents";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createOpenCodeRuntime } from "@pragma/runtime-opencode";
import { createModelProviderStore } from "../src/main/features/model-providers/model-provider-store.ts";
import { createManagementCommandTestFixture } from "../src/main/features/built-in-agents/management-command-test-fixture.ts";

const [runtimeName = "pi", scenario = "flow", variant = "after"] = process.argv.slice(2);
const root = await mkdtemp(join(tmpdir(), `pragma-368-${runtimeName}-${scenario}-${variant}-`));
const home = join(root, "home");
const workspace = join(root, "workspace");
const commandDirectory = join(root, "commands");
await Promise.all([mkdir(home), mkdir(workspace), mkdir(commandDirectory)]);
const client = resolve("apps/desktop/out/main/pragma-command-client.js");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
await writeFile(
  join(commandDirectory, "pragma"),
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(client)} "$@"\n`,
  { mode: 0o700 },
);
const evidencePath = `/tmp/pragma-368-${runtimeName}-${scenario}-${variant}.json`;
const observations: RuntimeUsageObservation[] = [];
const events: { type: string; toolName?: unknown }[] = [];
const messages: { prompt: string; output: string; elapsedMs: number }[] = [];
const approvals: { tool: string; approved: boolean }[] = [];
let rejectCommit = false;
const log = createLoggerProvider({
  minimumLevel: "warn",
  handler: { write: (record) => process.stderr.write(`${JSON.stringify(record)}\n`) },
});
let modelSelection: RuntimeModelSelection | undefined;
let runtime: RuntimeAdapter;
if (runtimeName === "pi") {
  // Migrate a copy of the provider config; never upgrade the user's live aggregate during a probe.
  const userPaths = new PragmaPaths({ pragmaHome: join(homedir(), ".pragma") });
  const providerConfig = join(root, "model-providers.json");
  await cp(userPaths.modelProviders(), providerConfig);
  const providers = createModelProviderStore({
    configPath: providerConfig,
    secretStore: createSecretStore({
      root: userPaths.secretStoreRoot(),
      dataRoot: userPaths.dataRoot(),
      keychain: createNativeOsKeychain(),
    }),
  });
  const available = await providers.listProviders();
  const provider = available[0]!;
  const model =
    provider.models.find((model) => model.kind === "generation" && model.id.includes("flash")) ??
    provider.models.find((model) => model.kind === "generation")!;
  modelSelection = { model: { providerId: provider.id, modelId: model.id } };
  runtime = createPiRuntime({ modelProviders: providers });
} else if (runtimeName === "codex")
  runtime = createCodexRuntime({
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    defaultThinkingLevel: "low",
  });
else if (runtimeName === "claude-code")
  runtime = createClaudeCodeRuntime({
    permissionMode: "bypassPermissions",
    acpWorkerPath: resolve("apps/desktop/out/main/claude-acp-worker.js"),
  });
else if (runtimeName === "qodercli")
  runtime = createQoderCliRuntime({ permissionMode: "bypassPermissions" });
else if (runtimeName === "antigravity")
  runtime = createAntigravityRuntime({
    authenticationMode: "host-keyring",
    permissionMode: "full-access",
  });
else if (runtimeName === "opencode")
  runtime = createOpenCodeRuntime({ permissionMode: "full-access" });
else throw new Error("Unknown Runtime.");
const runtimes = createStaticRuntimeResolver({
  runtimes: [runtime],
  defaultRuntimeId: runtime.descriptor.id,
});
let { project, port } = createManagementCommandTestFixture(
  root,
  scenario === "dsl" || scenario === "dsl-conflict",
);
const phaseThree = ["phase-three", "phase-three-catalog"].includes(scenario)
  ? await createPhaseThreeCommandTestFixture(home, runtimes, workspace)
  : undefined;
if (phaseThree !== undefined) {
  project = phaseThree.project;
  port = createLocalHostPragmaProjectPort({
    project,
    stateRoot: join(home, "state", "pragma"),
    catalog: async () => ({
      options: { runtimeModels: [], capabilities: [], avatars: [], builtinExperts: [] },
      resources: new Map(),
      availableModels: new Set(),
      isCapabilityAvailable: () => true,
    }),
  });
}
const scope = { missionId: randomUUID(), workspacePath: workspace };
const ports = {
  project: port,
  missions: phaseThree?.missionPort ?? ({} as never),
  resources: phaseThree?.resources ?? ({} as never),
  automations: phaseThree?.automations ?? ({} as never),
};
const tools = createPragmaManagementTools(ports, scope);
const hooks = {
  ...createManagementCommandHooks({
    pragmaHome: home,
    ports,
    scope,
    commandDirectory,
    allowedCommands: Object.keys(
      MANAGEMENT_COMMAND_TOOLS,
    ) as (keyof typeof MANAGEMENT_COMMAND_TOOLS)[],
  }),
  onStreamEvent: ({ event }: { readonly event: RuntimeStreamEvent }) => {
    events.push({
      type: event.type,
      ...(event.type.startsWith("tool.")
        ? { toolName: (event.payload as { toolName?: unknown }).toolName }
        : {}),
    });
  },
};
const resource = structuredClone(builtInAgentResource(BUILT_IN_PRAGMA_REF));
const phaseTwoNames = new Set(
  Object.entries(MANAGEMENT_COMMAND_TOOLS)
    .filter(
      ([command]) =>
        (command.startsWith("dsl.") || command.startsWith("evaluation.")) &&
        !command.endsWith(".recover"),
    )
    .map(([, name]) => name),
);
// Compare current phase-two defaults with the historical catalog containing these 21 tools.
if (
  [
    "dsl",
    "dsl-conflict",
    "evaluation",
    "phase-two-smoke",
    "phase-two-chat",
    "phase-two-flow",
  ].includes(scenario)
)
  for (const capability of resource.spec.capabilities)
    if (capability.kind === "tools" && capability.ref === "capability:0000000000manage") {
      if (variant === "after")
        capability.tools = capability.tools.filter((name) => !phaseTwoNames.has(name));
      else
        for (const name of phaseTwoNames)
          if (!capability.tools.includes(name)) capability.tools.push(name);
    }

const phaseThreeNames = new Set(
  Object.entries(MANAGEMENT_COMMAND_TOOLS)
    .filter(([command]) =>
      ["mission", "workspace", "home-project", "knowledge-store", "automation"].includes(
        command.split(".")[0]!,
      ),
    )
    .map(([, name]) => name),
);
if (scenario.startsWith("phase-three"))
  for (const capability of resource.spec.capabilities) {
    if (capability.kind !== "tools" || capability.ref !== "capability:0000000000manage") continue;
    capability.tools =
      variant === "after"
        ? capability.tools.filter((name) => !phaseThreeNames.has(name))
        : [...new Set([...capability.tools, ...phaseThreeNames])];
  }
const flowNames = new Set(
  Object.values(MANAGEMENT_COMMAND_TOOLS).filter((name) => name.includes("flow_draft")),
);
// Production defaults now omit Flow tools. Restore them only for the historical comparison probe.
if (
  variant === "before" &&
  !scenario.startsWith("phase-two") &&
  !scenario.startsWith("phase-three") &&
  !["dsl", "dsl-conflict", "evaluation"].includes(scenario)
)
  for (const capability of resource.spec.capabilities)
    if (capability.kind === "tools" && capability.ref === "capability:0000000000manage")
      capability.tools.push(...(Array.from(flowNames) as typeof capability.tools));
const delegated = await defineExpert({
  id: "probe-delegate",
  name: "Probe delegate",
  description: "Outside this probe",
  scope: "probe",
  tags: [],
  workspace,
  loggerProvider: log,
});
const compiled = await compileBuiltInAgent({
  ref: BUILT_IN_PRAGMA_REF,
  expertResource: resource,
  environmentId: "flow-command-probe",
  definitionStateRoot: join(root, "definitions"),
  workspace,
  pragmaHome: home,
  runtimes,
  defaultModelSelection: modelSelection,
  loggerProvider: log,
  adapterHost: {
    environmentId: "flow-command-probe",
    projectRoot: workspace,
    async resolveBinding(ref) {
      return ref === PRAGMA_MANAGEMENT_BINDING_REF
        ? {
            ref,
            revision: "probe",
            fingerprint: "0".repeat(64),
            value: { contribution: { tools, hooks } },
          }
        : undefined;
    },
  },
  resolveExternalInvocable: async (ref) => ({
    resource: { ...resource, metadata: { ...resource.metadata, id: ref.slice("expert:".length) } },
    value: delegated,
  }),
});
const expert = compiled.value;
const store = createSqliteExecutionStore({ pragmaHome: home });
const app = createPragma({
  pragmaHome: home,
  executionStore: store,
  runtimes,
  loggerProvider: log,
  usageSink: {
    record: (item) => {
      observations.push(item);
    },
  },
  automaticHumanInteractionHandler: async (request) => {
    if (request.kind === "tool_approval") {
      const approved = !(rejectCommit && request.toolName === "commit_dsl_changes");
      approvals.push({ tool: request.toolName, approved });
      return { kind: "tool_approval", approved };
    }
    return {
      kind: "user_question",
      answers:
        "Use the explicit test requirements; the temporary Project is approved for this probe.",
    };
  },
});
let session: Awaited<ReturnType<typeof app.experts.createSession>> | undefined;
let failure: string | undefined;
let timer: NodeJS.Timeout | undefined;
const prompt = async (text: string) => {
  const started = Date.now();
  const turn = await session!.prompt(text, { requestId: randomUUID() });
  timer = setTimeout(() => {
    void turn.cancel();
  }, 180_000);
  try {
    const output = String(await turn.result);
    messages.push({ prompt: text, output, elapsedMs: Date.now() - started });
    return output;
  } finally {
    clearTimeout(timer);
  }
};
try {
  const availability = await runtime.canUse?.();
  if (availability !== undefined && !availability.usable)
    throw new Error(availability.reason ?? "Runtime unavailable");
  session = await app.experts.createSession(expert, { runtime: runtime.descriptor.id });
  if (scenario === "legacy") {
    const bytes = await readFile(
      new URL(
        "../src/main/features/built-in-agents/__fixtures__/legacy-flow-a32bdedb/draft.json",
        import.meta.url,
      ),
    );
    const legacy = JSON.parse(bytes.toString()) as { draftId: string };
    const directory = join(root, "state", "pragma", "dsl-drafts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${encodePragmaPathSegment(legacy.draftId)}.json`), bytes);
    await prompt(
      `This temporary Project has a historical unowned Flow draft ${legacy.draftId} written by the old handler. Read manage-pragma and use only CLI: first get the draft and observe unowned_target, explicitly recover it through the Host approval gate, get it again, update maxNodeVisits to 2000 at the exact draft revision, validate, prepare and commit. No Evaluation. All temporary recovery and commit approvals are authorized but must go through the Host. Do not edit storage or print environment variables.`,
    );
    const snapshot = await project.get();
    if (
      snapshot.revision !== 1 ||
      !snapshot.resources.some(
        (item) => item.kind === "Flow" && item.spec.limits.maxNodeVisits === 2000,
      )
    )
      throw new Error("Runtime did not recover, edit and publish the historical Flow.");
    for (const tool of ["recover_flow_draft", "commit_dsl_changes"])
      if (!approvals.some((item) => item.tool === tool && item.approved))
        throw new Error(`Runtime did not exercise approval for ${tool}.`);
  } else if (scenario === "dsl-conflict") {
    await prompt(
      "Read manage-pragma. In this temporary Project use only CLI and native file editing to create and COMMIT a Writer Expert with the listed Probe Runtime option. No avatar/capabilities are requested. Then start an edit file draft for that Expert, set instructions to Replayed after conflict., inspect and prepare it WITHOUT committing. Write the exact draftId and changeSetId as a JSON object to conflict.json in the workspace. All temporary approvals must go through Host; never call the old DSL tools or edit Project storage.",
    );
    const first = await project.get();
    const writer = first.resources.find((r) => r.kind === "Expert");
    if (first.revision !== 1 || writer?.kind !== "Expert")
      throw new Error("Runtime did not create the Writer and prepare its edit.");
    const concurrent = structuredClone(writer);
    concurrent.spec.instructions = "Concurrent external change.";
    await project.publish({
      expectedRevision: first.revision,
      resources: first.resources.map((r) => (r === writer ? concurrent : r)),
    });
    await prompt(
      "A concurrent external actor changed the Writer. Read conflict.json and attempt its prepared commit once to observe the real conflict. Use pragma manage dsl draft restart on that draft; compare the previous read-only reference with the replacement files, explicitly replay instructions Replayed after conflict. while preserving the concurrent resource's other fields. Inspect, query one bounded review detail page, prepare and COMMIT the replacement. Use only manage-pragma CLI and native workspace editing.",
    );
    const final = await project.get();
    if (
      final.revision !== 3 ||
      !final.resources.some(
        (r) => r.kind === "Expert" && r.spec.instructions === "Replayed after conflict.",
      )
    )
      throw new Error(
        "Runtime did not restart the conflicted draft and publish explicit edit replay.",
      );
  } else if (scenario === "dsl") {
    await prompt(
      "Read manage-pragma. Use only CLI management commands and native file editing in this temporary Project. Create and atomically COMMIT a Writer Expert and a Writing Team using that Expert as coordinator and member. Use the listed Probe Runtime option; it is authorized for authoring only and you do not execute the new Expert. No avatar or capabilities are requested. Start one file draft with both targets, inspect the incomplete skeletons and observe invalid prepare, complete the returned files with all required fields, inspect/review, prepare, then commit through Host approval. Do not edit Project storage or call the old DSL managed tools. Write the exact Expert ref to writer-ref.txt.",
    );
    const first = await project.get();
    if (
      first.revision !== 1 ||
      !first.resources.some((r) => r.kind === "ExpertTeam") ||
      !first.resources.some((r) => r.kind === "Expert")
    )
      throw new Error("Runtime did not atomically publish Expert and Team through file drafts.");
    await prompt(
      "Use only manage-pragma CLI. Start a file draft editing the just-created Writer; make a precise local change to instructions: Write concise Chinese copy. Inspect and prepare/commit. Preserve all other fields and IDs. Then start another edit draft and discard it with Host approval. Report actual revisions.",
    );
    const second = await project.get();
    if (
      second.revision !== 2 ||
      !second.resources.some(
        (r) => r.kind === "Expert" && r.spec.instructions === "Write concise Chinese copy.",
      )
    )
      throw new Error("Runtime did not publish the local Expert modification.");
    rejectCommit = true;
    await prompt(
      "Edit the Writer description in a new file draft, prepare and attempt commit. Host will reject it; observe the rejection, do not bypass it, discard the draft with approval and finish. Use only CLI.",
    );
    if (
      (await project.get()).revision !== second.revision ||
      !approvals.some((a) => a.tool === "commit_dsl_changes" && !a.approved)
    )
      throw new Error("Runtime did not preserve publication approval rejection.");
  } else if (scenario === "evaluation") {
    await prompt(
      "Read manage-pragma and its Flow and Evaluation references. Use only CLI in this temporary Project to create and COMMIT a Flow named Approval with one Human step approve, prompt Release?, options ship/hold, start approve and end transition. Then independently create an Evaluation for the committed Flow. Allocate the ID through CLI. Upsert one ship case with an intentionally wrong expectPrompt, run it and observe failure, then fix expectPrompt to Release? and rerun. Query exact case definitions and coverage; prepare with the exact draft revision and COMMIT the passing Evaluation through separate approval. All temporary commits are authorized but still need the Host gate. Never pass complete Evaluation YAML or edit storage.",
    );
    const first = await project.get();
    if (
      first.revision !== 2 ||
      !first.resources.some((r) => r.kind === "Flow") ||
      !first.resources.some((r) => r.kind === "Evaluation")
    )
      throw new Error("Runtime did not independently publish Flow and Evaluation.");
    await prompt(
      "Use manage-pragma CLI to edit the committed Evaluation. First deliberately update with a stale expectedDraftRevision and observe the conflict. Get the current revision, add a passing hold case, run both ship and hold cases as an explicitly requested two-case batch, query cumulative coverage, prepare with exact revision and independently COMMIT. Preserve the Flow and its revision contents.",
    );
    const second = await project.get();
    if (
      second.revision !== 3 ||
      !second.resources.some(
        (r) =>
          r.kind === "Evaluation" &&
          r.spec.method.type === "flow-run-dry" &&
          r.spec.method.cases.length === 2,
      )
    )
      throw new Error("Runtime did not publish the Evaluation batch modification.");
  } else if (scenario === "phase-three") {
    await prompt(
      "Read manage-pragma and its Mission and Resources references. Use only pragma manage CLI for management, never old managed tools. In this isolated Host discover workspace, home presets, and knowledge stores; get the Probe preset. Create one Mission for its exact executor with goal Reply ok and its workspace and ready knowledge IDs. Query the Mission, list its work and get a work item after it finishes; send a follow-up Reply ok, then interrupt through the CLI. Write its missionId to mission-id.txt in your workspace. All probe mutations are explicitly authorized, but retain Host approval. Do not read credentials or managed storage.",
    );
    const missionId = (await readFile(join(workspace, "mission-id.txt"), "utf8")).trim();
    const mission = await phaseThree!.missions.get(missionId);
    if ((await phaseThree!.missions.list()).length !== 1 || mission.contextMounts.length === 0)
      throw new Error("Mission creation/knowledge binding failed.");
    await prompt(
      "Read manage-pragma. Use pragma manage CLI to allocate an Automation ID and create a daily UTC 09:00 schedule named Probe Automation for the same exact executor/workspace, enabled, reuse-session, with prompt Reply ok and request-approval permission mode. Save it; list and inspect current YAML. Modify its prompt to Reply done, disable it by saving, reset continuity, then delete it using current Project revisions. Write its exact ref to automation-ref.txt. Do not use generic DSL commit or old managed tools. All isolated mutations are explicitly authorized through Host approval.",
    );
    const ref = (await readFile(join(workspace, "automation-ref.txt"), "utf8")).trim();
    if (
      (await project.get()).resources.some((r) => r.kind === "Automation") ||
      (await phaseThree!.store.getBinding(ref)) !== undefined
    )
      throw new Error("Automation deletion incomplete.");
    if ((await phaseThree!.missions.get(missionId)).id !== missionId)
      throw new Error("Automation management deleted a Mission.");
    for (const name of [
      "create_mission",
      "send_mission_message",
      "save_automation",
      "reset_automation_session",
      "delete_automation",
    ])
      if (!approvals.some((item) => item.tool === name && item.approved))
        throw new Error(`Missing actual approval for ${name}`);
  } else if (
    scenario === "chat" ||
    scenario === "phase-two-chat" ||
    scenario === "phase-three-chat"
  )
    await prompt("只回复ok，不读取技能，不调用工具。");
  else if (
    scenario === "smoke" ||
    scenario === "phase-two-smoke" ||
    scenario === "phase-three-smoke" ||
    scenario === "phase-three-catalog"
  ) {
    const smokeCommand = scenario === "phase-three-catalog" ? "mission.list" : "dsl.resources.list";
    await prompt(
      `Read manage-pragma and its ${scenario === "phase-three-catalog" ? "Missions" : "DSL"} reference. This is a real CLI channel probe in a temporary workspace. Use your process/shell tool to run exactly \`pragma manage ${smokeCommand.replaceAll(".", " ")} --format json\`. Do not print environment variables. Report the structured result and finish.`,
    );
    const receiptRoots: string[] = [];
    const collect = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.name === "management-commands") receiptRoots.push(join(path, "v1"));
        else await collect(path);
      }
    };
    await collect(join(home, "state", "runtime-sessions"));
    const receipts = [];
    for (const directory of receiptRoots)
      for (const name of await readdir(directory))
        if (name.endsWith(".json"))
          receipts.push(JSON.parse(await readFile(join(directory, name), "utf8")));
    if (
      !receipts.some(
        (receipt) => receipt.result?.command === smokeCommand && receipt.result?.exitCode === 0,
      )
    )
      throw new Error(
        "No successful Host command receipt: the model response alone is not acceptance evidence.",
      );
  } else {
    await prompt(
      "Read manage-pragma and use only its CLI commands for this task. In this temporary Project, create and COMMIT a Flow named Release Approval, description Native Runtime CLI acceptance, containing one Human step approve with prompt Release?, two options ship/hold, start approve and an end transition. No Evaluation is requested. Use JSON files or stdin and stable request-id UUIDs. All temporary Project commits are explicitly approved, but must still go through the Host approval gate. First validate the incomplete draft to observe diagnostics, then complete and prepare/commit. After commit write the canonical Flow ref to flow-ref.txt in the workspace. Do not call the old Flow management tools or edit storage.",
    );
    const first = await project.get();
    if (!first.resources.some((item) => item.kind === "Flow"))
      throw new Error("Runtime did not publish the Flow.");
    await prompt(
      "Modify the just-created Flow through manage-pragma CLI. Change its description to Modified by native Runtime and the Human prompt to Ship now?. Before the successful update, deliberately issue one update with a stale expectedDraftRevision and observe the structured revision-conflict diagnostic. Reread and repair it, then validate, prepare and COMMIT. Use only CLI, preserve identity, no Evaluation.",
    );
    const second = await project.get();
    if (
      second.revision <= first.revision ||
      !second.resources.some(
        (item) =>
          item.kind === "Flow" && item.metadata.description === "Modified by native Runtime",
      )
    )
      throw new Error("Runtime did not commit the existing Flow modification.");
    rejectCommit = true;
    await prompt(
      "Create a new Flow draft named Rejected Flow, a complete single Human step with two options and an end transition. Prepare it and attempt to commit. The Host will deliberately reject this commit; observe the permission diagnostic and do not bypass it. Discard the uncommitted draft, report the rejection and finish. Use only manage-pragma CLI.",
    );
    if ((await project.get()).revision !== second.revision)
      throw new Error("Approval rejection published a Project revision.");
    if (!approvals.some((item) => item.tool === "commit_dsl_changes" && !item.approved))
      throw new Error("Runtime did not exercise commit rejection.");
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await session?.close().catch(() => undefined);
  await phaseThree?.dispose();
  await store.close();
  const snapshot = await project.get();
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        runtime: runtimeName,
        scenario,
        variant,
        root,
        tools: expert.tools?.length,
        modelSelection,
        succeeded: failure === undefined,
        failure,
        messages,
        observations,
        events,
        approvals,
        project: {
          revision: snapshot.revision,
          resources: snapshot.resources.map((item) => ({
            kind: item.kind,
            metadata: item.metadata,
          })),
        },
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    runtime: runtimeName,
    scenario,
    variant,
    succeeded: failure === undefined,
    evidencePath,
    failure,
  }),
);
if (failure !== undefined) process.exitCode = 1;
