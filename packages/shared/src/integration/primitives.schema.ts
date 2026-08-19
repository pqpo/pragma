import { z } from "zod";

export const IntegrationProtocolVersionSchema = z.literal("pragma.integration/v1");

export const RequestIdSchema = z.string().uuid();
export const EventIdSchema = z.string().uuid();
export const MissionIdSchema = z.string().uuid();
export const OperationIdSchema = z.string().uuid();
export const CommandIdSchema = z.string().uuid();
export const ExecutionIdSchema = z.string().uuid();
export const InteractionIdSchema = z.string().min(1).max(512);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const OpaqueCursorSchema = z.string().min(1).max(4_096);
export const PayloadHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const FencingTokenSchema = z.string().regex(/^[1-9][0-9]*$/);
export const SemanticResourceIdSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{16}$/);

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const IntegrationRequestMetaSchema = z
  .object({
    schemaVersion: z.literal("pragma.integration-request/v1"),
    requestId: RequestIdSchema,
    payloadHash: PayloadHashSchema,
    requestedAt: IsoDateTimeSchema,
    client: z
      .object({
        surface: z.enum(["cli", "desktop"]),
        version: z.string().min(1),
        instanceId: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

export const IntegrationCapabilitySchema = z
  .object({
    schemaVersion: z.literal("pragma.integration-capability/v1"),
    protocol: IntegrationProtocolVersionSchema,
    readableVersions: z.array(z.string().min(1)),
    migratableFromVersions: z.array(z.string().min(1)),
    features: z.array(z.string().min(1)),
  })
  .strict();

export type IntegrationRequestMeta = z.infer<typeof IntegrationRequestMetaSchema>;
export type IntegrationCapability = z.infer<typeof IntegrationCapabilitySchema>;
