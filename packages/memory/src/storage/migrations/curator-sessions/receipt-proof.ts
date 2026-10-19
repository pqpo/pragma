import { State } from "../../../pipeline/extraction-session/schema.ts";
import { CuratorSessionV1Schema } from "./schemas/v1.ts";
import { CuratorSessionV2Schema } from "./schemas/v2.ts";

/** Read-only admission proofs do not migrate or open a business aggregate. */
export function parseCuratorSessionProof(json: string, version: number) {
  const value: unknown = JSON.parse(json);
  if (version === 1) return CuratorSessionV1Schema.parse(value);
  if (version === 2) return CuratorSessionV2Schema.parse(value);
  if (version === 3) return State.parse(value);
  throw new Error("memory_curator_session_version_unsupported");
}
