import { createSqliteExecutionStore } from "@pragma/local-host";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPragma,
  createRuntimeProbeEvidence,
  createStaticRuntimeResolver,
  defineExpert,
  inspectRuntimeObservationConformance,
  writeRuntimeProbeEvidence,
  type IExpertAgentModelsConfig,
  type RuntimeAdapter,
  type RuntimeFeatureName,
  type RuntimeProbeAssertion,
  type RuntimeStreamEvent,
} from "@pragma/core";
import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";

import { createExampleModelsConfig, createExamplePiRuntime } from "../support/example-kit.ts";

const [runtimeName, probeName] = process.argv.slice(2).filter((argument) => argument !== "--");
const runtimeNames = ["pi", "codex", "claude-code", "qodercli", "antigravity"] as const;
const probeNames = [
  "availability",
  "models",
  "stream",
  "native-tool",
  "mcp",
  "skills",
  "attachments",
  "resume",
  "compaction",
  "cancellation",
  "steering",
  "full",
] as const;

if (!runtimeNames.includes(runtimeName as (typeof runtimeNames)[number])) {
  throw new Error(`Runtime must be one of: ${runtimeNames.join(", ")}.`);
}
if (!probeNames.includes(probeName as (typeof probeNames)[number])) {
  throw new Error(`Probe must be one of: ${probeNames.join(", ")}.`);
}

const root = await mkdtemp(join(tmpdir(), `pragma-${runtimeName}-${probeName}-`));
const workspace = join(root, "workspace");
const pragmaHome = join(root, "pragma-home");
const skillDir = join(root, "skill");
await Promise.all([
  mkdir(workspace, { recursive: true }),
  mkdir(pragmaHome, { recursive: true }),
  mkdir(skillDir, { recursive: true }),
]);
const filePath = join(workspace, "RUNTIME_PROBE_FILE.txt");
const imagePath = join(workspace, "runtime-probe.png");
await Promise.all([
  writeFile(filePath, "Pragma Runtime probe file marker: FILE_PROBE_OK_9241\n"),
  writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    ),
  ),
  writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: pragma-runtime-probe",
      "description: Runtime conformance Skill probe.",
      "---",
      "",
      "When explicitly invoked, include the exact marker SKILL_PROBE_OK_7419 in the answer.",
      "",
    ].join("\n"),
  ),
]);

const runtimeSetup = createProbeRuntime(
  runtimeName as (typeof runtimeNames)[number],
  probeName as (typeof probeNames)[number],
);
const runtime = runtimeSetup.runtime;
const assertions: RuntimeProbeAssertion[] = [];
const observations: string[] = [];
let runtimeVersion: string | undefined;
let failed: unknown;

try {
  if (runtimeSetup.configurationError !== undefined) {
    throw runtimeSetup.configurationError;
  }
  const availability = await runtime.canUse();
  runtimeVersion =
    readString(availability.details?.["version"]) ??
    readString(availability.details?.["parsedVersion"]);
  recordObservation(observations, { phase: "availability", result: availability });
  if (probeName === "availability") {
    assertions.push(
      assertion(
        "availability.executed",
        "availability",
        "executed",
        availability.usable ? "passed" : "failed",
        availability.usable
          ? "Runtime availability probe succeeded."
          : (availability.reason ?? "Runtime availability probe failed."),
      ),
    );
  }
  if (!availability.usable) throw new Error(availability.reason ?? "Runtime is unavailable.");
  if (probeName === "models") {
    const models = await runtime.listModels?.();
    const passed = models !== undefined && models.length > 0;
    assertions.push(
      assertion(
        "models.discovered",
        "modelDiscovery",
        "discovered",
        passed ? "passed" : "failed",
        passed ? `Discovered ${models.length} models.` : "Runtime returned no model catalog.",
      ),
    );
    recordObservation(observations, models ?? []);
    if (!passed) throw new Error("Runtime returned no model catalog.");
  } else if (probeName !== "availability") {
    await runSessionProbe(runtime, probeName as (typeof probeNames)[number], {
      workspace,
      pragmaHome,
      skillDir,
      filePath,
      imagePath,
      assertions,
      observations,
      models: runtimeSetup.models,
    });
  }
} catch (error) {
  failed = error;
  if (!assertions.some(({ status }) => status === "failed")) {
    assertions.push(
      assertion(
        `${probeName}.failed`,
        probeFeature(probeName as (typeof probeNames)[number]),
        "executed",
        "failed",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

const capturedAt = new Date().toISOString();
const { evidence, evidencePath } = await (async () => {
  try {
    const evidence = createRuntimeProbeEvidence(
      {
        runtime: {
          id: runtime.descriptor.id,
          kind: runtime.descriptor.kind,
          ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
        },
        probe: { id: probeName!, version: "v1" },
        environment: {
          capturedAt,
          platform: process.platform,
          architecture: process.arch,
          authenticationMode: runtimeSetup.authenticationMode,
        },
        command: {
          executable: "pnpm runtime:probe",
          arguments: [runtimeName!, probeName!],
        },
        assertions,
        observations,
      },
      {
        home: process.env["HOME"],
        workspace,
        paths: [root, pragmaHome, skillDir],
        secrets: readProbeSecrets(process.env),
      },
    );
    return { evidence, evidencePath: await writeRuntimeProbeEvidence(evidence) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();
console.log(
  JSON.stringify(
    {
      runtime: runtime.descriptor.id,
      probe: probeName,
      status: failed === undefined ? "passed" : "failed",
      evidencePath,
      assertions: evidence.assertions,
    },
    null,
    2,
  ),
);
if (failed !== undefined) {
  process.exitCode = 1;
  console.error(failed instanceof Error ? failed.message : String(failed));
}

interface ProbeRuntimeSetup {
  readonly runtime: RuntimeAdapter;
  readonly authenticationMode: string;
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly configurationError?: Error | undefined;
}

function createProbeRuntime(
  name: (typeof runtimeNames)[number],
  probe: (typeof probeNames)[number],
): ProbeRuntimeSetup {
  const modelName = process.env["PRAGMA_RUNTIME_PROBE_MODEL"];
  const thinkingLevel = process.env["PRAGMA_RUNTIME_PROBE_THINKING"];
  const defaults = {
    ...(modelName === undefined ? {} : { defaultModelName: modelName }),
    ...(thinkingLevel === undefined ? {} : { defaultThinkingLevel: thinkingLevel }),
  };
  switch (name) {
    case "pi":
      if (probe === "availability") {
        return { runtime: createPiRuntime(), authenticationMode: "host-registered-provider" };
      }
      try {
        return {
          runtime: createExamplePiRuntime(process.env),
          models: createExampleModelsConfig(process.env),
          authenticationMode: "host-registered-provider",
        };
      } catch (error) {
        return {
          runtime: createPiRuntime(),
          authenticationMode: "host-registered-provider",
          configurationError: error instanceof Error ? error : new Error(String(error)),
        };
      }
    case "codex":
      return { runtime: createCodexRuntime(defaults), authenticationMode: "native-cli-profile" };
    case "claude-code":
      return {
        runtime: createClaudeCodeRuntime(defaults),
        authenticationMode: "native-cli-profile",
      };
    case "qodercli":
      return {
        runtime: createQoderCliRuntime(defaults),
        authenticationMode: "native-cli-profile",
      };
    case "antigravity": {
      const authenticationMode =
        process.env["PRAGMA_ANTIGRAVITY_PROBE_AUTH_MODE"] === "isolated-environment"
          ? "isolated-environment"
          : "host-keyring";
      return {
        runtime: createAntigravityRuntime({
          ...defaults,
          authenticationMode,
        }),
        authenticationMode,
      };
    }
  }
}

async function runSessionProbe(
  runtime: RuntimeAdapter,
  probe: (typeof probeNames)[number],
  paths: {
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly skillDir: string;
    readonly filePath: string;
    readonly imagePath: string;
    readonly assertions: RuntimeProbeAssertion[];
    readonly observations: string[];
    readonly models?: IExpertAgentModelsConfig | undefined;
  },
): Promise<void> {
  const liveEvents: RuntimeStreamEvent[] = [];
  const expert = await defineExpert({
    hooks: {
      onStreamEvent: ({ event }) => {
        liveEvents.push(event);
      },
    },
    id: "pr0bexpt00000001",
    name: "Runtime Probe",
    description: "Exercises Runtime conformance features.",
    instructions:
      "Follow the probe request exactly. Use tools when requested and preserve every exact marker.",
    tags: ["runtime", "probe"],
    scope: "test",
    workspace: paths.workspace,
    pragmaHome: paths.pragmaHome,
    skills: {
      skills: [
        {
          type: "local",
          name: "pragma-runtime-probe",
          description: "Runtime conformance Skill probe.",
          path: join(paths.skillDir, "SKILL.md"),
          baseDir: paths.skillDir,
        },
      ],
    },
    ...(paths.models === undefined ? {} : { models: paths.models }),
  });
  const executionStore = createSqliteExecutionStore({ pragmaHome: paths.pragmaHome });
  const app = createPragma({
    executionStore,
    pragmaHome: paths.pragmaHome,
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
  });
  const session = await app.experts
    .createSession(expert, { runtime: runtime.descriptor.id })
    .catch(async (error) => {
      await executionStore.close?.();
      throw error;
    });
  const operations =
    probe === "full"
      ? (["stream", "native-tool", "mcp", "skills", "attachments", "resume", "steering"] as const)
      : [probe];
  const failures: unknown[] = [];
  try {
    for (const operation of operations) {
      const eventStart = liveEvents.length;
      if (operation === "compaction") {
        const initial = await session.prompt(
          [
            "Remember COMPACTION_MEMORY_2054. Reply only RECORDED.",
            // A tiny conversation may make /compact a no-op. Give the native
            // runtime enough context to exercise a real compaction boundary.
            ...Array.from(
              { length: 256 },
              (_, index) =>
                `Background note ${index}: this runtime acceptance probe verifies context retention after manual compaction. Preserve the marker above; these repetitive notes can be summarized.`,
            ),
          ].join("\n"),
          {
            requestId: `probe-compact-initial-${Date.now()}`,
          },
        );
        await initial.result;
        for (let turn = 0; turn < 3; turn += 1) {
          const followup = await session.prompt(
            `Background check ${turn}: reply only RECORDED and keep the original marker in memory.`,
            { requestId: `probe-compact-background-${turn}-${Date.now()}` },
          );
          await followup.result;
        }
        const canCompact = await session.canCompactRootContext();
        if (canCompact !== true) {
          paths.assertions.push(
            assertion(
              "compaction.executed",
              "compaction",
              "executed",
              "skipped",
              "Runtime reported that the current context did not require compaction.",
            ),
          );
          continue;
        }
        await session.compactRootContext();
        const after = await session.prompt(
          "Reply with the exact COMPACTION_MEMORY marker I asked you to remember.",
          {
            requestId: `probe-compact-recall-${Date.now()}`,
          },
        );
        if (!String(await after.result).includes("COMPACTION_MEMORY_2054"))
          throw new Error("Compacted context did not preserve the remembered marker.");
        paths.assertions.push(
          assertion(
            "compaction.executed",
            "compaction",
            "executed",
            "passed",
            "Manual context compaction completed.",
          ),
        );
        continue;
      }
      if (operation === "steering") {
        if (!runtime.descriptor.capabilities?.supportsSteer) {
          paths.assertions.push(
            assertion(
              "steering.executed",
              "steering",
              "executed",
              "skipped",
              "Runtime does not support active-turn steering.",
            ),
          );
          continue;
        }
        const turn = await session.prompt(
          "Use your shell tool to wait 8 seconds, then answer ORIGINAL_STEERING_OUTPUT.",
          { requestId: `probe-steering-${Date.now()}` },
        );
        let observedActive = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const items = liveEvents.slice(eventStart);
          if (
            items.some(
              (event) =>
                event.type === "tool.started" ||
                event.type === "message.delta" ||
                event.type === "thought.delta" ||
                (event.type === "progress" && event.payload.stage === "turn/started"),
            )
          ) {
            observedActive = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        if (!observedActive)
          throw new Error("Steering probe did not observe an active Runtime turn.");
        await session.prompt("Change your answer now: reply with exactly STEERING_PROBE_OK_8172.", {
          requestId: `probe-steer-${Date.now()}`,
          mode: "steer",
        });
        const result = String(await turn.result);
        const passed = result.includes("STEERING_PROBE_OK_8172");
        recordObservation(paths.observations, {
          operation,
          output: result,
          events: liveEvents.slice(eventStart),
        });
        paths.assertions.push(
          assertion(
            "steering.executed",
            "steering",
            "executed",
            passed ? "passed" : "failed",
            passed
              ? "The original turn completed with the injected steering marker."
              : "The original turn did not include the steering marker.",
          ),
        );
        if (!passed) throw new Error("Steering did not affect the original turn output.");
        continue;
      }
      if (operation === "cancellation") {
        const turn = await session.prompt(
          "Use your shell tool to wait 120 seconds before answering.",
          { requestId: `probe-cancel-${Date.now()}` },
        );
        const settled = turn.result.then(
          () => {
            throw new Error("Cancellation probe completed instead of being cancelled.");
          },
          () => undefined,
        );
        for (let attempt = 0; attempt < 150; attempt++) {
          if (
            liveEvents
              .slice(eventStart)
              .some(
                (event) =>
                  event.type === "tool.started" ||
                  event.type === "thought.delta" ||
                  event.type === "message.delta",
              )
          )
            break;
          if (attempt === 149)
            throw new Error("Cancellation probe did not observe an active Runtime turn.");
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        await session.abort("Runtime cancellation probe");
        await settled;
        const events = liveEvents.slice(eventStart);
        const passed = events.some((event) => event.type === "run.cancelled");
        paths.assertions.push(
          assertion(
            "cancellation.executed",
            "cancellation",
            "executed",
            passed ? "passed" : "failed",
            passed ? "Observed run.cancelled." : "Cancellation produced no run.cancelled event.",
          ),
        );
        if (!passed) throw new Error("Cancellation produced no run.cancelled event.");
        continue;
      }

      const request = createProbePrompt(operation, paths, runtime.descriptor.kind);
      const turn = await session.prompt(request.prompt, {
        requestId: `probe-${operation}-${Date.now()}`,
        ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
      });
      const output = String(await turn.result);
      const events = liveEvents.slice(eventStart);
      const sessionState = await session.getState();
      const rootContext = sessionState.contexts[sessionState.rootContextId];
      const ownerPersistenceValidated =
        rootContext?.owner.type === "expert-session" &&
        rootContext.owner.ownerId === session.sessionId &&
        rootContext.origin.type === "expert-session" &&
        rootContext.origin.sessionId === session.sessionId &&
        rootContext.snapshot?.systemSessionId !== undefined;
      recordObservation(paths.observations, {
        operation,
        output,
        events: events.map(({ type, sequence, payload }) => ({ type, sequence, payload })),
      });
      const expectedToolNames =
        operation === "native-tool"
          ? [runtime.descriptor.kind === "claude-code-local" ? "Bash" : "list_dir"]
          : operation === "mcp"
            ? ["list_expert_context"]
            : [];
      const expectedMarkers = request.marker === undefined ? [] : [request.marker];
      const failures = inspectRuntimeObservationConformance(runtime, {
        events,
        outputText: output,
        expectedToolNames,
        expectedOutputMarkers: expectedMarkers,
        requiredFeatures: operationFeatures(operation),
        structuredOutputValidated: true,
        ownerPersistenceValidated,
      });
      if (operation === "mcp" || operation === "skills") {
        const feature = operation === "mcp" ? "mcp" : "skills";
        paths.assertions.push(
          assertion(
            `${feature}.materialized`,
            feature,
            "materialized",
            "passed",
            `${feature} Session resources were prepared.`,
          ),
          assertion(
            `${feature}.discovered`,
            feature,
            "discovered",
            failures.length === 0 ? "passed" : "failed",
            failures.length === 0
              ? `${feature} was discovered by the native Runtime.`
              : failures.map(({ message }) => message).join(" "),
          ),
        );
      }
      paths.assertions.push(
        assertion(
          `${operation}.executed`,
          probeFeature(operation),
          "executed",
          failures.length === 0 ? "passed" : "failed",
          failures.length === 0
            ? `${operation} probe completed.`
            : failures.map(({ message }) => message).join(" "),
        ),
      );
      if (failures.length > 0) throw new Error(failures.map(({ message }) => message).join(" "));

      if (operation === "resume") {
        await session.refreshRuntimeSessions();
        const resumed = await session.prompt(
          "Reply with RESUME_PROBE_OK_3187 and the exact prior marker RESUME_MEMORY_6249.",
          { requestId: `probe-resume-second-${Date.now()}` },
        );
        const resumedOutput = String(await resumed.result);
        const passed =
          resumedOutput.includes("RESUME_PROBE_OK_3187") &&
          resumedOutput.includes("RESUME_MEMORY_6249");
        paths.assertions.push(
          assertion(
            "resume.executed_after_refresh",
            "resume",
            "executed",
            passed ? "passed" : "failed",
            passed
              ? "Native Session identity resumed after refresh."
              : "The resumed turn did not recall the marker.",
          ),
        );
        if (!passed) throw new Error("The resumed turn did not recall the marker.");
      }
    }
  } catch (error) {
    if (!paths.assertions.some(({ status }) => status === "failed")) {
      paths.assertions.push(
        assertion(
          `${probe}.failed`,
          probeFeature(probe),
          "executed",
          "failed",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    recordObservation(paths.observations, {
      phase: "session-probe-failed",
      eventTypes: [...new Set(liveEvents.map(({ type }) => type))],
    });
    failures.push(error);
  }
  for (const [phase, close] of [
    ["session", async () => await session.close("Runtime probe completed.")],
    ["execution-store", async () => await executionStore.close?.()],
  ] as const) {
    try {
      await close();
    } catch (error) {
      paths.assertions.push(
        assertion(
          `${probe}.${phase}.cleanup.failed`,
          "cleanup",
          "executed",
          "failed",
          error instanceof Error ? error.message : String(error),
        ),
      );
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Runtime probe and cleanup failed.", { cause: failures[0] });
  }
}

function createProbePrompt(
  operation: string,
  paths: { readonly workspace: string; readonly filePath: string; readonly imagePath: string },
  runtimeKind: string,
): {
  readonly prompt: string;
  readonly marker?: string | undefined;
  readonly attachments?: readonly {
    readonly id: string;
    readonly kind: "image" | "file" | "directory";
    readonly name: string;
    readonly path: string;
    readonly mimeType?: string | undefined;
  }[];
} {
  switch (operation) {
    case "stream":
      return {
        prompt: "Write at least 160 words and finish with STREAM_PROBE_OK_1193.",
        marker: "STREAM_PROBE_OK_1193",
      };
    case "native-tool":
      return {
        prompt:
          runtimeKind === "claude-code-local"
            ? "Use your native Bash tool to list files in the current workspace, then reply NATIVE_TOOL_PROBE_OK_8821."
            : "Use the native list_dir tool on the current workspace, then reply NATIVE_TOOL_PROBE_OK_8821.",
        marker: "NATIVE_TOOL_PROBE_OK_8821",
      };
    case "mcp":
      return {
        prompt: "Call the managed list_expert_context MCP tool, then reply MCP_PROBE_OK_4412.",
        marker: "MCP_PROBE_OK_4412",
      };
    case "skills":
      return {
        prompt: "/pragma-runtime-probe Invoke this Skill and obey its exact marker instruction.",
        marker: "SKILL_PROBE_OK_7419",
      };
    case "attachments":
      return {
        prompt: "Confirm all three attachment paths and reply ATTACHMENT_PROBE_OK_5528.",
        marker: "ATTACHMENT_PROBE_OK_5528",
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "image",
            name: "runtime-probe.png",
            path: paths.imagePath,
            mimeType: "image/png",
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            kind: "file",
            name: "RUNTIME_PROBE_FILE.txt",
            path: paths.filePath,
            mimeType: "text/plain",
          },
          {
            id: "00000000-0000-4000-8000-000000000003",
            kind: "directory",
            name: "workspace",
            path: paths.workspace,
          },
        ],
      };
    case "resume":
      return {
        prompt: "Remember the exact marker RESUME_MEMORY_6249 and reply with it now.",
        marker: "RESUME_MEMORY_6249",
      };
    default:
      throw new Error(`Unsupported Session probe operation: ${operation}`);
  }
}

function assertion(
  id: string,
  feature: RuntimeFeatureName,
  stage: RuntimeProbeAssertion["stage"],
  status: RuntimeProbeAssertion["status"],
  message: string,
): RuntimeProbeAssertion {
  return { id, feature, stage, status, message };
}

function probeFeature(probe: (typeof probeNames)[number] | string): RuntimeFeatureName {
  switch (probe) {
    case "availability":
      return "availability";
    case "models":
      return "modelDiscovery";
    case "stream":
      return "textStreaming";
    case "native-tool":
      return "nativeToolLifecycle";
    case "mcp":
      return "mcp";
    case "skills":
      return "skills";
    case "attachments":
      return "attachmentImage";
    case "resume":
      return "resume";
    case "compaction":
      return "compaction";
    case "cancellation":
      return "cancellation";
    case "steering":
      return "steering";
    default:
      return "cleanup";
  }
}

function operationFeatures(operation: string): readonly RuntimeFeatureName[] {
  return operation === "attachments"
    ? ["attachmentImage", "attachmentFile", "attachmentDirectory"]
    : [probeFeature(operation)];
}

function readProbeSecrets(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(environment).flatMap(([name, value]) =>
    value !== undefined &&
    /(?:token|secret|password|api[-_]?key|authorization|credential)/i.test(name)
      ? [value]
      : [],
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function recordObservation(observations: string[], value: unknown): void {
  const serialized = JSON.stringify(value) ?? String(value);
  const limit = 16_000;
  observations.push(
    serialized.length <= limit
      ? serialized
      : `${serialized.slice(0, limit)}...[truncated ${serialized.length - limit} characters]`,
  );
}
