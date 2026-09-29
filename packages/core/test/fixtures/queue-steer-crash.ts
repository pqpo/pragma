import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
  SteerNotDispatchedError,
  PragmaPaths,
  type RuntimeNativeSessionContext,
  withFileLock,
} from "../../src/index.ts";
import { createRuntimeTestFeatures } from "../../src/testing/index.ts";

interface FixtureSession {
  readonly context: RuntimeNativeSessionContext;
  readonly id: string;
}

const [mode, pragmaHome, sessionId, crashPhase] = process.argv.slice(2);
if (mode !== "seed" || pragmaHome === undefined || sessionId === undefined) {
  throw new Error("Usage: queue-steer-crash.ts seed <pragmaHome> <sessionId>");
}

const strictFallbackCrash = crashPhase === "strict-fallback";
const executionStore = createFileExecutionStore({ pragmaHome });
const sessionStore = createFileExpertSessionStore({ executions: executionStore, pragmaHome });
if (strictFallbackCrash) {
  const enqueue = sessionStore.enqueue.bind(sessionStore);
  sessionStore.enqueue = async (transaction, claimId) => {
    if (transaction.prompt.requestId === "redirect") {
      // The failed/not_dispatched strict record is durable, but fallback has not committed.
      process.stdout.write("fallback-ready\n");
      await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
      process.kill(process.pid, "SIGKILL");
      await new Promise<void>(() => undefined);
    }
    return await enqueue(transaction, claimId);
  };
}

const runtime = defineRuntimeDriver<never, FixtureSession>({
  features: createRuntimeTestFeatures({
    enabled: ["cancellation", "close", ...(strictFallbackCrash ? (["steering"] as const) : [])],
  }),
  descriptor: {
    id: "queue-steer-crash-runtime",
    kind: "fake",
    displayName: "Queue steer crash runtime",
  },
  createSession: async (context) => ({
    context,
    id: `native-${context.systemSessionId}`,
  }),
  restoreSession: (context) => ({
    context,
    id: context.request.runtimeSession!.id,
  }),
  readSession: (session) => ({ runtimeSessionId: session.id }),
  async startTurn() {
    // Keep the active turn durable while the parent process kills this owner
    // after the queue-steer reservation has been persisted.
    await new Promise<void>(() => undefined);
    return { outputText: "unreachable", runtimeSessionId: "unreachable" };
  },
  mapEvent: () => ({ events: [] }),
  ...(strictFallbackCrash
    ? {
        steerTurn: () => {
          throw new SteerNotDispatchedError("target_changed", "Native turn has ended.");
        },
      }
    : {}),
  cancelTurn: () => undefined,
  closeSession: () => undefined,
});

const app = createPragma({
  pragmaHome,
  executionStore,
  expertSessionStore: sessionStore,
  runtimes: createStaticRuntimeResolver({
    runtimes: [runtime],
    defaultRuntimeId: "queue-steer-crash-runtime",
  }),
});
const expert = await defineExpert({
  id: "queue-steer-crash-expert",
  name: "Queue steer crash expert",
  description: "Exercises durable queue steer recovery.",
  tags: [],
  scope: "test",
  workspace: pragmaHome,
});
const session = await app.experts.createSession(expert, { sessionId });
const active = await session.prompt("active", { requestId: "active" });
for (let attempt = 0; attempt < 100; attempt += 1) {
  if ((await session.getState()).activeExecutionId === active.executionId) break;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}
if ((await session.getState()).activeExecutionId !== active.executionId) {
  throw new Error("The fixture active turn did not start.");
}
const queued = await session.prompt("redirect", {
  requestId: "redirect",
  ...(strictFallbackCrash ? { mode: "steer" as const, steerFallback: "enqueue" as const } : {}),
});
await sessionStore.transact(sessionId, ({ session: record, prompts }) => {
  const current = prompts.find((prompt) => prompt.requestId === queued.requestId);
  if (current === undefined || record.activeExecutionId === undefined) {
    throw new Error("The fixture queued prompt is missing.");
  }
  const attemptId = "00000000-0000-4000-8000-000000000099";
  return {
    result: undefined,
    session: {
      ...record,
      queuedRequestIds: record.queuedRequestIds.filter((id) => id !== current.requestId),
      updatedAt: new Date().toISOString(),
    },
    prompts: prompts.map((prompt) =>
      prompt.requestId === current.requestId
        ? {
            ...prompt,
            status: "running" as const,
            error: undefined,
            deliveryAttempt: {
              attemptId,
              kind: "queue_steer" as const,
              sourceExecutionId: current.executionId,
              targetExecutionId: record.activeExecutionId!,
              state: "dispatching" as const,
            },
            updatedAt: new Date().toISOString(),
          }
        : prompt,
    ),
  };
});
process.stdout.write("marked\n");
if (crashPhase === undefined) {
  await new Promise<void>(() => undefined);
}

const paths = new PragmaPaths({ pragmaHome });
await withFileLock(
  paths.executionLock(active.executionId),
  async () => {
    process.stdout.write("release-ready\n");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  },
  {
    onPhase: (phase) => {
      if (phase === crashPhase) process.kill(process.pid, "SIGKILL");
    },
  },
);
