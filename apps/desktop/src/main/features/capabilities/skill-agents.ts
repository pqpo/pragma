import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ContextSystem,
  defineExpert,
  type PragmaLoggerProvider,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import { withFileLock } from "@pragma/context-filesystem";
import {
  runSkillReplayEvaluation,
  SkillEvaluationAssertionSchema,
  type SkillEvaluationCase,
} from "@pragma/evaluation";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";
import type { SkillPackage } from "@pragma/shared";
import { z } from "zod";

import {
  ContextStoreRevisionProfileSchema,
  SkillEvaluationProfileSchema,
  SkillEvaluationSnapshotSchema,
  SkillRevisionChangeSetSchema,
  UpdateSkillEvaluationProfileSchema,
  type ContextStoreRevisionProfile,
  type SkillEvaluationProfile,
  type SkillEvaluationSnapshot,
  type UpdateSkillEvaluationProfile,
} from "../../../shared/contracts/index.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { validateGeneratedSkillPackage } from "./generated-skill-validation.ts";
import type { SkillRevisionEvaluator, SkillRevisionGenerator } from "./skill-revision-service.ts";

export const SKILL_REVISION_EXPERT_ID = "0000000000sk1rev";
export const SKILL_REVISION_EXPERT_REF = `expert:${SKILL_REVISION_EXPERT_ID}` as const;
export const SKILL_EVALUATION_EXPERT_ID = "0000000000sk1eva";
export const SKILL_EVALUATION_EXPERT_REF = `expert:${SKILL_EVALUATION_EXPERT_ID}` as const;

export interface SkillEvaluationProfileStore {
  get(): Promise<SkillEvaluationProfile>;
  update(input: UpdateSkillEvaluationProfile): Promise<SkillEvaluationProfile>;
}

export function createSkillEvaluationProfileStore(path: string): SkillEvaluationProfileStore {
  const get = async () => {
    try {
      return SkillEvaluationProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return SkillEvaluationProfileSchema.parse({
        schemaVersion: "pragma.skill-evaluation-profile/v1",
        revision: 0,
        mode: "inherit-default",
        updatedAt: new Date(0).toISOString(),
      });
    }
  };
  return {
    get,
    async update(rawInput) {
      const input = UpdateSkillEvaluationProfileSchema.parse(rawInput);
      const current = await get();
      if (current.revision !== input.expectedRevision)
        throw Object.assign(new Error("skill_evaluation_profile_conflict"), {
          code: "revision_conflict",
        });
      const next = SkillEvaluationProfileSchema.parse({
        schemaVersion: "pragma.skill-evaluation-profile/v1",
        revision: current.revision + 1,
        mode: input.mode,
        ...(input.model === undefined ? {} : { model: input.model }),
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path, next);
      return next;
    },
  };
}

export interface DesktopSkillAgents {
  readonly revisionGenerator: SkillRevisionGenerator;
  readonly revisionEvaluator: SkillRevisionEvaluator;
  evaluateCandidate(input: {
    readonly candidateId: string;
    readonly package: SkillPackage;
    readonly replayCases: readonly {
      readonly objective: string;
      readonly requiredBehaviors: readonly string[];
      readonly forbiddenBehaviors: readonly string[];
    }[];
    readonly boundaryCase: {
      readonly objective: string;
      readonly requiredBehaviors: readonly string[];
      readonly forbiddenBehaviors: readonly string[];
    };
  }): Promise<SkillEvaluationSnapshot>;
  compile(input: {
    readonly kind: "revision" | "evaluation";
    readonly runtimes?: RuntimeResolver;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(kind: "revision" | "evaluation"): Promise<string>;
  recoverOrphans(): Promise<number>;
}

export function createDesktopSkillAgents(options: {
  readonly revisionProfiles: { getProfile(): Promise<ContextStoreRevisionProfile> };
  readonly evaluationProfiles: SkillEvaluationProfileStore;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider;
}): DesktopSkillAgents {
  const workspace = join(options.pragmaHome, "tmp", "skill-agents");
  const registryPath = join(options.pragmaHome, "state", "skill-agents", "missions.json");

  const resolveRuntime = async (
    profile: ContextStoreRevisionProfile | SkillEvaluationProfile,
    resolver = options.runtimes,
  ) => {
    const parsed =
      profile.schemaVersion === "pragma.context-store-revision-profile/v1"
        ? ContextStoreRevisionProfileSchema.parse(profile)
        : SkillEvaluationProfileSchema.parse(profile);
    const runtimeId =
      parsed.mode === "pinned" && parsed.model !== undefined
        ? parsed.model.runtimeId
        : await resolver.getDefaultRuntimeId();
    const modelSelection: RuntimeModelSelection | undefined =
      parsed.mode === "pinned" && parsed.model !== undefined
        ? {
            model: { providerId: parsed.model.providerId, modelId: parsed.model.modelId },
            ...(parsed.model.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: parsed.model.thinkingLevel }),
          }
        : undefined;
    await resolver.bind({ runtimeId, ...(modelSelection === undefined ? {} : { modelSelection }) });
    return { runtimeId, modelSelection };
  };

  const run = async (input: {
    readonly kind: "revision" | "evaluation";
    readonly jobId: string;
    readonly goal: string;
    readonly phase?: "subject" | "judge";
  }) => {
    const profile =
      input.kind === "revision"
        ? await options.revisionProfiles.getProfile()
        : await options.evaluationProfiles.get();
    const runtime = await resolveRuntime(profile);
    const project = await options.project.ensurePublished();
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const mission = await options.missions.create({
      workspace: { path: workspace, basename: basename(workspace) },
      goal: input.goal,
      title: input.kind === "revision" ? "Revise Skill Capability" : "Evaluate Skill Capability",
      project: { id: project.projectId, revision: project.revision },
      executor: {
        kind: "expert",
        ref: input.kind === "revision" ? SKILL_REVISION_EXPERT_REF : SKILL_EVALUATION_EXPERT_REF,
        name: input.kind === "revision" ? "Skill Revision Agent" : "Skill Evaluation Agent",
      },
      origin:
        input.kind === "revision"
          ? {
              type: "system-skill-revision",
              jobId: input.jobId,
              capabilityId: JSON.parse(input.goal).capabilityId as string,
            }
          : { type: "system-skill-evaluation", jobId: input.jobId, phase: input.phase ?? "judge" },
      toolPermissionMode: "request-approval",
      ...(runtime.modelSelection === undefined
        ? {}
        : {
            modelOverride: {
              providerId: runtime.modelSelection.model.providerId,
              modelId: runtime.modelSelection.model.modelId,
              ...(runtime.modelSelection.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: runtime.modelSelection.thinkingLevel }),
            },
          }),
    });
    await registerMission(registryPath, mission.id, input.jobId, input.kind);
    try {
      await options.runner.run(mission.id);
      await waitForMission(options.missions, mission.id);
      const finished = await options.missions.get(mission.id);
      if (finished.execution?.status !== "succeeded")
        throw new Error(`skill_agent_failed:${finished.execution?.error ?? "unknown"}`);
      const chat = await options.runner.getChat({ id: mission.id, limit: 100 });
      const output = chat.entries
        .filter((entry) => entry.kind === "assistant")
        .map((entry) => entry.content)
        .at(-1);
      if (output === undefined) throw new Error("skill_agent_output_missing");
      return output;
    } finally {
      if (await cleanupMission(options.runner, mission.id)) {
        await unregisterMission(registryPath, mission.id).catch(() => undefined);
      }
    }
  };

  const evaluate = async (input: {
    readonly jobId: string;
    readonly package: SkillPackage;
    readonly replayCases: readonly {
      readonly objective: string;
      readonly requiredBehaviors: readonly string[];
      readonly forbiddenBehaviors: readonly string[];
    }[];
    readonly boundaryCase: {
      readonly objective: string;
      readonly requiredBehaviors: readonly string[];
      readonly forbiddenBehaviors: readonly string[];
    };
  }) => {
    const validation = await validateGeneratedSkillPackage(input.package);
    const cases: SkillEvaluationCase[] = [
      ...input.replayCases.map((testCase, index) => ({
        id: `source-${index + 1}`,
        kind: "source-replay" as const,
        objective: testCase.objective,
        requiredBehaviors: [...testCase.requiredBehaviors],
        forbiddenBehaviors: [...testCase.forbiddenBehaviors],
      })),
      {
        id: "not-applicable",
        kind: "boundary" as const,
        objective: input.boundaryCase.objective,
        requiredBehaviors: [...input.boundaryCase.requiredBehaviors],
        forbiddenBehaviors: [...input.boundaryCase.forbiddenBehaviors],
      },
    ];
    const profile = await options.evaluationProfiles.get();
    const runtime = await resolveRuntime(profile);
    const result = await runSkillReplayEvaluation({
      cases,
      staticChecksPassed: validation.staticChecksPassed,
      scriptTestsPassed: validation.scriptTestsPassed,
      subject: {
        run: async ({ case: testCase }) =>
          await run({
            kind: "evaluation",
            jobId: input.jobId,
            phase: "subject",
            goal: JSON.stringify({
              task: "Apply the candidate Skill to the case. For boundary cases, explicitly decline when it does not apply. Return only the proposed response or action plan.",
              skill: input.package,
              case: testCase,
            }),
          }),
      },
      judge: {
        evaluate: async ({ case: testCase, output }) =>
          z.array(SkillEvaluationAssertionSchema).parse(
            JSON.parse(
              extractJson(
                await run({
                  kind: "evaluation",
                  jobId: input.jobId,
                  phase: "judge",
                  goal: JSON.stringify({
                    task: "Judge the candidate Skill response. Return a JSON array of assertions covering applicability, correctness, completeness, recovery, and safety.",
                    case: testCase,
                    output,
                  }),
                }),
              ),
            ),
          ),
      },
    });
    return SkillEvaluationSnapshotSchema.parse({
      schemaVersion: "pragma.skill-evaluation-snapshot/v1",
      subjectHash: packageHash(input.package),
      passed: result.passed,
      staticChecksPassed: result.staticChecksPassed,
      scriptTestsPassed: result.scriptTestsPassed,
      profileRevision: profile.revision,
      runtimeId: runtime.runtimeId,
      providerId: runtime.modelSelection?.model.providerId ?? "runtime-managed",
      modelId: runtime.modelSelection?.model.modelId ?? "runtime-default",
      cases: result.cases.map((testCase, index) => ({
        id: testCase.id,
        kind: cases[index]!.kind,
        passed: testCase.passed,
        assertions: testCase.assertions,
      })),
      evaluatedAt: result.evaluatedAt,
    });
  };

  const api: DesktopSkillAgents = {
    revisionGenerator: {
      async generate(input) {
        const output = await run({
          kind: "revision",
          jobId: input.jobId,
          goal: JSON.stringify({
            capabilityId: input.request.capabilityId,
            task: "Return exactly one pragma.skill-revision-change-set/v1 JSON object. Make the smallest coherent change, preserve unrelated files, and keep scripts as dependency-free Node ESM with node:test coverage.",
            request: input.request.prompt,
            baseRevision: input.revision,
            baseContentHash: input.contentHash,
            currentSkill: input.current,
          }),
        });
        return SkillRevisionChangeSetSchema.parse(JSON.parse(extractJson(output)));
      },
    },
    revisionEvaluator: {
      evaluate: async (input) =>
        await evaluate({
          jobId: input.jobId,
          package: input.package,
          replayCases: input.request.replayCases ?? defaultReplayCases(input.request.prompt),
          boundaryCase: input.request.boundaryCase ?? defaultBoundaryCase(),
        }),
    },
    evaluateCandidate: async (input) =>
      await evaluate({
        jobId: input.candidateId,
        package: input.package,
        replayCases: input.replayCases,
        boundaryCase: input.boundaryCase,
      }),
    async compile(input) {
      const profile =
        input.kind === "revision"
          ? await options.revisionProfiles.getProfile()
          : await options.evaluationProfiles.get();
      const runtime = await resolveRuntime(profile, input.runtimes);
      const expert = await defineExpert({
        schemaVersion: "pragma.expert/v1",
        id: input.kind === "revision" ? SKILL_REVISION_EXPERT_ID : SKILL_EVALUATION_EXPERT_ID,
        name: input.kind === "revision" ? "Skill Revision Agent" : "Skill Evaluation Agent",
        description:
          input.kind === "revision"
            ? "Hidden system Expert that proposes Skill Capability revisions."
            : "Hidden system Expert that evaluates Skill Capability candidates.",
        scope: input.kind === "revision" ? "system-skill-revision" : "system-skill-evaluation",
        tags: ["system", "skill", input.kind],
        instructions:
          input.kind === "revision"
            ? "Return only the requested structured Skill change set. Never request tools or external context."
            : "Perform only the requested isolated Skill replay or judgment. Never request tools or external context. Return exactly the requested output.",
        workspace,
        pragmaHome: options.pragmaHome,
        defaultRuntimeId: runtime.runtimeId,
        ...(runtime.modelSelection === undefined
          ? {}
          : { models: { default: runtime.modelSelection } }),
        contextSystem: new ContextSystem(),
        tools: [],
        loggerProvider: options.loggerProvider,
      });
      const fingerprint = await api.fingerprint(input.kind);
      return {
        ref: input.kind === "revision" ? SKILL_REVISION_EXPERT_REF : SKILL_EVALUATION_EXPERT_REF,
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
    },
    async fingerprint(kind) {
      const profile =
        kind === "revision"
          ? await options.revisionProfiles.getProfile()
          : await options.evaluationProfiles.get();
      return createHash("sha256")
        .update(JSON.stringify({ version: 1, kind, profile }))
        .digest("hex");
    },
    async recoverOrphans() {
      let recovered = 0;
      for (const entry of (await readMissionRegistry(registryPath)).slice(0, 100)) {
        try {
          await options.missions.get(entry.missionId);
        } catch (error) {
          if (error instanceof MissionStoreError && error.code === "mission_not_found")
            await unregisterMission(registryPath, entry.missionId);
          continue;
        }
        if (await cleanupMission(options.runner, entry.missionId)) {
          await unregisterMission(registryPath, entry.missionId);
          recovered += 1;
        }
      }
      return recovered;
    },
  };
  return api;
}

function defaultReplayCases(prompt: string) {
  return [1, 2, 3].map((index) => ({
    objective: `Apply the requested Skill revision in representative case ${index}: ${prompt}`,
    requiredBehaviors: ["Follow the revised Skill correctly."],
    forbiddenBehaviors: ["Invent unavailable context or unsafe actions."],
  }));
}
function defaultBoundaryCase() {
  return {
    objective: "A request clearly outside this Skill's stated applicability.",
    requiredBehaviors: ["Recognize that the Skill does not apply."],
    forbiddenBehaviors: ["Force the Skill onto an unrelated task."],
  };
}
function packageHash(skill: SkillPackage): string {
  return createHash("sha256").update(JSON.stringify(skill)).digest("hex");
}
function extractJson(value: string): string {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  if (fenced !== undefined) return fenced.trim();
  const start = Math.min(...[value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0));
  const end = Math.max(value.lastIndexOf("}"), value.lastIndexOf("]"));
  return start >= 0 && end >= start ? value.slice(start, end + 1) : value;
}
async function waitForMission(missions: MissionStore, id: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("skill_agent_timeout");
}
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const SkillAgentMissionRegistrySchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-agent-missions/v1"),
    entries: z
      .array(
        z
          .object({
            missionId: z.string().uuid(),
            jobId: z.string().uuid(),
            kind: z.enum(["revision", "evaluation"]),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();
type SkillAgentMissionEntry = z.infer<typeof SkillAgentMissionRegistrySchema>["entries"][number];
async function readMissionRegistry(path: string): Promise<readonly SkillAgentMissionEntry[]> {
  try {
    return SkillAgentMissionRegistrySchema.parse(JSON.parse(await readFile(path, "utf8"))).entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function updateMissionRegistry(
  path: string,
  update: (entries: readonly SkillAgentMissionEntry[]) => readonly SkillAgentMissionEntry[],
): Promise<void> {
  await withFileLock(`${path}.lock`, async () => {
    const entries = update(await readMissionRegistry(path));
    await writeJsonAtomic(
      path,
      SkillAgentMissionRegistrySchema.parse({
        schemaVersion: "pragma.skill-agent-missions/v1",
        entries,
      }),
    );
  });
}
async function registerMission(
  path: string,
  missionId: string,
  jobId: string,
  kind: "revision" | "evaluation",
): Promise<void> {
  await updateMissionRegistry(path, (entries) => [
    ...entries.filter((entry) => entry.missionId !== missionId).slice(-999),
    { missionId, jobId, kind, createdAt: new Date().toISOString() },
  ]);
}
async function unregisterMission(path: string, missionId: string): Promise<void> {
  await updateMissionRegistry(path, (entries) =>
    entries.filter((entry) => entry.missionId !== missionId),
  );
}
async function cleanupMission(runner: MissionRunner, missionId: string): Promise<boolean> {
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
