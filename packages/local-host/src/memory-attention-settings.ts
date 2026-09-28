import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  MemoryAttentionStatusSchema,
  UpdateMemoryAttentionSettingsSchema,
  type MemoryAttentionStatus,
  type UpdateMemoryAttentionSettings,
} from "@pragma/shared";
import { SecretRefSchema } from "@pragma/shared/integration";
import {
  createJevDecisionProvider,
  readAttentionJson,
  writeAttentionJson,
  MemoryDecisionProviderError,
} from "@pragma/memory";
import { z } from "zod";
import type { SecretStore } from "./secrets/secret-store.ts";

const SettingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-attention-settings/v1"),
    revision: z.number().int().nonnegative(),
    secretRef: SecretRefSchema.optional(),
    diagnostic: z
      .object({
        code: z.string(),
        permanent: z.boolean(),
        failures: z.number().int().nonnegative(),
        retryAt: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
const JournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-attention-settings-journal/v1"),
    previous: SettingsSchema,
    providerId: z.string().nullable(),
  })
  .strict();
export type MemoryAttentionSettings = z.infer<typeof SettingsSchema>;
export function createMemoryAttentionSettingsStore(options: {
  pragmaHome: string;
  secrets: SecretStore;
  fetch?: typeof fetch;
}) {
  const paths = new PragmaPaths(options);
  const path = paths.memoryAttentionSettings();
  const journalPath = `${path}.journal`;
  const read = async () => {
    const value = await readAttentionJson(path);
    return value === undefined
      ? SettingsSchema.parse({ schemaVersion: "pragma.memory-attention-settings/v1", revision: 0 })
      : SettingsSchema.parse(value);
  };
  const recover = async () => {
    const raw = await readAttentionJson(journalPath);
    if (raw === undefined) return;
    const journal = JournalSchema.parse(raw);
    const ref =
      journal.providerId === null
        ? undefined
        : (await options.secrets.listMetadata({ kind: "model-provider" })).find(
            (ref) =>
              ref.owner.kind === "model-provider" && ref.owner.providerId === journal.providerId,
          );
    if (journal.providerId !== null && ref === undefined) {
      await rm(journalPath);
      return;
    }
    const next = SettingsSchema.parse({
      schemaVersion: "pragma.memory-attention-settings/v1",
      revision: journal.previous.revision + 1,
      ...(ref === undefined ? {} : { secretRef: ref }),
    });
    await writeAttentionJson(path, next);
    if (journal.previous.secretRef !== undefined) {
      // Delete is replayable; a committed configuration never points to the previous key.
      await options.secrets
        .delete(journal.previous.secretRef, journal.previous.secretRef.revision)
        .catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "SECRET_NOT_FOUND"))
            throw error;
        });
    }
    await rm(journalPath);
  };
  const get = async () =>
    await withFileLock(`${path}.lock`, async () => {
      await recover();
      return await read();
    });
  return {
    get,
    async status(): Promise<MemoryAttentionStatus> {
      const settings = await get();
      return MemoryAttentionStatusSchema.parse({
        revision: settings.revision,
        configured: settings.secretRef !== undefined,
        state:
          settings.secretRef === undefined
            ? "disabled"
            : settings.diagnostic?.permanent
              ? "needs_attention"
              : settings.diagnostic === undefined
                ? "ready"
                : "degraded",
        ...(settings.diagnostic === undefined ? {} : { errorCode: settings.diagnostic.code }),
      });
    },
    async update(raw: UpdateMemoryAttentionSettings): Promise<void> {
      const input = UpdateMemoryAttentionSettingsSchema.parse(raw);
      if (input.apiKey !== null)
        await createJevDecisionProvider({
          getApiKey: async () => input.apiKey!,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }).validate();
      await withFileLock(`${path}.lock`, async () => {
        await recover();
        const previous = await read();
        if (previous.revision !== input.expectedRevision)
          throw new Error("attention_settings_conflict");
        const providerId = input.apiKey === null ? null : `memory-attention-jev:${randomUUID()}`;
        await writeAttentionJson(
          journalPath,
          JournalSchema.parse({
            schemaVersion: "pragma.memory-attention-settings-journal/v1",
            previous,
            providerId,
          }),
        );
        if (providerId !== null)
          await options.secrets.put({
            owner: { kind: "model-provider", providerId },
            value: Buffer.from(input.apiKey!, "utf8"),
          });
        await recover();
      });
    },
    async recordDiagnostic(code: string | undefined, generation: number): Promise<void> {
      await withFileLock(`${path}.lock`, async () => {
        await recover();
        const current = await read();
        if (current.revision !== generation) return;
        if (current.diagnostic?.permanent) return;
        const failures = code === undefined ? 0 : (current.diagnostic?.failures ?? 0) + 1;
        const permanent =
          code === "attention_auth_invalid" ||
          code === "attention_request_invalid" ||
          code === "attention_response_invalid";
        const { diagnostic: _diagnostic, ...base } = current;
        void _diagnostic;
        await writeAttentionJson(path, {
          ...base,
          ...(code === undefined
            ? {}
            : {
                diagnostic: {
                  code,
                  permanent,
                  failures,
                  retryAt: failures >= 3 ? Date.now() + 60_000 : 0,
                },
              }),
        });
      });
    },
    async beforeRequest(): Promise<void> {
      const ratePath = paths.memoryAttentionRateLimit();
      await withFileLock(`${ratePath}.lock`, async () => {
        const raw = await readAttentionJson(ratePath);
        const schema = z
          .object({
            schemaVersion: z.literal("pragma.memory-attention-rate-limit/v1"),
            timestamps: z.array(z.number().nonnegative()).max(60),
          })
          .strict();
        const timestamps =
          raw === undefined
            ? []
            : schema.parse(raw).timestamps.filter((timestamp) => timestamp > Date.now() - 60_000);
        if (timestamps.length >= 60)
          throw new MemoryDecisionProviderError("attention_rate_limited", true);
        await writeAttentionJson(ratePath, {
          schemaVersion: "pragma.memory-attention-rate-limit/v1",
          timestamps: [...timestamps, Date.now()],
        });
      });
    },
  };
}
