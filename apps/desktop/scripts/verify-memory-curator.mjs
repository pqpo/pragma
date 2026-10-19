// Real PI + Memory acceptance. Sources, credentials and artifacts stay outside the repository.
import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { z } from "zod";
import { assessInjectedEvidenceRecovery } from "./memory-curator-acceptance-result.mjs";
import {
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  PragmaPaths,
  defaultRuntimeTokenCounter,
} from "@pragma/core";
import { createSqliteExecutionStore } from "@pragma/local-host";
import { createPiRuntime } from "@pragma/runtime-pi";
import {
  createBuiltInMemoryCurator,
  createMemoryCuratorTools,
  memoryCuratorResource,
  MEMORY_CURATOR_REF,
} from "@pragma/built-in-agents";
import { MemoryEvidenceEnvelopeSchema, MemorySubjectRefSchema } from "@pragma/shared";
import {
  createSemanticMemoryModule,
  createEpisodicMemoryModule,
  createConversationMemoryExtractionCoordinator,
  createExtractionMemoryReader,
  createFileMemoryExtractorProfileStore,
  redactMemoryProjection,
  MemoryExtractionFeedbackSchema,
} from "@pragma/memory";

const { values } = parseArgs({
  options: {
    cases: { type: "string" },
    "env-file": { type: "string" },
    repeat: { type: "string", default: "3" },
  },
});
if (!values.cases)
  throw Error(
    "Usage: node scripts/verify-memory-curator.mjs --cases /outside/repo/cases.json [--env-file /outside/repo/model.env] [--repeat 3]",
  );
if (values["env-file"]) loadEnvFile(values["env-file"]);
const caseSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/u),
    evidence: z.string(),
    subjects: z.array(MemorySubjectRefSchema).min(1),
    seedHome: z.string().optional(),
    exercise: z.boolean().default(false),
    injectInvalidEvidence: z.boolean().default(false),
    reserveAfterStaging: z.boolean().default(false),
  })
  .strict();
const cases = z
  .array(caseSchema)
  .min(1)
  .parse(JSON.parse(await readFile(values.cases, "utf8")));
const repeat = z.coerce.number().int().min(1).max(10).parse(values.repeat);
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw Error(`Missing ${name}`);
  return value;
};
const providerId = required("PRAGMA_MODEL_PROVIDER");
const modelId = required("PRAGMA_MODEL_NAME");
const api = process.env.PRAGMA_MODEL_API?.trim() || "openai-completions";
const definition = {
  id: providerId,
  catalogId: providerId,
  displayName: providerId,
  baseUrl: required("PRAGMA_MODEL_BASE_API"),
  api,
  models: [
    {
      kind: "generation",
      id: modelId,
      name: modelId,
      api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    },
  ],
};
const output = await mkdtemp(join(tmpdir(), "pragma-memory-acceptance-"));
await mkdir(output, { mode: 0o700, recursive: true });
console.log(`Artifacts: ${output}`);
const results = [];
for (const scenario of cases) {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const root = join(output, `${scenario.name}-${attempt}`);
    await mkdir(root, { mode: 0o700 });
    try {
      results.push(await run(scenario, root, attempt));
    } catch (error) {
      results.push({
        name: scenario.name,
        attempt,
        passed: false,
        code: error instanceof Error ? error.message : "probe_failed",
      });
    }
    await writePrivate(join(output, "report.json"), {
      providerId,
      modelId,
      runtime: "cloud-pi-agent",
      embedding: "disabled",
      results,
      unverified: [
        "positive vector search",
        "remote machine",
        "Electron UI",
        "other runtimes/models",
      ],
      coverage: [...new Set(results.flatMap((result) => result.tools ?? []))],
    });
    console.log(JSON.stringify(results.at(-1)));
  }
}
if (results.some((result) => !result.passed)) process.exitCode = 1;

async function writePrivate(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function run(scenario, pragmaHome, attempt) {
  if (scenario.seedHome) {
    for (const [module, filename] of [
      ["pragma.memory.semantic", "facts.sqlite"],
      ["pragma.memory.episodic", "episodes.sqlite"],
    ]) {
      const from = join(
        new PragmaPaths({ pragmaHome: resolve(scenario.seedHome) }).memoryModuleDataRoot(module),
        filename,
      );
      const to = join(new PragmaPaths({ pragmaHome }).memoryModuleDataRoot(module), filename);
      await mkdir(dirname(to), { recursive: true });
      const db = new DatabaseSync(from, { readOnly: true });
      try {
        await backup(db, to);
      } finally {
        db.close();
      }
    }
  }
  const source = await readFile(resolve(scenario.evidence), "utf8");
  const evidence = z
    .array(MemoryEvidenceEnvelopeSchema)
    .min(1)
    .parse(JSON.parse(source))
    .map((item) => ({
      ...item,
      payload: JSON.parse(redactMemoryProjection(JSON.stringify(item.payload))),
    }));
  const runtime = createPiRuntime({
    modelProviders: {
      listProviders: async () => [definition],
      resolveProvider: async (id) => {
        if (id !== providerId) throw Error("probe_provider_invalid");
        return {
          ...definition,
          apiKey: required("PRAGMA_MODEL_API_KEY"),
          credentialFingerprint: `acceptance:${providerId}`,
        };
      },
    },
  });
  const executionStore = createSqliteExecutionStore({ pragmaHome });
  const app = createPragma({
    executionStore,
    pragmaHome,
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
  });
  const calls = [];
  let admission = 0;
  let injectedAt;
  let sequence = 0;
  let reserveApplied = false;
  let extraction;
  let selectedRecords;
  let admittedTypes = [];
  const curator = createBuiltInMemoryCurator({
    pragmaHome,
    profiles: createFileMemoryExtractorProfileStore({ pragmaHome }),
    execution: {
      async run(input) {
        admission++;
        extraction = input.session;
        admittedTypes = await extraction.pendingTypes();
        selectedRecords = Number(/Available evidence: (\d+) records/u.exec(input.prompt)?.[1]);
        await extraction.setProvenance({
          curatorRef: MEMORY_CURATOR_REF,
          promptVersion: extraction.promptVersion,
          profileRevision: 0,
          runtimeId: runtime.descriptor.id,
          providerId,
          modelId,
          extractedAt: new Date().toISOString(),
        });
        await extraction.setContextBudget(116000);
        const tools = createMemoryCuratorTools(extraction).map((tool) => ({
          ...tool,
          async call(args, signal) {
            const actual =
              scenario.injectInvalidEvidence &&
              injectedAt === undefined &&
              tool.name.startsWith("submit_")
                ? { ...args, evidence: ["e999999"] }
                : args;
            const index = calls.length;
            const entry = {
              name: tool.name,
              args,
              actual,
              isError: false,
              sequenceStart: sequence++,
            };
            calls.push(entry);
            if (actual !== args) injectedAt = index;
            const result = await tool.call(actual, signal);
            Object.assign(entry, {
              sequenceEnd: sequence++,
              text: result.text,
              isError: result.isError ?? false,
              feedback: MemoryExtractionFeedbackSchema.safeParse(result.details).data,
            });
            if (
              scenario.reserveAfterStaging &&
              !reserveApplied &&
              tool.name === "get_extraction_status" &&
              entry.feedback?.progress?.unreadRecords === 0 &&
              entry.feedback.progress.stagedFacts > 0
            ) {
              const db = new DatabaseSync(
                new PragmaPaths({ pragmaHome }).memoryExtractionSessions(),
                { readOnly: true },
              );
              let used;
              try {
                const row = db
                  .prepare("SELECT state_json FROM sessions WHERE key = ?")
                  .get(extraction.key);
                used = JSON.parse(row.state_json).deliveredTokens;
              } finally {
                db.close();
              }
              await extraction.setContextBudget(used + 1024);
              reserveApplied = true;
            }
            await writePrivate(join(pragmaHome, "calls.json"), calls);
            console.log(
              JSON.stringify({
                case: scenario.name,
                attempt,
                call: index + 1,
                tool: tool.name,
                isError: result.isError ?? false,
              }),
            );
            return result;
          },
        }));
        const expert = await defineExpert({
          id: "0000000000mem0ry",
          name: "Memory Curator",
          description: "Real-data Memory acceptance",
          instructions: memoryCuratorResource(extraction.toolContractVersion).spec.instructions,
          tags: [],
          scope: "system-memory",
          workspace: pragmaHome,
          pragmaHome,
          models: { default: { model: { providerId, modelId } } },
          tools,
          toolPolicy: {
            allowedTools: tools.map((tool) => tool.name),
            deniedTools: ["askUserQuestion"],
          },
        });
        const session = await app.experts.createSession(expert, { runtime: runtime.descriptor.id });
        try {
          input.onAdmission?.();
          for (let turn = 0; turn < 4 && !(await extraction.completed()); turn++) {
            const exercise = scenario.exercise
              ? "\nAcceptance workflow (not source evidence): use list_evidence with directory=subjects, search existing memory in keyword and hybrid modes, enumerate properties/facts/episodes with list_existing_memory, and read a returned existing-memory handle if any. Inspect get_extraction_status and read_staged_candidate after staging before finishing. Resubmit one read candidate with its complete editable arguments and same candidate handle to verify correction, preserving supported meaning. Include attempts/recoveries only when source evidence supports them. Follow all pagination. Do not fabricate source content for coverage."
              : "";
            const task = await session.prompt(
              turn === 0 ? exercise + "\n\n" + input.prompt : await extraction.continuationPrompt(),
              { requestId: `acceptance-${attempt}-${turn}` },
            );
            const timeout = setTimeout(() => void session.abort("acceptance_timeout"), 10 * 60000);
            try {
              await task.result;
            } finally {
              clearTimeout(timeout);
            }
          }
          if (!(await extraction.completed()))
            throw Error(`probe_incomplete:${await extraction.failure()}`);
        } finally {
          await session.close("Memory acceptance completed");
        }
      },
    },
  });
  const semantic = await createSemanticMemoryModule({
    pragmaHome,
    extractor: curator.semanticExtractor,
  });
  const episodic = await createEpisodicMemoryModule({
    pragmaHome,
    extractor: curator.episodicExtractor,
  });
  const reader = createExtractionMemoryReader({
    semantic: semantic.store,
    episodic: episodic.store,
    assertAccess: async () => {},
  });
  semantic.setMemoryReader(reader);
  episodic.setMemoryReader(reader);
  const coordinator = createConversationMemoryExtractionCoordinator({
    pragmaHome,
    semantic,
    episodic,
  });
  coordinator.setExtractor(curator.conversationExtractor);
  try {
    const executions = [...new Set(evidence.map((item) => item.correlationId))];
    if (executions.some((id) => !id)) throw Error("probe_source_requires_execution_correlation");
    const conversationRef = evidence.find((item) => item.conversationRef)?.conversationRef ?? {
      type: "pragma.execution",
      id: executions[0],
    };
    for (const executionId of executions) {
      const item = evidence.find((entry) => entry.correlationId === executionId);
      const attributed = item.attribution
        ? [item.attribution.rootRef, ...item.attribution.producerRefs]
        : [];
      await semantic.registerExecutionSubjects({
        executionId,
        subjectRefs: [...scenario.subjects, ...attributed],
      });
      await semantic.bindExecutionConversation({ executionId, conversationRef, now: new Date() });
      await episodic.bindExecutionConversation({ executionId, conversationRef, now: new Date() });
    }
    await semantic.consume(evidence);
    await episodic.consume(evidence);
    await semantic.setConversationState({ conversationRef, state: "completed", now: new Date() });
    await episodic.setConversationState({ conversationRef, state: "completed", now: new Date() });
    const before = {
      facts: (await semantic.store.list()).length,
      episodes: (await episodic.store.list()).length,
    };
    await coordinator.runOnce();
    const jobs = [
      await semantic.store.listExtractionJobs(),
      await episodic.store.listExtractionJobs(),
    ]
      .flat()
      .map(({ status, completion, lastErrorCode }) => ({ status, completion, lastErrorCode }));
    await coordinator.runOnce();
    const restored = createBuiltInMemoryCurator({
      pragmaHome,
      profiles: createFileMemoryExtractorProfileStore({ pragmaHome }),
      execution: {
        async run() {
          throw Error("recovery_must_not_admit_model");
        },
      },
    });
    for (const [type, module] of [
      ["semantic", semantic],
      ["episodic", episodic],
    ]) {
      for (const job of await module.store.listExtractionJobs()) {
        if (!admittedTypes.includes(type)) continue; // Eligibility can reject locally before model admission.
        const receipt = await restored[`${type}Extractor`].recover(job.id, job.inputWatermark);
        if (!receipt) throw Error("probe_receipt_not_recoverable");
      }
    }
    const errors = calls.filter((call) => call.isError);
    const recovery = assessInjectedEvidenceRecovery(calls, injectedAt);
    const result = {
      name: scenario.name,
      attempt,
      passed:
        admission === 1 &&
        jobs.length > 0 &&
        jobs.every((job) => job.status === "completed") &&
        (!scenario.injectInvalidEvidence || recovery.verified) &&
        (!scenario.reserveAfterStaging ||
          (reserveApplied &&
            errors.some((call) => call.feedback?.code === "memory_curator_budget_exhausted"))),
      sourceHash: createHash("sha256").update(source).digest("hex"),
      sourceRecords: evidence.length,
      selectedRecords,
      sourceTokens: defaultRuntimeTokenCounter.countText(
        JSON.stringify(evidence.map((item) => item.payload)),
      ).tokens,
      admission,
      admittedTypes,
      reserveApplied,
      calls: calls.length,
      errors: errors.length,
      injected: injectedAt !== undefined,
      corrections: scenario.injectInvalidEvidence ? recovery.corrections : undefined,
      tools: [...new Set(calls.map((call) => call.name))],
      episodeParts: [
        ...new Set(
          calls
            .filter((call) => call.name === "submit_episode_part" && !call.isError)
            .map((call) => call.actual.part),
        ),
      ],
      before,
      after: {
        facts: (await semantic.store.list()).length,
        episodes: (await episodic.store.list()).length,
      },
      jobs,
    };
    await writePrivate(join(pragmaHome, "result.json"), result);
    return result;
  } finally {
    semantic.close();
    episodic.close();
    await executionStore.close?.();
  }
}
