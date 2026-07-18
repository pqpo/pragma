import { z } from "zod";

export const CodeRepositoryAuthSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("none"),
  }),
  z.object({
    strategy: z.literal("token"),
    token: z.string().min(1),
    username: z.string().min(1).default("x-access-token"),
  }),
  z.object({
    strategy: z.literal("ssh"),
    privateKey: z.string().min(1),
    knownHosts: z.string().min(1).optional(),
  }),
  z.object({
    strategy: z.literal("credential_helper"),
    helper: z.string().min(1),
  }),
]);

export const RepoManagerConfigSchema = z
  .object({
    auth: CodeRepositoryAuthSchema.default({ strategy: "none" }),
  })
  .strict();

export type CodeRepositoryAuth = z.infer<typeof CodeRepositoryAuthSchema>;
export type RepoManagerConfig = z.infer<typeof RepoManagerConfigSchema>;
export type RepoManagerConfigInput = z.input<typeof RepoManagerConfigSchema>;

export function parseRepoManagerConfig(input: RepoManagerConfigInput): RepoManagerConfig {
  return RepoManagerConfigSchema.parse(input);
}
