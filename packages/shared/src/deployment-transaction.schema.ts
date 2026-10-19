import { z } from "zod";
export const BundleInstallationTransactionSchema = z
  .object({
    requestId: z.string().uuid(),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    baseRevision: z.number().int().nonnegative(),
    publicationId: z.string().uuid(),
    input: z.record(z.string(), z.unknown()),
    identities: z.array(
      z
        .object({
          sourceRef: z.string().min(1),
          targetId: z.string().min(1),
          targetName: z.string().min(1),
        })
        .strict(),
    ),
    assets: z.record(
      z.string(),
      z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    ),
    phase: z.enum(["assets", "published", "completed"]),
  })
  .strict();
