import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ContextSystem,
  PragmaPaths,
  withFileLock,
  createPragmaLogger,
  defineExpert,
  type PragmaLoggerProvider,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";
import {
  EpisodicExtractionOutputSchema,
  SemanticExtractionOutputSchema,
  MEMORY_CURATOR_ID,
  MEMORY_CURATOR_PROMPT_VERSION,
  SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
  KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION,
  SKILL_MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_REF,
  DEFAULT_MEMORY_STORAGE_POLICY,
  selectBoundedMemoryEvidence,
  mergeMemoryEvidenceOmissionStats,
  type EpisodicMemoryExtractor,
  type KnowledgeMemoryExtractor,
  type SemanticMemoryExtractor,
  type SkillMemoryExtractor,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
} from "@pragma/memory";
import { KnowledgeExtractionOutputSchema } from "@pragma/shared";
import { SkillExtractionOutputSchema } from "@pragma/shared";

import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { z } from "zod";

const CuratorMissionRegistrySchema = z.object({
  schemaVersion: z.literal("pragma.memory-curator-mission-registry/v1"),
  entries: z
    .array(
      z.object({
        missionId: z.string().uuid(),
        jobId: z.string().min(1),
        createdAt: z.string().datetime(),
      }),
    )
    .max(DEFAULT_MEMORY_STORAGE_POLICY.curatorRegistryMaxEntries),
});

export interface DesktopMemoryCurator {
  readonly episodicExtractor: EpisodicMemoryExtractor;
  readonly semanticExtractor: SemanticMemoryExtractor;
  readonly knowledgeExtractor: KnowledgeMemoryExtractor;
  readonly skillExtractor: SkillMemoryExtractor;
  compile(input: {
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(): Promise<string>;
  recoverOrphans(): Promise<number>;
}

export function createDesktopMemoryCurator(options: {
  readonly profiles: MemoryExtractorProfileStore;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly workspace: string;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly now?: (() => Date) | undefined;
}): DesktopMemoryCurator {
  const logger = createPragmaLogger(options.loggerProvider, {
    component: "desktop.memory-curator",
  });
  const now = options.now ?? (() => new Date());

  const resolveRuntime = async (
    profile: MemoryExtractorProfile,
    runtimes: RuntimeResolver = options.runtimes,
  ) => {
    if (
      profile.mode === "pinned" &&
      (profile.runtimeId === undefined ||
        profile.providerId === undefined ||
        profile.modelId === undefined)
    ) {
      throw new Error("memory_extractor_profile_invalid");
    }
    const runtimeId: string =
      profile.mode === "pinned" ? profile.runtimeId! : await runtimes.getDefaultRuntimeId();
    const requested: RuntimeModelSelection | undefined =
      profile.mode === "pinned"
        ? {
            model: { providerId: profile.providerId!, modelId: profile.modelId! },
            ...(profile.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: profile.thinkingLevel }),
          }
        : undefined;
    const resolved = await runtimes.bind({
      runtimeId,
      ...(requested === undefined ? {} : { modelSelection: requested }),
    });
    let modelSelection: RuntimeModelSelection | undefined = requested;
    if (modelSelection === undefined) {
      const models = await resolved.adapter.listModels?.();
      const model = models?.find((candidate) => candidate.default === true) ?? models?.[0];
      if (model !== undefined) {
        modelSelection = { model: { providerId: model.provider.id, modelId: model.id } };
      }
    }
    return { profile, runtimeId, resolved, modelSelection };
  };

  const compile = async (input: {
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<CompiledResource<InvocableResource>> => {
    const runtime = await resolveRuntime(await options.profiles.get(), input.runtimes);
    const expert = await defineExpert({
      schemaVersion: "pragma.expert/v1",
      id: MEMORY_CURATOR_ID,
      name: "Memory Curator",
      description: "Hidden system Expert that extracts structured long-term Memory.",
      scope: "system-memory",
      tags: ["system", "memory", "curator"],
      instructions: CURATOR_INSTRUCTIONS,
      workspace: input.workspace,
      pragmaHome: input.pragmaHome,
      defaultRuntimeId: runtime.runtimeId,
      ...(runtime.modelSelection === undefined
        ? {}
        : { models: { default: runtime.modelSelection } }),
      contextSystem: new ContextSystem(),
      tools: [],
      loggerProvider: input.loggerProvider,
    });
    const fingerprint = await createFingerprint(runtime.profile);
    return {
      ref: MEMORY_CURATOR_REF,
      value: expert,
      fingerprint,
      projectFingerprint: fingerprint,
      environmentFingerprint: {
        environmentId: "desktop",
        projectFingerprint: fingerprint,
        value: fingerprint,
        resources: [],
        plugins: [],
      },
      rootRuntimeId: runtime.runtimeId,
      dependencies: [],
    };
  };

  return {
    compile,
    async recoverOrphans() {
      await removeStaleCuratorTemps(options.pragmaHome);
      const entries = await readCuratorMissionRegistry(options.pragmaHome);
      let recovered = 0;
      for (const entry of entries.slice(0, 100)) {
        let mission;
        try {
          mission = await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found") {
            await unregisterCuratorMission(options.pragmaHome, entry.missionId);
            continue;
          }
          logger.warn(
            "desktop.memory_curator_orphan_read_failed",
            "A registered Memory Curator Mission could not be inspected and was retained for retry.",
            { error, missionId: entry.missionId },
          );
          continue;
        }
        const terminal =
          mission.execution !== undefined &&
          ["succeeded", "failed", "cancelled"].includes(mission.execution.status);
        const stale =
          Date.now() - Date.parse(entry.createdAt) >=
          DEFAULT_MEMORY_STORAGE_POLICY.curatorOrphanGraceMs;
        if (!terminal && !stale) continue;
        if (await cleanupCuratorMission(options.runner, entry.missionId)) {
          await unregisterCuratorMission(options.pragmaHome, entry.missionId);
          recovered += 1;
        }
      }
      return recovered;
    },
    async fingerprint() {
      return await createFingerprint(await options.profiles.get());
    },
    episodicExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const runtime = await resolveRuntime(profile);
        const content = await runCuratorMission({
          options,
          runtime,
          jobId: input.jobId,
          title: `Memory extraction ${input.executionId.slice(0, 12)}`,
          goal: renderExtractionPrompt(input),
          signal: extractionOptions?.signal,
        });
        const output = EpisodicExtractionOutputSchema.parse(JSON.parse(extractJson(content)));
        return {
          output,
          provenance: {
            curatorRef: MEMORY_CURATOR_REF,
            promptVersion: MEMORY_CURATOR_PROMPT_VERSION,
            profileRevision: profile.revision,
            runtimeId: runtime.runtimeId,
            providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
            modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
            extractedAt: now().toISOString(),
          },
        };
      },
    },
    semanticExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const runtime = await resolveRuntime(profile);
        const content = await runCuratorMission({
          options,
          runtime,
          jobId: input.jobId,
          title: `Semantic extraction ${input.executionId.slice(0, 12)}`,
          goal: renderSemanticExtractionPrompt(input),
          signal: extractionOptions?.signal,
        });
        const output = SemanticExtractionOutputSchema.parse(JSON.parse(extractJson(content)));
        return {
          output,
          provenance: {
            curatorRef: MEMORY_CURATOR_REF,
            promptVersion: SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
            profileRevision: profile.revision,
            runtimeId: runtime.runtimeId,
            providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
            modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
            extractedAt: now().toISOString(),
          },
        };
      },
    },
    knowledgeExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const runtime = await resolveRuntime(profile);
        const content = await runCuratorMission({
          options,
          runtime,
          jobId: input.jobId,
          title: `Knowledge extraction ${input.rootRef.id.slice(0, 12)}`,
          goal: renderKnowledgeExtractionPrompt(input),
          signal: extractionOptions?.signal,
        });
        const output = KnowledgeExtractionOutputSchema.parse(JSON.parse(extractJson(content)));
        return {
          output,
          provenance: {
            curatorRef: MEMORY_CURATOR_REF,
            promptVersion: KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION,
            profileRevision: profile.revision,
            runtimeId: runtime.runtimeId,
            providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
            modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
            extractedAt: now().toISOString(),
          },
        };
      },
    },
    skillExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const runtime = await resolveRuntime(profile);
        const content = await runCuratorMission({
          options,
          runtime,
          jobId: input.jobId,
          title: `Skill extraction ${input.rootRef.id.slice(0, 12)}`,
          goal: renderSkillExtractionPrompt(input),
          signal: extractionOptions?.signal,
        });
        const output = SkillExtractionOutputSchema.parse(JSON.parse(extractJson(content)));
        return {
          output,
          provenance: {
            curatorRef: MEMORY_CURATOR_REF,
            promptVersion: SKILL_MEMORY_CURATOR_PROMPT_VERSION,
            profileRevision: profile.revision,
            runtimeId: runtime.runtimeId,
            providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
            modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
            extractedAt: now().toISOString(),
          },
        };
      },
    },
  };
}

const CURATOR_INSTRUCTIONS = [
  "You are the hidden Pragma Memory Curator.",
  "You have no tools and must not request additional context.",
  "Extract only claims supported by the supplied Evidence ids.",
  "A tool event with hidden input or output proves only that the call occurred; never infer hidden content from its name or status.",
  "Return exactly one JSON object matching the requested schema, without Markdown fences or commentary.",
  "Use the dominant language of the source task. Historical precedent is not current truth.",
].join("\n");

function renderExtractionPrompt(input: Parameters<EpisodicMemoryExtractor["extract"]>[0]): string {
  return renderBoundedPrompt(input.evidence, input.omittedEvidence, (retained, omissions) =>
    [
      "Extract an Episodic Memory from this safe Evidence projection.",
      "Return retain=false for low-value or insufficient evidence.",
      "Every goal, summary, attempt, failure/recovery, and outcome must cite one or more supplied messageId values in evidenceRefs.",
      "Output schema:",
      '{"retain":true,"language":"zh-Hans","goal":{"text":"...","evidenceRefs":["..."]},"summary":{"text":"...","evidenceRefs":["..."]},"attempts":[{"description":"...","result":"...","evidenceRefs":["..."]}],"failuresAndRecoveries":[{"failure":"...","recovery":"...","evidenceRefs":["..."]}],"outcome":{"status":"succeeded|failed|cancelled|interrupted","summary":"...","evidenceRefs":["..."]},"valueScore":0.0}',
      'or {"retain":false,"reason":"low-value|insufficient-evidence|sensitive"}.',
      "Evidence:",
      JSON.stringify(retained),
      "Omitted Evidence statistics (no omitted content):",
      JSON.stringify(omissions),
    ].join("\n\n"),
  );
}

function renderSemanticExtractionPrompt(
  input: Parameters<SemanticMemoryExtractor["extract"]>[0],
): string {
  return renderBoundedPrompt(input.evidence, input.omittedEvidence, (retained, omissions) =>
    [
      "Extract current Semantic/Fact Memory from this safe Evidence projection.",
      "Return retain=false when there is no stable, reusable fact. Do not turn historical outcomes into current truth.",
      "Use only exact entries from allowedSubjectRefs and supplied messageId values. Never invent a subject id or Evidence id.",
      "Use a namespaced predicate. normalizedValue must be a concise canonical value for deduplication.",
      "Use conflictMode=exclusive only when the subject can have one current value for that predicate; otherwise use compatible.",
      "When a direct user message unambiguously changes an existing exclusive fact, set replacementTarget to that current fact id and revision. Never replace a fact based only on assistant, tool, or summary text.",
      "Confidence must be between 0 and 0.95. Only include reviewAt or expiresAt when Evidence explicitly supports that time.",
      "Output schema:",
      '{"retain":true,"facts":[{"statement":"...","subjectRefs":[{"type":"pragma.user","id":"..."}],"predicate":"user.preference.language","normalizedValue":"zh-Hans","conflictMode":"exclusive|compatible","confidence":0.0,"evidenceRefs":["..."],"replacementTarget":{"factId":"optional current fact id","expectedRevision":1},"reviewAt":"optional ISO time","expiresAt":"optional ISO time"}]}',
      'or {"retain":false,"reason":"no-stable-fact|insufficient-evidence|sensitive"}.',
      "Allowed subjects:",
      JSON.stringify(input.allowedSubjectRefs),
      "Current exclusive facts eligible for an explicit replacement:",
      JSON.stringify(input.currentFacts),
      "Evidence:",
      JSON.stringify(retained),
      "Omitted Evidence statistics (no omitted content):",
      JSON.stringify(omissions),
    ].join("\n\n"),
  );
}

function renderKnowledgeExtractionPrompt(
  input: Parameters<KnowledgeMemoryExtractor["extract"]>[0],
): string {
  const prompt = [
    "Extract reusable Knowledge candidates from these already-curated Memory source revisions.",
    "Candidates are proposals for human review, not automatically published instructions.",
    "Each candidate must cite exact supplied sourceRefs. It is eligible only with two distinct source revisions, one verified Semantic source, or one Episodic source with valueScore at least 0.85.",
    "normalizedKey must be a stable lowercase root-scoped deduplication key using only letters, numbers, dot, underscore, colon, slash, or hyphen.",
    "Keep guidance concrete and reusable. Do not invent facts, identifiers, permissions, or provenance.",
    "Output schema:",
    '{"retain":true,"candidates":[{"content":{"title":"...","summary":"...","guidance":["..."],"normalizedKey":"workflow.example"},"sourceRefs":[{"kind":"episodic|semantic","id":"...","revision":1}]}]}',
    'or {"retain":false,"reason":"no-reusable-knowledge|insufficient-sources|sensitive"}.',
    "Root:",
    JSON.stringify(input.rootRef),
    "Sources:",
    JSON.stringify(input.sources),
  ].join("\n\n");
  if (Buffer.byteLength(prompt) > DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes) {
    throw new Error("memory_curator_prompt_metadata_too_large");
  }
  return prompt;
}

function renderSkillExtractionPrompt(
  input: Parameters<SkillMemoryExtractor["extract"]>[0],
): string {
  const prompt = [
    "Extract at most three complete, reusable Skill candidates from these curated Memory sources.",
    "A Skill is a coherent executable workflow, not a fact, isolated tip, command fragment, or one-off success. Merge related steps into one Skill and return retain=false when the pattern is fragmentary.",
    "Every candidate must cite at least three distinct high-value Episodic ids across at least two conversations; at least two must have succeeded or recovered successfully. Semantic sources may support but never satisfy this threshold.",
    "Generate SKILL.md plus optional references/*.md. Scripts are optional and must be dependency-free Node 22 ESM under scripts/*.mjs with node:test coverage under tests/*.test.mjs.",
    "For each candidate create at least three source replay expectations and one clearly non-applicable boundary case.",
    "Compare only existingTargets. Use revise only for one clear match, ambiguous for two or more plausible matches, otherwise create. Never invent a binding id.",
    "Output schema:",
    '{"retain":true,"candidates":[{"content":{"normalizedKey":"workflow.example","applicability":["..."],"failureModes":["..."],"recoverySteps":["..."],"package":{"name":"...","description":"...","files":[{"path":"SKILL.md","content":"---\\nname: ...\\ndescription: ...\\n---\\n..."}]},"replayCases":[{"objective":"...","requiredBehaviors":["..."],"forbiddenBehaviors":[]}],"boundaryCase":{"objective":"...","requiredBehaviors":["recognize non-applicability"],"forbiddenBehaviors":["force the workflow"]}},"sourceRefs":[{"kind":"episodic","id":"...","revision":1}],"route":{"type":"create|revise|ambiguous","bindingId":"for revise","bindingIds":["for ambiguous"]}}]}',
    'or {"retain":false,"reason":"no-reusable-skill|insufficient-independent-sources|fragmentary-pattern|sensitive"}.',
    "Root:", JSON.stringify(input.rootRef),
    "Existing Memory Skills:", JSON.stringify(input.existingTargets),
    "Sources:", JSON.stringify(input.sources),
  ].join("\n\n");
  if (Buffer.byteLength(prompt) > DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes) {
    throw new Error("memory_curator_prompt_metadata_too_large");
  }
  return prompt;
}

function renderBoundedPrompt(
  evidence: Parameters<EpisodicMemoryExtractor["extract"]>[0]["evidence"],
  persistentOmissions: Parameters<EpisodicMemoryExtractor["extract"]>[0]["omittedEvidence"],
  render: (
    retained: readonly import("@pragma/shared").MemoryEvidenceEnvelope[],
    omissions: Parameters<EpisodicMemoryExtractor["extract"]>[0]["omittedEvidence"],
  ) => string,
): string {
  let evidenceBudget = DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes;
  for (;;) {
    const selected = selectBoundedMemoryEvidence(evidence, {
      maxRecords: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxRecordsPerExecution,
      maxBytes: evidenceBudget,
    });
    const prompt = render(
      selected.retained,
      mergeMemoryEvidenceOmissionStats(persistentOmissions, selected.omittedStats),
    );
    const overflow =
      Buffer.byteLength(prompt) - DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes;
    if (overflow <= 0) return prompt;
    if (evidenceBudget === 0) throw new Error("memory_curator_prompt_metadata_too_large");
    evidenceBudget = Math.max(0, evidenceBudget - overflow - 512);
  }
}

async function runCuratorMission(input: {
  readonly options: Pick<
    Parameters<typeof createDesktopMemoryCurator>[0],
    "project" | "missions" | "runner" | "workspace" | "pragmaHome" | "loggerProvider"
  >;
  readonly runtime: {
    readonly runtimeId: string;
    readonly modelSelection?: RuntimeModelSelection | undefined;
  };
  readonly jobId: string;
  readonly title: string;
  readonly goal: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const project = await input.options.project.ensurePublished();
  const mission = await input.options.missions.create({
    workspace: {
      path: input.options.workspace,
      basename: basename(input.options.workspace),
    },
    goal: input.goal,
    title: input.title,
    project: { id: project.projectId, revision: project.revision },
    executor: { kind: "expert", ref: MEMORY_CURATOR_REF, name: "Memory Curator" },
    origin: { type: "system-memory", jobId: input.jobId },
    toolPermissionMode: "request-approval",
    ...(input.runtime.modelSelection === undefined
      ? {}
      : {
          modelOverride: {
            providerId: input.runtime.modelSelection.model.providerId,
            modelId: input.runtime.modelSelection.model.modelId,
            ...(input.runtime.modelSelection.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: input.runtime.modelSelection.thinkingLevel }),
          },
        }),
  });
  const pragmaHome = input.options.pragmaHome;
  const logger = createPragmaLogger(input.options.loggerProvider, {
    component: "desktop.memory-curator",
  });
  await registerCuratorMission(pragmaHome, mission.id, input.jobId);
  const interrupt = (): void => {
    void input.options.runner.interrupt(mission.id).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    input.signal?.throwIfAborted();
    await input.options.runner.run(mission.id);
    await waitForMission(input.options.missions, mission.id, input.signal);
    const finished = await input.options.missions.get(mission.id);
    if (finished.execution?.status !== "succeeded") {
      throw new Error(`memory_curator_failed:${finished.execution?.error ?? "unknown"}`);
    }
    const chat = await input.options.runner.getChat({ id: mission.id, limit: 100 });
    const content = chat.entries
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => entry.content)
      .at(-1);
    if (content === undefined) throw new Error("memory_curator_output_missing");
    return content;
  } finally {
    input.signal?.removeEventListener("abort", interrupt);
    if (await cleanupCuratorMission(input.options.runner, mission.id)) {
      await unregisterCuratorMission(pragmaHome, mission.id).catch((error: unknown) => {
        logger.warn(
          "desktop.memory_curator_registry_cleanup_failed",
          "A completed Memory Curator Mission remains registered for later cleanup.",
          { error, missionId: mission.id },
        );
      });
    }
  }
}

async function waitForMission(
  missions: MissionStore,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    ) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 200);
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error("memory_curator_timeout");
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

async function createFingerprint(profile: MemoryExtractorProfile): Promise<string> {
  return createHash("sha256")
    .update(
      JSON.stringify({
        episodicCurator: MEMORY_CURATOR_PROMPT_VERSION,
        semanticCurator: SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
        profile,
      }),
    )
    .digest("hex");
}

async function cleanupCuratorMission(runner: MissionRunner, missionId: string): Promise<boolean> {
  try {
    await runner.delete(missionId);
    return true;
  } catch {
    await runner.interrupt(missionId).catch(() => undefined);
    return await runner
      .delete(missionId)
      .then(() => true)
      .catch(() => false);
  }
}

async function registerCuratorMission(
  pragmaHome: string,
  missionId: string,
  jobId: string,
): Promise<void> {
  await updateCuratorMissionRegistry(pragmaHome, (entries) => [
    ...entries
      .filter((entry) => entry.missionId !== missionId)
      .slice(-(DEFAULT_MEMORY_STORAGE_POLICY.curatorRegistryMaxEntries - 1)),
    { missionId, jobId, createdAt: new Date().toISOString() },
  ]);
}

async function unregisterCuratorMission(pragmaHome: string, missionId: string): Promise<void> {
  await updateCuratorMissionRegistry(pragmaHome, (entries) =>
    entries.filter((entry) => entry.missionId !== missionId),
  );
}

async function readCuratorMissionRegistry(pragmaHome: string) {
  const path = new PragmaPaths({ pragmaHome }).memoryCuratorMissionRegistry();
  try {
    return CuratorMissionRegistrySchema.parse(JSON.parse(await readFile(path, "utf8"))).entries;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function updateCuratorMissionRegistry(
  pragmaHome: string,
  update: (
    entries: z.infer<typeof CuratorMissionRegistrySchema>["entries"],
  ) => z.infer<typeof CuratorMissionRegistrySchema>["entries"],
): Promise<void> {
  const path = new PragmaPaths({ pragmaHome }).memoryCuratorMissionRegistry();
  await withFileLock(`${path}.lock`, async () => {
    const entries = await readCuratorMissionRegistry(pragmaHome);
    const next = CuratorMissionRegistrySchema.parse({
      schemaVersion: "pragma.memory-curator-mission-registry/v1",
      entries: update(entries),
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

async function removeStaleCuratorTemps(pragmaHome: string): Promise<void> {
  const registry = new PragmaPaths({ pragmaHome }).memoryCuratorMissionRegistry();
  const root = dirname(registry);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const cutoff = Date.now() - DEFAULT_MEMORY_STORAGE_POLICY.atomicTempRetentionMs;
  for (const name of names.filter((value) => value.endsWith(".tmp"))) {
    const path = join(root, name);
    try {
      if ((await stat(path)).mtimeMs <= cutoff) await rm(path, { force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
