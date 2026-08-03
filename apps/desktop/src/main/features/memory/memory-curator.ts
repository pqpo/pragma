import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  ContextSystem,
  defineExpert,
  type PragmaLoggerProvider,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";
import {
  EpisodicExtractionOutputSchema,
  MEMORY_CURATOR_ID,
  MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_REF,
  type EpisodicMemoryExtractor,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
} from "@pragma/memory";

import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

export interface DesktopMemoryCurator {
  readonly extractor: EpisodicMemoryExtractor;
  compile(input: {
    readonly runtimes: RuntimeResolver;
    readonly workspace: string;
    readonly pragmaHome: string;
    readonly loggerProvider?: PragmaLoggerProvider | undefined;
  }): Promise<CompiledResource<InvocableResource>>;
  fingerprint(): Promise<string>;
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
    async fingerprint() {
      return await createFingerprint(await options.profiles.get());
    },
    extractor: {
      async extract(input) {
        const profile = await options.profiles.get();
        const runtime = await resolveRuntime(profile);
        const project = await options.project.ensurePublished();
        const mission = await options.missions.create({
          workspace: { path: options.workspace, basename: basename(options.workspace) },
          goal: renderExtractionPrompt(input),
          title: `Memory extraction ${input.executionId.slice(0, 12)}`,
          project: { id: project.projectId, revision: project.revision },
          executor: { kind: "expert", ref: MEMORY_CURATOR_REF, name: "Memory Curator" },
          origin: { type: "system-memory", jobId: input.jobId },
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
        await options.runner.run(mission.id);
        await waitForMission(options.missions, mission.id);
        const finished = await options.missions.get(mission.id);
        if (finished.execution?.status !== "succeeded") {
          throw new Error(`memory_curator_failed:${finished.execution?.error ?? "unknown"}`);
        }
        const chat = await options.runner.getChat({ id: mission.id, limit: 100 });
        const content = chat.entries
          .filter((entry) => entry.kind === "assistant")
          .map((entry) => entry.content)
          .at(-1);
        if (content === undefined) throw new Error("memory_curator_output_missing");
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
  };
}

const CURATOR_INSTRUCTIONS = [
  "You are the hidden Pragma Memory Curator.",
  "You have no tools and must not request additional context.",
  "Extract only claims supported by the supplied Evidence ids.",
  "Return exactly one JSON object matching the requested schema, without Markdown fences or commentary.",
  "Use the dominant language of the source task. Historical precedent is not current truth.",
].join("\n");

function renderExtractionPrompt(input: Parameters<EpisodicMemoryExtractor["extract"]>[0]): string {
  const evidence: unknown[] = [];
  let bytes = 0;
  for (const item of [...input.evidence].reverse()) {
    const serialized = JSON.stringify(item);
    if (bytes + Buffer.byteLength(serialized) > 78_000) continue;
    evidence.unshift(item);
    bytes += Buffer.byteLength(serialized);
  }
  return [
    "Extract an Episodic Memory from this safe Evidence projection.",
    "Return retain=false for low-value or insufficient evidence.",
    "Every goal, summary, attempt, failure/recovery, and outcome must cite one or more supplied messageId values in evidenceRefs.",
    "Output schema:",
    '{"retain":true,"language":"zh-Hans","goal":{"text":"...","evidenceRefs":["..."]},"summary":{"text":"...","evidenceRefs":["..."]},"attempts":[{"description":"...","result":"...","evidenceRefs":["..."]}],"failuresAndRecoveries":[{"failure":"...","recovery":"...","evidenceRefs":["..."]}],"outcome":{"status":"succeeded|failed|cancelled|interrupted","summary":"...","evidenceRefs":["..."]},"valueScore":0.0}',
    'or {"retain":false,"reason":"low-value|insufficient-evidence|sensitive"}.',
    "Evidence:",
    JSON.stringify(evidence),
  ].join("\n\n");
}

async function waitForMission(missions: MissionStore, id: string): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    .update(JSON.stringify({ curator: MEMORY_CURATOR_PROMPT_VERSION, profile }))
    .digest("hex");
}
