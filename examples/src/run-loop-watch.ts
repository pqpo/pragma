import { createPragma, defineFlow, defineTask } from "@pragma/core";
import { z } from "zod";

const app = createPragma();

const requirementLoop = defineFlow({
  id: "watch-requirement-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    summary: z.string(),
  }),
  result: ({ state }) => ({
    summary: String(state.results["summary"]),
  }),
});

const summarize = requirementLoop.use(
  "summarize",
  defineTask({
    id: "watch-summarize-code",
    handler: async ({ input, emitProgress }) => {
      const payload = z
        .object({
          requirement: z.string(),
        })
        .parse(input);

      await emitProgress(createProgressEvent("summarize", "Summarizing requirement."));
      await sleep(20);

      return `Plan for: ${payload.requirement}`;
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.results["summary"] = output;
    },
  },
);

requirementLoop.compose(({ start, end }) => {
  start(summarize).next(end());
});

const deliveryLoop = defineFlow({
  id: "watch-delivery-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    plan: z.string(),
    verification: z.string(),
  }),
  result: ({ state }) => ({
    plan: String(state.results["plan"]),
    verification: String(state.results["verification"]),
  }),
});

const intake = deliveryLoop.use(
  "intake",
  defineTask({
    id: "watch-intake-code",
    handler: async ({ emitProgress }) => {
      await emitProgress(createProgressEvent("intake", "Preparing nested loop."));
      await sleep(80);
      return "accepted";
    },
  }),
);

const plan = deliveryLoop.use("plan", requirementLoop, {
  reduce: ({ state, output }) => {
    state.results["plan"] = output.summary;
  },
});

const verify = deliveryLoop.use(
  "verify",
  defineTask({
    id: "watch-verify-code",
    handler: async ({ emitProgress }) => {
      await emitProgress(createProgressEvent("verify", "Verifying delivery plan."));
      await sleep(20);
      return "ready";
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.results["verification"] = output;
    },
  },
);

deliveryLoop.compose(({ start, step, end }) => {
  start(intake).next(plan).next(verify);
  step(verify).next(end());
});

const handle = await app.start(deliveryLoop, {
  input: {
    requirement: "Add loop run status and recursive watch APIs",
  },
});

const eventWatch = collectEvents(
  app.runs.watch(handle.workflowRunId, {
    recursive: true,
  }),
);
const outputWatch = collectEvents(
  app.runs.watchOutput(handle.workflowRunId, {
    recursive: true,
  }),
);

const running = await app.runs.get(handle.workflowRunId);
console.log("started", {
  workflowRunId: handle.workflowRunId,
  status: running?.workflow.status,
  activeSteps: running?.workflow.currentStepIds,
});

const result = await handle.result;
const [events, outputEvents, tree, succeededRuns] = await Promise.all([
  eventWatch,
  outputWatch,
  app.runs.getTree(handle.workflowRunId),
  app.runs.list({
    status: "succeeded",
  }),
]);

console.log("result", result.output);
console.log("run tree");
printRunTree(tree);
console.log("succeeded workflow runs", succeededRuns.map((run) => run.workflow.id));
console.log(
  "recursive event types",
  events.map((event) => `${event.workflowRunId}:${event.type}`),
);
console.log(
  "output/progress events",
  outputEvents.map((event) => `${event.workflowRunId}:${event.type}`),
);

async function collectEvents<TEvent>(events: AsyncIterable<TEvent>): Promise<TEvent[]> {
  const collected: TEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

function printRunTree(
  tree: Awaited<ReturnType<typeof app.runs.getTree>>,
  depth = 0,
): void {
  if (tree === undefined) {
    return;
  }

  const indent = "  ".repeat(depth);
  const taskSummary = Object.entries(tree.taskStatusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");

  console.log(`${indent}- ${tree.workflow.loopId} ${tree.workflow.status} (${taskSummary})`);

  for (const child of tree.children) {
    printRunTree(child, depth + 1);
  }
}

function createProgressEvent(stage: string, message: string) {
  return {
    schemaVersion: "pragma.stream/v1" as const,
    eventId: `example-${stage}-${Date.now()}`,
    sequence: 0,
    runId: "loop-watch-example",
    emittedAt: new Date().toISOString(),
    source: {
      kind: "runtime" as const,
      runId: "loop-watch-example",
      path: [],
    },
    type: "progress" as const,
    payload: {
      stage,
      message,
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
