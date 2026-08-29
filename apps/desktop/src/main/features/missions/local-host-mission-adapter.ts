import type { WorkspaceSelection } from "@pragma/shared/integration";
import {
  ExecutorDescriptorSchema,
  ExecutorReferenceSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
} from "@pragma/shared/integration";
import type { LocalHostRunRequest, ResolvedRunExecutor } from "@pragma/local-host";
import {
  canonicalPragmaResourceRef,
  type PragmaInvocableResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import type {
  Mission,
  MissionExecutorOption,
  PragmaProjectSnapshot,
} from "../../../shared/contracts/index.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

/**
 * Converts the Desktop Mission identity into the canonical Local Host run
 * request.  Product-only fields (title, model, tools, context stores,
 * attachments and origin) intentionally stay on the Desktop side.
 */
export function toLocalHostRunRequest(input: {
  readonly mission: Mission;
  readonly workspace: WorkspaceSelection;
  readonly executorSource: "project" | "built_in";
}): LocalHostRunRequest {
  const [kind, id] = input.mission.executor.ref.split(":", 2);
  if (
    (kind !== "expert" && kind !== "team" && kind !== "flow") ||
    id === undefined ||
    kind !== input.mission.executor.kind
  ) {
    throw new Error(`Mission executor reference is invalid: ${input.mission.executor.ref}.`);
  }

  const request = {
    requestId: input.mission.initialMessageId,
    command: `${kind}.run` as "expert.run" | "team.run" | "flow.run",
    executor: { kind, id } as { kind: "expert" | "team" | "flow"; id: string },
    workspace: input.workspace,
    detach: true,
    ...(input.executorSource === "project"
      ? {
          project: {
            projectId: input.mission.project.id,
            revision: input.mission.project.revision,
          },
        }
      : {}),
    ...(kind === "flow" ? { input: input.mission.flowInput } : { prompt: input.mission.goal }),
  } satisfies LocalHostRunRequest;
  return request;
}

/**
 * Resolves the Desktop-owned executor catalog into the Host-neutral
 * descriptor required by Local Host. Project descriptors are always read from
 * the requested exact revision; the Desktop head is never used as a fallback.
 */
export function createDesktopLocalHostExecutorResolver(options: {
  readonly executors: MissionExecutorCatalog;
  readonly project: PragmaProjectStore;
}): (input: {
  readonly ref: ExecutorReference;
  readonly projectId?: string | undefined;
  readonly revision?: number | undefined;
  readonly workspace: WorkspaceSelection;
}) => Promise<ResolvedRunExecutor | undefined> {
  return async (input) => {
    if (input.projectId !== undefined || input.revision !== undefined) {
      if (input.projectId !== options.project.projectId || input.revision === undefined) {
        return undefined;
      }
      const snapshot = await options.project.getRevision(input.revision);
      return projectExecutorFromSnapshot(snapshot, input.ref);
    }

    const candidate = (await options.executors.list()).find(
      (entry) =>
        entry.origin === "built-in" &&
        entry.kind === input.ref.kind &&
        entry.ref === refOf(input.ref),
    );
    return candidate === undefined
      ? undefined
      : { descriptor: executorDescriptorFromMissionOption(candidate) };
  };
}

export function executorDescriptorFromMissionOption(
  option: MissionExecutorOption,
  project?: {
    readonly projectId: string;
    readonly revision: number;
    readonly fingerprint: string;
  },
): ExecutorDescriptor {
  const ref = parseExecutorReference(option.ref);
  if (option.origin === "project" && project === undefined) {
    throw new Error(`A project binding is required for executor ${option.ref}.`);
  }
  return ExecutorDescriptorSchema.parse({
    schemaVersion: "pragma.integration-executor/v1",
    ref,
    name: option.name,
    description: option.description,
    source: option.origin === "built-in" ? "built_in" : "project",
    ...(option.origin === "project" ? { project } : {}),
    availability: { status: "ready", blockingCodes: [] },
    workspace: { required: true, allowNonGitDirectory: true },
    capabilities: capabilitiesFor(ref.kind),
    ...(option.kind === "flow" && option.inputSchema === undefined
      ? {}
      : option.kind === "flow"
        ? { inputSchema: option.inputSchema }
        : {}),
  });
}

function projectExecutorFromSnapshot(
  snapshot: PragmaProjectSnapshot,
  ref: ExecutorReference,
): ResolvedRunExecutor | undefined {
  if (snapshot.projectFingerprint === undefined) return undefined;
  const resource = snapshot.resources.find(
    (candidate) => canonicalPragmaResourceRef(candidate) === refOf(ref),
  );
  if (resource === undefined || !isInvocableResource(resource)) return undefined;
  return {
    descriptor: ExecutorDescriptorSchema.parse({
      schemaVersion: "pragma.integration-executor/v1",
      ref,
      name: resource.metadata.name,
      description: resource.metadata.description,
      source: "project",
      project: {
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        fingerprint: snapshot.projectFingerprint,
      },
      availability: { status: "ready", blockingCodes: [] },
      workspace: { required: true, allowNonGitDirectory: true },
      capabilities: capabilitiesFor(ref.kind),
      ...(resource.kind === "Flow" && resource.spec.input?.schema !== undefined
        ? { inputSchema: resource.spec.input.schema }
        : {}),
    }),
  };
}

function parseExecutorReference(ref: string): ExecutorReference {
  const [kind, id] = ref.split(":", 2);
  return ExecutorReferenceSchema.parse({ kind, id });
}

function refOf(ref: ExecutorReference): string {
  return `${ref.kind}:${ref.id}`;
}

function capabilitiesFor(kind: ExecutorReference["kind"]): {
  readonly interactive: boolean;
  readonly resumable: boolean;
  readonly steerable: boolean;
  readonly supportsQueue: boolean;
} {
  return {
    interactive: true,
    resumable: true,
    steerable: kind !== "flow",
    supportsQueue: kind !== "flow",
  };
}

function isInvocableResource(resource: PragmaResource): resource is PragmaInvocableResource {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}
