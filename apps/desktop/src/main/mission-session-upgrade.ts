import {
  isExpertDefinitionMismatchError,
  isExpertTeam,
  type ResumeExpertSessionOptions,
} from "@pragma/core";
import type { PragmaResourceIdentityMigrationIndex } from "@pragma/interpreter";
import type { ExpertSessionRecord } from "@pragma/shared";
import type { CompiledResource, InvocableResource } from "@pragma/interpreter";

import type { Mission } from "../shared/desktop-api.ts";

export function createMissionResumeOptions(input: {
  readonly mission: Mission;
  readonly compiled: CompiledResource<InvocableResource>;
  readonly sessionId: string;
  readonly record?: ExpertSessionRecord | undefined;
  readonly identityIndex: PragmaResourceIdentityMigrationIndex;
}): ResumeExpertSessionOptions {
  if ("kind" in input.compiled.value && input.compiled.value.kind === "flow") {
    throw new Error("Flow missions do not use ExpertSession.");
  }
  const rootContext =
    input.record === undefined ? undefined : input.record.contexts[input.record.rootContextId];
  const rootExpert = isExpertTeam(input.compiled.value)
    ? input.compiled.value.coordinator
    : input.compiled.value;
  const expectedRef = isExpertTeam(input.compiled.value)
    ? `team:${input.compiled.value.id}`
    : `expert:${input.compiled.value.id}`;
  const sessionKind = isExpertTeam(input.compiled.value) ? "ExpertTeam" : "Expert";
  if (
    input.record === undefined ||
    rootContext === undefined ||
    input.mission.executor.ref !== expectedRef ||
    (input.record.expertId === input.compiled.value.id &&
      rootContext.expert.id === rootExpert.id) ||
    !input.identityIndex.hasMigration(
      sessionKind,
      input.record.expertId,
      input.compiled.value.id,
    ) ||
    !input.identityIndex.hasMigration("Expert", rootContext.expert.id, rootExpert.id)
  ) {
    return { sessionId: input.sessionId };
  }
  return {
    sessionId: input.sessionId,
    definitionMigration: {
      previousExpertId: input.record.expertId,
      previousRootExpertId: rootContext.expert.id,
      reason: [
        `Desktop Mission ${input.mission.id} is resuming executor ${input.mission.executor.ref}`,
        `from project ${input.mission.project.id}@${input.mission.project.revision}.`,
      ].join(" "),
    },
  };
}

export function shouldCreateSuccessorExpertSession(error: unknown): boolean {
  return isExpertDefinitionMismatchError(error);
}
