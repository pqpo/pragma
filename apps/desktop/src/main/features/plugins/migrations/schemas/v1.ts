import { z } from "zod";
export const PluginCredentialsV1Schema = z.object({ schemaVersion: z.literal(1), credentials: z.record(z.string(), z.string()) });
