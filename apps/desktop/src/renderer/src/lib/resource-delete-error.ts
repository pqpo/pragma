import type { TFunction } from "i18next";
import { PragmaResourceKindSchema, parsePragmaReference } from "@pragma/interpreter/ast";
import { DesktopMutationErrorSchema } from "../../../shared/contracts/index.ts";
import { errorMessage } from "./errors.ts";

const DELETE_REFERENCE_KIND_KEYS = {
  expert: "deleteResourceKind.expert",
  team: "deleteResourceKind.team",
  flow: "deleteResourceKind.flow",
  automation: "deleteResourceKind.automation",
  capability: "deleteResourceKind.capability",
  "context-store": "deleteResourceKind.contextStore",
  "runtime-profile": "deleteResourceKind.runtimeProfile",
  evaluation: "deleteResourceKind.evaluation",
} as const;
export function deletePragmaResourceErrorMessage(error: unknown, t: TFunction<"studio">): string {
  const parsed = DesktopMutationErrorSchema.safeParse(error);
  if (!parsed.success || !["resource_referenced", "expert_referenced"].includes(parsed.data.code)) {
    return errorMessage(error);
  }

  const referencedBy = parsed.data.referencedBy ?? [];
  if (referencedBy.length === 0) return t("deleteResourceReferencedUnknown");

  const references = referencedBy
    .map(({ ref, name }) =>
      t("deleteResourceReference", {
        kind: t(
          DELETE_REFERENCE_KIND_KEYS[
            PragmaResourceKindSchema.parse(parsePragmaReference(ref).kind)
          ],
        ),
        name,
      }),
    )
    .join(t("deleteResourceReferenceSeparator"));
  return t("deleteResourceReferenced", { references });
}
