import { createHash } from "node:crypto";
import type { Mission } from "../../../shared/contracts/index.ts";

export function missionContextMountsFingerprint(mission: Mission): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        mission.contextMounts
          .map((mount) =>
            mount.kind === "context-store"
              ? { kind: mount.kind, storeId: mount.storeId }
              : {
                  kind: mount.kind,
                  draftId: mount.draftId,
                  revisionJobId: mount.revisionJobId ?? null,
                },
          )
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ),
    )
    .digest("hex");
}
