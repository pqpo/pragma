import { defaultRuntimeTokenCounter } from "@pragma/core";
import { z } from "zod";
import { trimUtf8ToByteLimit } from "../../storage/utf8.ts";
import { MEMORY_ATTENTION_POLICY } from "../state.ts";
import { attentionCandidateKey, type MemoryDecisionProvider } from "../decision-provider.ts";

const AnswerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
  }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("score"),
    score: z.number().min(0).max(4),
    confidence: z.number().min(0).max(1),
  }),
]);
const ResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), AnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
type Question =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export class MemoryDecisionProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}
export function createJevDecisionProvider(options: {
  readonly getApiKey: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly beforeRequest?: (() => Promise<void>) | undefined;
}): MemoryDecisionProvider & { validate(): Promise<void> } {
  const budgets = new WeakMap<AbortSignal, { requests: number; tokens: number; bytes: number }>();
  const request = async (
    state: unknown,
    questions: Record<string, Question>,
    signal: AbortSignal,
    beforeRequest?: () => Promise<void>,
  ) => {
    const body = JSON.stringify({ model: "jev-latest", state, questions });
    if (Buffer.byteLength(body) > MEMORY_ATTENTION_POLICY.maxRequestBytes)
      throw new MemoryDecisionProviderError("attention_request_too_large", false);
    const key = await options.getApiKey();
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const budget = budgets.get(signal) ?? { requests: 0, tokens: 0, bytes: 0 };
      budget.requests++;
      budget.tokens += defaultRuntimeTokenCounter.countText(body).tokens;
      budget.bytes += Buffer.byteLength(body);
      budgets.set(signal, budget);
      if (budget.requests > 20 || budget.tokens > 40_000 || budget.bytes > 262_144)
        throw new MemoryDecisionProviderError("attention_budget_exhausted", false);
      await options.beforeRequest?.();
      await beforeRequest?.();
      signal.throwIfAborted();
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(MEMORY_ATTENTION_POLICY.requestTimeoutMs),
      ]);
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal: deadline,
        });
      } catch {
        if (signal.aborted) throw new MemoryDecisionProviderError("attention_cancelled", true);
        if (attempt === 0) {
          await abortableDelay(250, signal);
          continue;
        }
        throw new MemoryDecisionProviderError("attention_network_unavailable", true);
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        if (retryable && attempt === 0) {
          const retryAfter = response.headers.get("retry-after");
          const delay = retryAfter === null ? 250 : Math.max(250, Number(retryAfter) * 1_000);
          if (Number.isFinite(delay) && delay <= 3_000) {
            await abortableDelay(delay, signal);
            continue;
          }
        }
        throw new MemoryDecisionProviderError(
          response.status === 401
            ? "attention_auth_invalid"
            : retryable
              ? "attention_provider_unavailable"
              : "attention_request_invalid",
          retryable,
        );
      }
      // Read under the same deadline, and cap the response before parsing it.
      let bytes: Buffer;
      try {
        bytes = await readResponse(response, deadline);
      } catch (error) {
        if (signal.aborted) throw new MemoryDecisionProviderError("attention_cancelled", true);
        if (error instanceof MemoryDecisionProviderError) throw error;
        if (attempt === 0) {
          await abortableDelay(250, signal);
          continue;
        }
        throw new MemoryDecisionProviderError("attention_network_unavailable", true);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new MemoryDecisionProviderError("attention_response_invalid", false);
      }
      const parsed = ResponseSchema.safeParse(raw);
      if (
        !parsed.success ||
        Object.keys(questions).some(
          (key) => parsed.data.answers[key]?.type !== questions[key]?.type,
        )
      )
        throw new MemoryDecisionProviderError("attention_response_invalid", false);
      return parsed.data.answers;
    }
  };
  const noul = (answers: z.infer<typeof ResponseSchema>["answers"], key: string) => {
    const answer = answers[key];
    if (answer?.type !== "noul")
      throw new MemoryDecisionProviderError("attention_response_invalid", false);
    return answer.noul;
  };
  return {
    async chooseExpansion(input, signal, beforeRequest) {
      if (input.actions.length === 0) return undefined;
      const answers = await request(
        {
          ...input,
          candidates: input.candidates.map((candidate) => ({
            ...candidate,
            summary: trimUtf8ToByteLimit(candidate.summary, 160),
            title: trimUtf8ToByteLimit(candidate.title, 120),
          })),
        },
        {
          continue: {
            type: "noul",
            instructions:
              "Would reading another detail or an authorized relation meaningfully improve this memory selection?",
          },
          next: {
            type: "choice",
            instructions:
              "Select one provided action. Choose stop if none has sufficient value; never invent an action.",
            criteria: {
              stop: "Finish with the current selection",
              ...Object.fromEntries(
                input.actions.map((action) => [
                  action.id,
                  `${action.kind} of ${action.candidateKey}`,
                ]),
              ),
            },
          },
        },
        signal,
        beforeRequest,
      );
      const next = answers["next"];
      if (
        next?.type !== "choice" ||
        !(next.choice === "stop" || input.actions.some((action) => action.id === next.choice))
      )
        throw new MemoryDecisionProviderError("attention_response_invalid", false);
      if (noul(answers, "continue") < 0.65 || next.choice === "stop") return undefined;
      return next.choice;
    },
    async validate() {
      await request(
        "The word is hello.",
        { valid: { type: "noul", instructions: "Is the word hello?" } },
        new AbortController().signal,
      );
    },
    async assessRecall(input, signal, beforeRequest) {
      const answers = await request(
        input,
        {
          recall: {
            type: "noul",
            instructions: "Could historical memory help with the new task observation?",
          },
          episodic: {
            type: "noul",
            instructions: "Could a previous failure, recovery or execution experience help?",
          },
          semantic: {
            type: "noul",
            instructions: "Could existing factual beliefs help with this observation?",
          },
        },
        signal,
        beforeRequest,
      );
      return {
        recall: noul(answers, "recall"),
        episodic: noul(answers, "episodic"),
        semantic: noul(answers, "semantic"),
      };
    },
    async assessCandidates(input, signal, beforeRequest) {
      const results: { key: string; relevance: number; novelty: number; confidence: number }[] = [];
      for (let offset = 0; offset < input.candidates.length; offset += 4) {
        const candidates = input.candidates.slice(offset, offset + 4).map((candidate) => ({
          ...candidate,
          summary: trimUtf8ToByteLimit(candidate.summary, 2000),
        }));
        const questions: Record<string, Question> = {};
        candidates.forEach((_candidate, index) => {
          questions[`relevance_${index}`] = {
            type: "score",
            instructions: `How relevant is candidates[${index}] to the current delta?`,
            criteria: [
              "Unrelated",
              "Weak connection",
              "Somewhat relevant",
              "Highly relevant",
              "Directly applicable",
            ],
          };
          questions[`novelty_${index}`] = {
            type: "noul",
            instructions: `Does candidates[${index}] provide useful information beyond the active memory?`,
          };
        });
        const answers = await request(
          {
            delta: input.delta,
            active: input.active.map(({ module, memoryId, revision }) => ({
              module,
              memoryId,
              revision,
            })),
            candidates,
          },
          questions,
          signal,
          beforeRequest,
        );
        candidates.forEach((candidate, index) => {
          const answer = answers[`relevance_${index}`];
          if (answer?.type !== "score")
            throw new MemoryDecisionProviderError("attention_response_invalid", false);
          results.push({
            key: attentionCandidateKey(candidate),
            relevance: answer.score / 4,
            confidence: answer.confidence,
            novelty: noul(answers, `novelty_${index}`),
          });
        });
      }
      return results;
    },
    async assessAttention(input, signal, beforeRequest) {
      return (
        noul(
          await request(
            {
              delta: input.delta,
              previous: input.previous.map(({ module, memoryId, revision, reason }) => ({
                module,
                memoryId,
                revision,
                reason,
              })),
              next: input.next.map(({ module, memoryId, revision, reason }) => ({
                module,
                memoryId,
                revision,
                reason,
              })),
              // The transition may contain 16 references. This final significance check
              // needs less detail than individual relevance assessment and has its own budget.
              candidates: input.candidates.map((candidate) => ({
                ...candidate,
                title: trimUtf8ToByteLimit(candidate.title, 120),
                summary: trimUtf8ToByteLimit(candidate.summary, 400),
              })),
            },
            {
              changed: {
                type: "noul",
                instructions:
                  "Has the useful historical context materially changed between previous and next?",
              },
            },
            signal,
            beforeRequest,
          ),
          "changed",
        ) >= 0.65
      );
    },
  };
}
async function abortableDelay(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new MemoryDecisionProviderError("attention_cancelled", true));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new MemoryDecisionProviderError("attention_response_invalid", false);
  signal.throwIfAborted();
  let rejectAbort!: (error: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    rejectAbort(signal.reason);
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536)
        throw new MemoryDecisionProviderError("attention_response_invalid", false);
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
