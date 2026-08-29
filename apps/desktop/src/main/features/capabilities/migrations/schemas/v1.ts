import { z } from "zod";
export const CapabilityCredentialsV1Schema = z.object({ schemaVersion: z.literal(1), credentials: z.record(z.string(), z.string()) });
