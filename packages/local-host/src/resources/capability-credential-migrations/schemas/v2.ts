import { SecretRefSchema } from "@pragma/shared/integration";
import { z } from "zod";

export const CapabilityCredentialsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    credentials: z.record(z.string(), SecretRefSchema),
  })
  .strict();
