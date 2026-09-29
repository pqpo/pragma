export { assetGitV1ToV2Step } from "./steps/v1-to-v2.ts";

import { RecordSchema } from "../asset-git-state-schema.ts";
import { assetGitV1ToV2Step } from "./steps/v1-to-v2.ts";

/** Identity-only indexing of historical associations does not perform storage maintenance. */
export function readAssetGitAssociationIdentity(value: unknown) {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  const current = version === "pragma.asset-git/v1" ? assetGitV1ToV2Step.record(value) : value;
  const parsed = RecordSchema.parse(current);
  return { target: parsed.target, source: parsed.source };
}
