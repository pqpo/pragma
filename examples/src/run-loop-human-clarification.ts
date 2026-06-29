import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createLoopApp, defineFlow, defineHumanTask, defineTask } from "@expertmesh/core";
import { z } from "zod";

const app = createLoopApp();
const rl = createInterface({ input, output });

const ClarifierOutputSchema = z.object({
  status: z.enum(["needs_input", "ready"]),
  summary: z.string().optional(),
  questions: z
    .array(
      z.object({
        header: z.string(),
        question: z.string(),
        kind: z.enum(["single_choice", "multiple_choice", "text"]),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string(),
          }),
        ),
      }),
    )
    .default([]),
});

const AnswerSchema = z.object({
  answers: z.unknown(),
});

const flow = defineFlow({
  id: "human-clarification-loop",
  input: z.object({
    requirement: z.string(),
  }),
  output: z.object({
    summary: z.string(),
    answers: z.array(z.unknown()),
  }),
  result: ({ state }) => ({
    summary: String(state.results["summary"]),
    answers: state.messages,
  }),
});

const clarify = flow.use(
  "clarify",
  defineTask({
    id: "clarify-code",
    output: ClarifierOutputSchema,
    handler: ({ input, state }) => {
      const payload = z
        .object({
          requirement: z.string(),
        })
        .parse(input);

      if (state.messages.length === 0) {
        return {
          status: "needs_input" as const,
          questions: [
            {
              header: "User",
              question: "Who is the primary user for this requirement?",
              kind: "text" as const,
              options: [],
            },
          ],
        };
      }

      if (state.messages.length === 1) {
        return {
          status: "needs_input" as const,
          questions: [
            {
              header: "Acceptance",
              question: "What is the main acceptance criterion?",
              kind: "text" as const,
              options: [],
            },
          ],
        };
      }

      return {
        status: "ready" as const,
        summary: `Requirement: ${payload.requirement}. Clarified with ${state.messages.length} answer(s).`,
        questions: [],
      };
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.results["clarification"] = output;

      if (output.status === "ready") {
        state.results["summary"] = output.summary;
      }
    },
  },
);

const askUser = flow.use(
  "ask-user",
  defineHumanTask({
    id: "ask-user-question",
    output: AnswerSchema,
    request: ({ state }) => {
      const clarification = ClarifierOutputSchema.parse(state.results["clarification"]);
      return {
        kind: "question",
        title: "Clarify requirement",
        questions: clarification.questions,
      };
    },
  }),
  {
    reduce: ({ state, output }) => {
      state.messages.push(output.answers);
    },
  },
);

flow.compose(({ start, step, end, fail }) => {
  start(clarify)
    .route("status", {
      needs_input: askUser,
      ready: end(),
    })
    .limit({
      maxVisits: 5,
      onExceeded: fail("too-many-clarification-rounds"),
    });
  step(askUser).next(clarify);
});

const unsubscribe = await wireCliHumanResponder();

try {
  const result = await app.run(flow, {
    input: {
      requirement: process.argv.slice(2).join(" ") || "Add GitHub login",
    },
  });

  console.log("");
  console.log("Clarification complete");
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

      if (interaction === undefined || interaction.kind !== "question") {
        return;
      }

      const answers: Record<string, string> = {};

      for (const question of interaction.request.questions ?? []) {
        const answer = await rl.question(`${question.header}: ${question.question} `);
        answers[question.header] = answer;
      }

      await app.taskManager.respondToHumanInteraction({
        interactionId: interaction.id,
        response: {
          answers,
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
    readonly questions?: readonly {
      readonly header: string;
      readonly question: string;
    }[];
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
