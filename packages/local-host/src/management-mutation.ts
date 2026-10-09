import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "@pragma/core";
import { managementCommandError } from "@pragma/shared/integration";
import { z } from "zod";
import { readCommandState } from "./management-command-ownership.ts";

/** A prepared platform plan must contain stable identities for every replayed side effect. */
export async function executeManagementMutation<S, R>(options: {
  readonly root: string;
  readonly operationId: string;
  readonly target: string;
  readonly input: unknown;
  readonly stateSchema: z.ZodType<S>;
  readonly resultSchema: z.ZodType<R>;
  readonly prepare: () => Promise<S>;
  readonly apply: (
    state: S,
    publicationId: string,
    progress: {
      readonly completed: (step: string) => boolean;
      readonly complete: (step: string) => Promise<void>;
    },
  ) => Promise<R>;
}): Promise<R> {
  const identity = createHash("sha256").update(options.operationId).digest("hex");
  const path = join(options.root, "operations", `${identity}.json`);
  const targetLock = join(
    options.root,
    "targets",
    `${createHash("sha256").update(options.target).digest("hex")}.lock`,
  );
  const payloadHash = createHash("sha256").update(JSON.stringify(options.input)).digest("hex");
  const schema = z
    .object({
      schemaVersion: z.literal("pragma.management-mutation/v1"),
      target: z.string(),
      payloadHash: z.string(),
      publicationId: z.string().uuid(),
      state: options.stateSchema,
      completedSteps: z.array(z.string()).default([]),
      result: options.resultSchema.optional(),
    })
    .strict();
  return await withFileLock(
    `${path}.lock`,
    async () =>
      await withFileLock(targetLock, async () => {
        const existing = await readCommandState(path, schema, "pragma.management-mutation/v1");
        if (
          existing !== undefined &&
          (existing.target !== options.target || existing.payloadHash !== payloadHash)
        )
          throw managementCommandError(
            "IDEMPOTENCY_CONFLICT",
            "The mutation operation owns different input.",
          );
        if (existing?.result !== undefined) return existing.result;
        const journal =
          existing ??
          schema.parse({
            schemaVersion: "pragma.management-mutation/v1",
            target: options.target,
            payloadHash,
            publicationId: randomUUID(),
            state: await options.prepare(),
          });
        const save = async (value: unknown) => {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const temporary = `${path}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(schema.parse(value))}\n`, { mode: 0o600 });
          await rename(temporary, path);
        };
        if (existing === undefined) await save(journal);
        const completed = new Set(journal.completedSteps);
        const result = options.resultSchema.parse(
          await options.apply(journal.state, journal.publicationId, {
            completed: (step) => completed.has(step),
            complete: async (step) => {
              completed.add(step);
              journal.completedSteps = [...completed];
              await save(journal);
            },
          }),
        );
        await save({ ...journal, result });
        return result;
      }),
  );
}
