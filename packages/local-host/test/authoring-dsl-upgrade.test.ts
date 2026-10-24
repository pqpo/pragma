import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { encodePragmaPathSegment } from "@pragma/core";
import {
  PragmaAgentFlowDraftSchema,
  PragmaAgentEvaluationDraftSchema,
  type PragmaAgentFlowDraft,
  type PragmaAgentEvaluationDraft,
} from "@pragma/built-in-agents";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaForwardCompatibleResourceSchema,
} from "@pragma/interpreter/ast";
import { discardAuthoringRecord, readAuthoringRecord } from "../src/migrations/authoring/index.ts";
import { createLocalHostPragmaProjectPort } from "../src/pragma-project-port.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const fixtureRoot = join(
  import.meta.dirname,
  "../../../apps/desktop/src/main/features/built-in-agents/__fixtures__",
);
async function fixture(kind: "flow" | "evaluation" = "flow") {
  const root = await mkdtemp(join(tmpdir(), "pragma-authoring-upgrade-"));
  roots.push(root);
  const source = await readFile(
    join(
      fixtureRoot,
      kind === "flow"
        ? "legacy-flow-a32bdedb/draft.json"
        : "legacy-authoring-a69bd99d/evaluation.json",
    ),
    "utf8",
  );
  const original = JSON.parse(source);
  const path = join(root, `${encodePragmaPathSegment(original.draftId)}.json`);
  await writeFile(path, source);
  return { root, path, source, original };
}
it.each(["flow", "evaluation"] as const)(
  "upgrades a real historical %s draft once and retains original bytes",
  async (kind) => {
    const f = await fixture(kind);
    const schema: z.ZodType<PragmaAgentFlowDraft | PragmaAgentEvaluationDraft> =
      kind === "flow" ? PragmaAgentFlowDraftSchema : PragmaAgentEvaluationDraftSchema;
    const result = await readAuthoringRecord(f.path, kind, schema, f.original.draftId);
    expect(result?.resource.apiVersion).toBe(PRAGMA_DSL_WRITE_API_VERSION);
    expect(result?.draftRevision).toBe(f.original.draftRevision);
    expect(await readFile(`${f.path}.dsl-v5.backup.json`, "utf8")).toBe(f.source);
    const upgraded = await readFile(f.path, "utf8");
    expect(await readAuthoringRecord(f.path, kind, schema, f.original.draftId)).toEqual(result);
    expect(await readFile(f.path, "utf8")).toBe(upgraded);
    await expect(readFile(`${f.path}.dsl-migration.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
it("upgrades a historical candidate's resources and review sources before separate commit", async () => {
  const f = await fixture();
  const source = await readFile(
    join(fixtureRoot, "legacy-flow-a32bdedb/prepared-change.json"),
    "utf8",
  );
  const original = JSON.parse(source);
  const path = join(
    f.root,
    "change-sets",
    `${encodePragmaPathSegment(original.changeSet.changeSetId)}.json`,
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(f.root, "change-sets"));
  await writeFile(path, source);
  const port = createLocalHostPragmaProjectPort({
    stateRoot: f.root,
    project: {} as never,
    catalog: async () => ({}) as never,
    readSystemResource: () => undefined,
  });
  const result = await port.getChangeSet(original.changeSet.changeSetId);
  expect(result.changes[0]!.source).toContain(`apiVersion: ${PRAGMA_DSL_WRITE_API_VERSION}`);
  const upgraded = JSON.parse(await readFile(path, "utf8"));
  expect(PragmaForwardCompatibleResourceSchema.parse(upgraded.resources[0]).apiVersion).toBe(
    PRAGMA_DSL_WRITE_API_VERSION,
  );
  expect(await readFile(`${path}.dsl-v5.backup.json`, "utf8")).toBe(source);
});
it.each(["flow", "evaluation"] as const)(
  "upgrades embedded %s mutation receipts without applying an update twice",
  async (kind) => {
    const f = await fixture(kind);
    const family = `pragma.${kind}-command-mutation/v1`;
    const schema = z
      .object({
        schemaVersion: z.literal(family),
        expectedDraftRevision: z.number().int().nonnegative(),
        draft: kind === "flow" ? PragmaAgentFlowDraftSchema : PragmaAgentEvaluationDraftSchema,
      })
      .strict();
    const source = JSON.stringify({
      schemaVersion: family,
      expectedDraftRevision: f.original.draftRevision,
      draft: f.original,
    });
    const path = join(f.root, "receipt.json");
    await writeFile(path, source);
    const result = await readAuthoringRecord(
      path,
      `${kind}-mutation`,
      schema,
      f.original.draftId,
      f.original.draftRevision,
    );
    expect(result?.draft.resource.apiVersion).toBe(PRAGMA_DSL_WRITE_API_VERSION);
    expect(result?.draft.draftRevision).toBe(f.original.draftRevision);
    expect(await readFile(`${path}.dsl-v5.backup.json`, "utf8")).toBe(source);
    expect(
      await readAuthoringRecord(
        path,
        `${kind}-mutation`,
        schema,
        f.original.draftId,
        f.original.draftRevision,
      ),
    ).toEqual(result);
  },
);
it.each(["future", "corrupt", "wrong-owner"] as const)(
  "rejects %s data before making migration writes",
  async (kind) => {
    const f = await fixture();
    if (kind === "future") f.original.resource.apiVersion = "pragma/v999";
    const source = kind === "corrupt" ? "{" : JSON.stringify(f.original);
    await writeFile(f.path, source);
    await expect(
      readAuthoringRecord(
        f.path,
        "flow",
        PragmaAgentFlowDraftSchema,
        kind === "wrong-owner" ? "foreign" : f.original.draftId,
      ),
    ).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(source);
    await expect(readFile(`${f.path}.dsl-v5.backup.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
it.each(["source-present", "missing-target", "already-applied"] as const)(
  "replays a prepared authoring upgrade (%s)",
  async (state) => {
    const f = await fixture();
    const upgraded = await readAuthoringRecord(
      f.path,
      "flow",
      PragmaAgentFlowDraftSchema,
      f.original.draftId,
    );
    const target = JSON.parse(await readFile(f.path, "utf8"));
    const journal = {
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.authoring-flow", id: basename(f.path) },
      fromVersion: 5,
      toVersion: 6,
      documents: { [basename(f.path)]: target },
    };
    await writeFile(`${f.path}.dsl-migration.json`, JSON.stringify(journal));
    if (state === "source-present") await writeFile(f.path, f.source);
    if (state === "missing-target") await rm(f.path);
    expect(
      await readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId),
    ).toEqual(upgraded);
    expect(await readFile(`${f.path}.dsl-v5.backup.json`, "utf8")).toBe(f.source);
  },
);
it.each(["future", "changed", "wrong-target"] as const)(
  "preserves conflicting data and a pending journal (%s)",
  async (state) => {
    const f = await fixture();
    await readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId);
    const target = JSON.parse(await readFile(f.path, "utf8"));
    const existing = structuredClone(target);
    if (state === "future") existing.resource.apiVersion = "pragma/v999";
    if (state === "changed") existing.draftRevision++;
    if (state === "wrong-target") target.draftId = "00000000-0000-4000-8000-000000000099";
    const source = JSON.stringify(existing);
    await writeFile(f.path, source);
    const journal = JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.authoring-flow", id: basename(f.path) },
      fromVersion: 5,
      toVersion: 6,
      documents: { [basename(f.path)]: target },
    });
    await writeFile(`${f.path}.dsl-migration.json`, journal);
    await expect(
      readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId),
    ).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(source);
    expect(await readFile(`${f.path}.dsl-migration.json`, "utf8")).toBe(journal);
  },
);

it.each(["flow", "evaluation"] as const)(
  "replays an actual port update from a legacy %s mutation payload once",
  async (kind) => {
    const f = await fixture(kind);
    const { mkdir } = await import("node:fs/promises");
    const draftRoot = join(f.root, kind === "flow" ? "dsl-drafts" : "evaluation-drafts");
    const receipts = join(f.root, "receipts");
    await mkdir(draftRoot);
    await mkdir(receipts);
    const path = join(draftRoot, basename(f.path));
    await writeFile(path, f.source);
    const next = { ...f.original, draftRevision: 1 };
    const operationId = "historical-update";
    const receiptPath = join(receipts, `${encodePragmaPathSegment(operationId)}.json`);
    const receipt = JSON.stringify({
      schemaVersion: `pragma.${kind}-command-mutation/v1`,
      expectedDraftRevision: 0,
      draft: next,
    });
    await writeFile(receiptPath, receipt);
    const port = createLocalHostPragmaProjectPort({
      stateRoot: f.root,
      project: {} as never,
      catalog: async () => ({}) as never,
      readSystemResource: () => undefined,
    });
    const update = () =>
      kind === "flow"
        ? port.updateFlowDraft({
            draftId: next.draftId,
            expectedDraftRevision: 0,
            operationId,
            commandResultsRoot: receipts,
            operations: [{ type: "set_contracts", limits: { maxNodeVisits: 9999 } }],
          })
        : port.updateEvaluationDraft({
            draftId: next.draftId,
            expectedDraftRevision: 0,
            operationId,
            commandResultsRoot: receipts,
            operations: [{ type: "remove_case", caseId: "absent" }],
          });
    const first = await update();
    expect(first.draftRevision).toBe(1);
    expect(first.resource.apiVersion).toBe(PRAGMA_DSL_WRITE_API_VERSION);
    expect(await update()).toEqual(first);
    expect(JSON.parse(await readFile(path, "utf8")).draftRevision).toBe(1);
    expect(await readFile(`${receiptPath}.dsl-v5.backup.json`, "utf8")).toBe(receipt);
    expect(await readFile(`${path}.dsl-v5.backup.json`, "utf8")).toBe(f.source);
  },
);
it("refuses to replace a conflicting retained original backup", async () => {
  const f = await fixture();
  await writeFile(`${f.path}.dsl-v5.backup.json`, "retained original");
  await expect(
    readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId),
  ).rejects.toThrow("conflicts");
  expect(await readFile(f.path, "utf8")).toBe(f.source);
  expect(await readFile(`${f.path}.dsl-v5.backup.json`, "utf8")).toBe("retained original");
});

it("discard clears a pending upgrade without resurrecting the retained original", async () => {
  const f = await fixture();
  await readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId);
  const target = JSON.parse(await readFile(f.path, "utf8"));
  await writeFile(
    `${f.path}.dsl-migration.json`,
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.authoring-flow", id: basename(f.path) },
      fromVersion: 5,
      toVersion: 6,
      documents: { [basename(f.path)]: target },
    }),
  );
  await discardAuthoringRecord(f.path);
  expect(
    await readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId),
  ).toBeUndefined();
  expect(await readFile(`${f.path}.dsl-v5.backup.json`, "utf8")).toBe(f.source);
});

it("keeps an incomplete historical Flow editable without inventing a start step", async () => {
  const f = await fixture();
  delete f.original.resource.spec.graph.start;
  const source = JSON.stringify(f.original);
  await writeFile(f.path, source);
  const upgraded = await readAuthoringRecord(
    f.path,
    "flow",
    PragmaAgentFlowDraftSchema,
    f.original.draftId,
  );
  expect(upgraded?.resource.apiVersion).toBe(PRAGMA_DSL_WRITE_API_VERSION);
  expect(upgraded?.resource.spec.graph.start).toBeUndefined();
  expect(upgraded?.draftRevision).toBe(f.original.draftRevision);
  expect(await readFile(`${f.path}.dsl-v5.backup.json`, "utf8")).toBe(source);
});

it.each(["flow", "evaluation"] as const)(
  "preserves future %s mutation envelope versions",
  async (kind) => {
    const f = await fixture(kind);
    const schema = z.object({
      schemaVersion: z.literal(`pragma.${kind}-command-mutation/v1`),
      expectedDraftRevision: z.number(),
      draft: kind === "flow" ? PragmaAgentFlowDraftSchema : PragmaAgentEvaluationDraftSchema,
    });
    const source = JSON.stringify({
      schemaVersion: `pragma.${kind}-command-mutation/v999`,
      expectedDraftRevision: 0,
      draft: f.original,
    });
    await writeFile(f.path, source);
    await expect(
      readAuthoringRecord(f.path, `${kind}-mutation`, schema, f.original.draftId, 0),
    ).rejects.toMatchObject({ code: "STORAGE_VERSION_UNSUPPORTED" });
    expect(await readFile(f.path, "utf8")).toBe(source);
    await expect(readFile(`${f.path}.dsl-v5.backup.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each(["conflicting", "missing"] as const)(
  "preserves data and journal when the prepared backup is %s",
  async (state) => {
    const f = await fixture();
    await readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId);
    const target = JSON.parse(await readFile(f.path, "utf8"));
    await writeFile(f.path, f.source);
    const backup = `${f.path}.dsl-v5.backup.json`;
    if (state === "missing") await rm(backup);
    else await writeFile(backup, "retained conflicting original");
    const journal = JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.authoring-flow", id: basename(f.path) },
      fromVersion: 5,
      toVersion: 6,
      documents: { [basename(f.path)]: target },
    });
    await writeFile(`${f.path}.dsl-migration.json`, journal);
    await expect(
      readAuthoringRecord(f.path, "flow", PragmaAgentFlowDraftSchema, f.original.draftId),
    ).rejects.toMatchObject({ code: "STORAGE_CORRUPTED" });
    expect(await readFile(f.path, "utf8")).toBe(f.source);
    expect(await readFile(`${f.path}.dsl-migration.json`, "utf8")).toBe(journal);
    if (state === "conflicting")
      expect(await readFile(backup, "utf8")).toBe("retained conflicting original");
    else await expect(readFile(backup)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
