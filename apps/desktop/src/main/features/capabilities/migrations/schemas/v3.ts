import { SecretRefSchema } from "@pragma/shared/integration";
import { z } from "zod";

export const CapabilityCredentialBindingSchema = z
  .object({
    generation: z.string().uuid(),
    ref: SecretRefSchema,
  })
  .strict();

export const CapabilityCredentialsV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    credentials: z.record(z.string(), CapabilityCredentialBindingSchema),
  })
  .strict();
