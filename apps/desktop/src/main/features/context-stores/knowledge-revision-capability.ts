import { createHash } from "node:crypto";

import type {
  KnowledgeRevisionSubmissionPort,
  KnowledgeRevisionTarget,
  KnowledgeRevisionToolInvocation,
} from "@pragma/built-in-agents";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import {
  classifyDesktopContextResource,
  createDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { ContextStoreRevisionService } from "./context-store-revision-service.ts";
import type { ContextStoreStore } from "./context-store-store.ts";

export function createDesktopKnowledgeRevisionSubmissionPort(options: {
  readonly project: PragmaProjectStore;
  readonly contextStores: ContextStoreStore;
  readonly revisions: ContextStoreRevisionService;
  readonly additionalMountResources?: (() => readonly PragmaResource[]) | undefined;
}): KnowledgeRevisionSubmissionPort {
  const targets = async (): Promise<readonly ResolvedTarget[]> => {
    const [stores, project] = await Promise.all([
      options.contextStores.list(),
      options.project.get(),
    ]);
    const mounts = collectMounts([
      ...project.resources,
      ...(options.additionalMountResources?.() ?? []),
    ]);

    return stores
      .map((store): ResolvedTarget => {
        const targetRef = canonicalPragmaResourceRef(
          createDesktopContextResource({ owner: "project-expert", storeId: store.id }),
        );
        const targetMounts = mounts.get(store.id) ?? [];
        return {
          storeId: store.id,
          target: {
            targetRef,
            name: store.name,
            description: store.description,
            revision: store.contentRevision,
            mounted: targetMounts.length > 0,
            mounts: targetMounts,
          },
        };
      })
      .toSorted(
        (left, right) =>
          left.target.name.localeCompare(right.target.name) ||
          left.target.targetRef.localeCompare(right.target.targetRef),
      );
  };

  return {
    async listTargets() {
      return (await targets()).map((target) => target.target);
    },
    async submit(input) {
      const selected = (await targets()).find(
        (candidate) => candidate.target.targetRef === input.targetRef,
      );
      if (selected === undefined) throw new Error("knowledge_revision_target_unavailable");
      const job = await options.revisions.submit({
        schemaVersion: "pragma.context-store-revision-request/v1",
        storeId: selected.storeId,
        prompt: input.prompt,
        source: "expert-reflection",
        sourceDigest: digestSubmission(input, selected.storeId),
        provenance: {
          executionId: input.executionId,
          invocationId: input.invocationId,
          expertId: input.expertId,
          ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        },
      });
      options.revisions.scheduleProcessing();
      return { jobId: job.id, state: job.state, target: selected.target };
    },
  };
}

interface ResolvedTarget {
  readonly storeId: string;
  readonly target: KnowledgeRevisionTarget;
}

type KnowledgeRevisionTargetMount = KnowledgeRevisionTarget["mounts"][number];

function collectMounts(
  resources: readonly PragmaResource[],
): ReadonlyMap<string, KnowledgeRevisionTargetMount[]> {
  const storeIdsByRef = new Map(
    resources.flatMap((resource) => {
      const storeId = classifyDesktopContextResource(resource);
      return storeId === undefined
        ? []
        : ([[canonicalPragmaResourceRef(resource), storeId]] as const);
    }),
  );
  const mounts = new Map<string, KnowledgeRevisionTargetMount[]>();
  const append = (ref: string, mount: KnowledgeRevisionTargetMount): void => {
    const storeId = storeIdsByRef.get(ref);
    if (storeId === undefined) return;
    const current = mounts.get(storeId) ?? [];
    current.push(mount);
    mounts.set(storeId, current);
  };

  for (const resource of resources) {
    if (resource.kind === "Expert") collectExpertMounts(resource, append);
    if (resource.kind === "ExpertTeam") collectTeamMounts(resource, append);
  }
  return mounts;
}

function collectExpertMounts(
  expert: PragmaExpertResource,
  append: (ref: string, mount: KnowledgeRevisionTargetMount) => void,
): void {
  for (const binding of expert.spec.contextStores) {
    append(binding.ref, {
      ownerKind: "expert",
      ownerRef: canonicalPragmaResourceRef(expert),
      ownerName: expert.metadata.name,
      namespace: binding.namespace,
      required: binding.required,
    });
  }
}

function collectTeamMounts(
  team: PragmaExpertTeamResource,
  append: (ref: string, mount: KnowledgeRevisionTargetMount) => void,
): void {
  for (const binding of team.spec.contextStores) {
    append(binding.ref, {
      ownerKind: "team",
      ownerRef: canonicalPragmaResourceRef(team),
      ownerName: team.metadata.name,
      namespace: binding.namespace,
      required: binding.required,
      visibility: binding.visibility,
    });
  }
}

function digestSubmission(input: KnowledgeRevisionToolInvocation, storeId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.executionId,
        input.invocationId,
        input.expertId,
        input.teamId ?? null,
        storeId,
      ]),
    )
    .digest("hex");
}
