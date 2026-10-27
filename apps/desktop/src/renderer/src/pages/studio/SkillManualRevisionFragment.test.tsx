import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillManualRevisionRecordSchema } from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import {
  SkillManualRevisionDetailFragment,
  SkillManualRevisionRow,
  skillManualRevisionSummary,
} from "./SkillManualRevisionFragment.tsx";
import {
  actionableSkillRevisionTaskCount,
  skillRevisionHistoryEntries,
  type SkillRevisionEntry,
} from "./SkillRevisionFragment.tsx";

const record = SkillManualRevisionRecordSchema.parse({
  schemaVersion: "pragma.skill-manual-revision/v1",
  capabilityId: "0000000000000001",
  name: "Code Review",
  source: "manual",
  revision: 2,
  baseRevision: 1,
  createdAt: "2026-10-11T08:00:00.000Z",
  contentHash: "a".repeat(64),
  baseSnapshotHash: "b".repeat(64),
  snapshotHash: "c".repeat(64),
  operations: [
    {
      path: "SKILL.md",
      entryKind: "file",
      operation: "modified",
      before: { sha256: "a".repeat(64), sizeBytes: 10, executable: false },
      after: { sha256: "b".repeat(64), sizeBytes: 20, executable: false },
    },
    { path: "references", entryKind: "directory", operation: "added", before: null, after: null },
  ],
});
const job = {
  job: { id: "task", state: "pending_review", updatedAt: "2026-10-11T07:00:00.000Z" },
  draft: { capabilityId: record.capabilityId },
} as unknown as SkillRevisionEntry;

describe("Skill manual revision history", () => {
  it("merges manual saves and Agent tasks by time with the same Skill and status filters", () => {
    expect(skillRevisionHistoryEntries([job], [record]).map((entry) => entry.kind)).toEqual([
      "manual",
      "task",
    ]);
    expect(skillRevisionHistoryEntries([job], [record], "manual")).toEqual([
      { kind: "manual", record },
    ]);
    expect(skillRevisionHistoryEntries([job], [record], "completed")).toHaveLength(1);
    expect(skillRevisionHistoryEntries([job], [record], "actionable")).toEqual([
      { kind: "task", entry: job },
    ]);
    expect(skillRevisionHistoryEntries([job], [record], "", "0000000000000002")).toEqual([]);
    expect(actionableSkillRevisionTaskCount([job])).toBe(1);
  });

  it("shows the actual Skill name, saved version and manual source without approval actions", async () => {
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(
      <SkillManualRevisionRow record={record} capability={undefined} onOpen={() => undefined} />,
    );
    expect(html).toContain("Manual edit");
    expect(html).toContain("Code Review");
    expect(html).toContain("Revision 2");
    expect(html).not.toContain(record.capabilityId);
    expect(skillManualRevisionSummary(record, i18n.getFixedT("en", "studio"))).toContain(
      "1 added, 1 modified, 0 deleted",
    );
    const detail = renderToStaticMarkup(
      <SkillManualRevisionDetailFragment
        record={record}
        capability={undefined}
        onBack={() => undefined}
      />,
    );
    expect(detail).toContain("SKILL.md");
    expect(detail).toContain("references");
    expect(detail).toContain("Revision 1");
    expect(detail).toContain("Revision 2");
    expect(detail).not.toContain("Approve and publish");
    expect(detail).not.toContain("Retry");
    expect(detail).not.toContain("REQUEST.md");
  });
});
