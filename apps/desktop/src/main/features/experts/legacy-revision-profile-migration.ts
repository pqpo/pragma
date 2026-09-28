import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  ContextStoreRevisionProfileSchema,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
} from "@pragma/built-in-agents";
import { z } from "zod";

import type { DesktopSystemExpertRegistry } from "./system-expert-registry.ts";

const MigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.revision-profile-to-system-experts/v1"),
    profile: ContextStoreRevisionProfileSchema,
    completed: z.boolean(),
  })
  .strict();

/** Retire the shared revision preference after preserving it in the editable system Experts. */
export async function migrateLegacyRevisionProfile(options: {
  readonly stateRoot: string;
  readonly systemExperts: DesktopSystemExpertRegistry;
}): Promise<void> {
  const sourcePath = join(options.stateRoot, "context-store-revisions", "profile.json");
  const journalPath = join(
    options.stateRoot,
    "migrations",
    "revision-profile-to-system-experts.json",
  );
  await withFileLock(`${sourcePath}.lock`, async () => {
    let journal: z.infer<typeof MigrationJournalSchema>;
    try {
      journal = MigrationJournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let source: string;
      try {
        source = await readFile(sourcePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const profile = ContextStoreRevisionProfileSchema.parse(JSON.parse(source));
      const backupPath = join(options.stateRoot, "migration-backups", "revision-profile-v1.json");
      await writeAtomic(backupPath, source);
      journal = MigrationJournalSchema.parse({
        schemaVersion: "pragma.revision-profile-to-system-experts/v1",
        profile,
        completed: false,
      });
      await writeAtomic(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    }
    if (journal.completed) return;
    if (journal.profile.mode === "pinned") {
      for (const ref of [STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF]) {
        const current = options.systemExperts.get(ref);
        if (current === undefined)
          throw new Error(`The revision Expert definition is missing: ${ref}`);
        // Existing Studio customizations take precedence. This also makes replay idempotent.
        if (current.customized) continue;
        await options.systemExperts.update(ref, {
          ...(current.avatarId === undefined ? {} : { avatarId: current.avatarId }),
          name: current.name,
          description: current.description,
          tags: current.tags,
          additionalInstructions: current.additionalInstructions,
          model: journal.profile.model,
          capabilities: current.capabilities,
          toolApprovals: current.toolApprovals,
          plugins: current.plugins,
          contextStoreMounts: current.contextStoreMounts,
          resourceTools: current.resourceTools,
        });
      }
    }
    await writeAtomic(journalPath, `${JSON.stringify({ ...journal, completed: true }, null, 2)}\n`);
  });
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
