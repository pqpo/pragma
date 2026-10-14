import {
  MissionContentReferenceSchema,
  type MissionContentReference,
} from "@pragma/shared/integration";
import { shellArgument } from "../commands/utils.ts";

export function contentReadCommand(
  reference: Pick<MissionContentReference, "missionId" | "source" | "id" | "fingerprint" | "end">,
  start = reference.end,
): string {
  return `pragma mission get ${shellArgument(reference.missionId)} --view content --source ${reference.source} --content-id ${shellArgument(reference.id)} --fingerprint ${reference.fingerprint} --start ${start} --max-bytes 8000`;
}
export function renderContentReference(value: unknown): string {
  const parsed = MissionContentReferenceSchema.safeParse(value);
  if (!parsed.success) return "Content reference unavailable; query the Mission again.";
  const reference = parsed.data;
  return `PREVIEW (TRUNCATED; bytes [0,${reference.end}) / ${reference.totalBytes}; ${reference.encoding}):\n${reference.preview}\nNEXT: ${contentReadCommand(reference)}\n`;
}
