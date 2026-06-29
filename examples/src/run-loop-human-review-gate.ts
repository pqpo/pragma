import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createLoopApp, defineFlow, defineHumanTask, defineTask } from "@expertmesh/core";
import { z } from "zod";

const app = createLoopApp();
const rl = createInterface({ input, output });

const ReviewDecisionSchema = z.object({
  decision: z.enum(["approved", "request_changes", "manual_patch"]),
  notes: z.string().optional(),
  data: z.unknown().optional(),
});

const flow = defineFlow({
  id: "human-review-gate-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    status: z.string(),
    changedFiles: z.array(z.string()),
    reviewHistory: z.array(z.unknown()),
  }),
  result: ({ state }) => ({
    status: "approved",
    changedFiles: z.array(z.string()).parse(state.artifacts["changedFiles"]),
    reviewHistory: z.array(z.unknown()).parse(state.results["reviewHistory"]),
  }),
});

const coder = flow.use(
  "coder",
  defineTask({
    id: "coder-code",
    output: z.object({
      summary: z.string(),
      changedFiles: z.array(z.string()),
      revision: z.number(),
    }),
    handler: ({ input, state }) => {
      const payload = z
        .object({
          requirement: z.string(),
        })
        .parse(input);
      const revision = Number(state.metrics["coderRevision"] ?? 0) + 1;

      return {
        summary: `Revision ${revision}: implemented ${payload.requirement}`,
        changedFiles: ["src/auth.ts", "test/auth.test.ts"],
        revision,
      };
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.artifacts["codeChange"] = output;
      state.artifacts["changedFiles"] = output.changedFiles;
      state.metrics["coderRevision"] = output.revision;
    },
  },
);

const verify = flow.use(
  "verify",
  defineTask({
    id: "verify-code",
    output: z.object({
      passed: z.boolean(),
      summary: z.string(),
    }),
    handler: ({ state }) => {
      const revision = Number(state.metrics["coderRevision"] ?? 0);
      const hasManualPatch = state.artifacts["manualPatch"] !== undefined;
      const passed = revision >= 2 || hasManualPatch;

      return {
        passed,
        summary: passed
          ? "Verification passed."
          : "Verification found missing acceptance coverage.",
      };
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.results["verification"] = output;
    },
  },
);

const review = flow.use(
  "human-review",
  defineHumanTask({
    id: "human-review-gate",
    output: ReviewDecisionSchema,
    request: ({ state }) => ({
      kind: "review_gate",
      title: "Review implementation",
      prompt: "Choose whether to approve, request changes, or record a manual patch.",
      options: [
        { label: "approved", description: "Continue to the next flow step" },
        { label: "request_changes", description: "Send feedback back to the coder" },
        { label: "manual_patch", description: "Record a manual edit and verify again" },
      ],
      data: {
        codeChange: state.artifacts["codeChange"],
        verification: state.results["verification"],
      },
    }),
  }),
  {
    reduce: ({ state, output }) => {
      const history = Array.isArray(state.results["reviewHistory"])
        ? state.results["reviewHistory"]
        : [];
      state.results["reviewHistory"] = [...history, output];

      if (output.decision === "manual_patch") {
        state.artifacts["manualPatch"] = output.data ?? {
          note: output.notes ?? "Manual patch recorded.",
        };
      }
    },
  },
);

flow.compose(({ start, step, end, fail }) => {
  start(coder)
    .next(verify)
    .next(review)
    .route("decision", {
      approved: end(),
      request_changes: coder,
      manual_patch: verify,
    });
  step(coder).limit({
    maxVisits: 3,
    onExceeded: fail("too-many-code-revisions"),
  });
  step(review).limit({
    maxVisits: 5,
    onExceeded: fail("review-not-approved"),
  });
});

const unsubscribe = await wireCliHumanResponder();

try {
  const result = await app.run(flow, {
    input: {
      requirement: process.argv.slice(2).join(" ") || "Add GitHub login",
    },
  });

  console.log("");
  console.log("Review gate complete");
  console.log(JSON.stringify(result.output, null, 2));
} finally {
  await unsubscribe();
  rl.close();
}

async function wireCliHumanResponder(): Promise<() => Promise<void>> {
  const subscription = await app.mailbox.subscribe(
    {
      types: ["human.requested"],
    },
    async (message) => {
      const interaction = readInteraction(message.payload);

      if (interaction === undefined || interaction.kind !== "review_gate") {
        return;
      }

      console.log("");
      console.log(interaction.request.title ?? "Review");
      console.log(JSON.stringify(interaction.request.data, null, 2));
      console.log("1. approve");
      console.log("2. request changes");
      console.log("3. manual patch");

      const choice = (await rl.question("Choose [1/2/3]: ")).trim();
      const notes = await rl.question("Notes: ");
      const decision =
        choice === "1" ? "approved" : choice === "3" ? "manual_patch" : "request_changes";

      await app.taskManager.respondToHumanInteraction({
        interactionId: interaction.id,
        response: {
          decision,
          ...(notes.length === 0 ? {} : { notes }),
          ...(decision === "manual_patch"
            ? {
                data: {
                  note: notes.length === 0 ? "Manual patch from CLI." : notes,
                },
              }
            : {}),
        },
        operator: {
          id: "cli-user",
          kind: "user",
        },
      });
    },
  );

  return async () => {
    await subscription.unsubscribe();
  };
}

interface CliHumanInteraction {
  readonly id: string;
  readonly kind: string;
  readonly request: {
    readonly title?: string | undefined;
    readonly data?: unknown;
  };
}

function readInteraction(payload: unknown): CliHumanInteraction | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }

  const interaction = (payload as Record<string, unknown>)["interaction"];
  return interaction === null || typeof interaction !== "object"
    ? undefined
    : (interaction as CliHumanInteraction);
}
