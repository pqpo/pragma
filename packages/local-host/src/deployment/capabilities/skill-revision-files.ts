import { readStorageFile as readFile } from "@pragma/core";
import { join } from "node:path";
import type {
  SkillRevisionReview,
  SkillRevisionReviewFile,
} from "../../deployment-contracts/index.ts";
import type {
  SkillWorkingTreeEntry,
  SkillWorkingTreeSnapshot,
} from "./skill-revision-draft-store.ts";

export function skillReviewFileMetadata(entry: SkillWorkingTreeEntry) {
  return { sizeBytes: entry.sizeBytes, sha256: entry.sha256, executable: entry.executable };
}

export function skillRevisionFileChanges(
  base: SkillWorkingTreeSnapshot,
  candidate: SkillWorkingTreeSnapshot,
): SkillRevisionReview["operations"] {
  const previous = new Map(base.entries.map((entry) => [entry.path, entry]));
  const next = new Map(candidate.entries.map((entry) => [entry.path, entry]));
  const operations: SkillRevisionReview["operations"] = [];
  for (const path of [...new Set([...previous.keys(), ...next.keys()])].toSorted()) {
    const before = previous.get(path);
    const after = next.get(path);
    if (
      before !== undefined &&
      after !== undefined &&
      before.sha256 === after.sha256 &&
      before.executable === after.executable
    )
      continue;
    operations.push({
      path,
      operation: after === undefined ? "deleted" : before === undefined ? "added" : "modified",
      before: before === undefined ? null : skillReviewFileMetadata(before),
      after: after === undefined ? null : skillReviewFileMetadata(after),
    });
  }
  return operations;
}

export async function readSkillReviewFile(
  root: string,
  entry: SkillWorkingTreeEntry,
): Promise<NonNullable<SkillRevisionReviewFile["before"]>> {
  const metadata = skillReviewFileMetadata(entry);
  if (entry.sizeBytes > 1_000_000)
    return { ...metadata, content: null, unavailableReason: "size_limit" };
  const bytes = await readFile(join(root, ...entry.path.split("/")));
  const content = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(content, "utf8").equals(bytes))
    return { ...metadata, content: null, unavailableReason: "binary" };
  let lineCount = 1;
  for (const character of content) {
    if (character === "\n") lineCount++;
    if (lineCount > 5_000) return { ...metadata, content: null, unavailableReason: "line_limit" };
  }
  return { ...metadata, content, unavailableReason: null };
}
