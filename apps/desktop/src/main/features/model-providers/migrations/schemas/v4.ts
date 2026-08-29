import { z } from "zod";

/** Historical on-disk shape; only the migration adapter may read this schema. */
export const ModelProvidersV4Schema = z.object({
  schemaVersion: z.literal(4),
  providers: z.array(z.object({ id: z.string().uuid(), encryptedApiKey: z.string() }).passthrough()),
});
