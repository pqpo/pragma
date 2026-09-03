import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { DEFAULT_PRAGMA_EXPERT_AVATAR_ID } from "@pragma/shared";

export function expertTeamCoordinatorAvatarId(
  team: PragmaExpertTeamResource,
  resources: readonly PragmaResource[],
  resolveExternalExpert?: ((ref: string) => PragmaExpertResource | undefined) | undefined,
): string {
  const coordinator = resources.find(
    (resource): resource is Extract<PragmaResource, { kind: "Expert" }> =>
      resource.kind === "Expert" &&
      canonicalPragmaResourceRef(resource) === team.spec.coordinator.ref,
  );
  return (
    coordinator?.metadata.avatarId ??
    resolveExternalExpert?.(team.spec.coordinator.ref)?.metadata.avatarId ??
    DEFAULT_PRAGMA_EXPERT_AVATAR_ID
  );
}
