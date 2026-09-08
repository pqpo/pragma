import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ContextStoreDraftSchema, type ContextStoreDraft } from "@pragma/built-in-agents/contracts";

import type { ContextStoreSnapshot } from "../../../../shared/contracts/index.ts";
import { ContextStoreDraftV1Schema } from "./schemas/draft-v1.ts";
import { ContextStoreRevisionJobV1Schema } from "./schemas/v1.ts";

export async function prepareContextStoreRevisionV1(options: {
  readonly storeId: string;
  readonly statePath: string;
  readonly draftsPath: string;
  readonly readLegacySnapshot: (revision?: number) => Promise<ContextStoreSnapshot>;
  readonly writeDraft: (draft: ContextStoreDraft) => Promise<void>;
  readonly trashDraft: (draftId: string) => Promise<void>;
  readonly migrateJob: (raw: unknown, base?: ContextStoreSnapshot) => Promise<void>;
  readonly backupDraft: (draft: unknown, draftId: string) => Promise<void>;
}): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(options.draftsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = JSON.parse(
      await readFile(join(options.draftsPath, entry.name, "draft.json"), "utf8"),
    ) as unknown;
    if (ContextStoreDraftSchema.safeParse(raw).success) continue;
    const legacy = ContextStoreDraftV1Schema.safeParse(raw);
    if (!legacy.success || legacy.data.storeId !== options.storeId) continue;
    if (legacy.data.id !== entry.name) {
      throw new Error(`Knowledge draft directory does not match its persisted id: ${entry.name}.`);
    }
    if (legacy.data.state === "merged") {
      await options.trashDraft(legacy.data.id);
      continue;
    }
    const base = await options.readLegacySnapshot(legacy.data.baseRevision);
    if (base.snapshotHash !== legacy.data.baseSnapshotHash) {
      throw new Error(`Knowledge draft ${legacy.data.id} has an inconsistent historical base.`);
    }
    const state = legacy.data.state === "merging" ? "pending_review" : legacy.data.state;
    await options.backupDraft(legacy.data, legacy.data.id);
    await options.writeDraft(
      ContextStoreDraftSchema.parse({
        ...legacy.data,
        schemaVersion: "pragma.context-store-draft/v2",
        baseRevision: undefined,
        baseSnapshot: base,
        state,
        submittedRevision: state === "pending_review" ? legacy.data.revision : undefined,
      }),
    );
  }

  const jobsPath = join(options.statePath, "jobs");
  let jobs: Dirent[];
  try {
    jobs = await readdir(jobsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of jobs) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(join(jobsPath, entry.name), "utf8")) as unknown;
    const legacy = ContextStoreRevisionJobV1Schema.safeParse(raw);
    if (!legacy.success || legacy.data.request.storeId !== options.storeId) continue;
    if (entry.name !== `${legacy.data.id}.json`) {
      throw new Error(`Knowledge update task file does not match its persisted id: ${entry.name}.`);
    }
    const base =
      legacy.data.state === "completed" || legacy.data.state === "rejected"
        ? undefined
        : await options.readLegacySnapshot(legacy.data.changeSet?.baseRevision);
    await options.migrateJob(raw, base);
  }
}
