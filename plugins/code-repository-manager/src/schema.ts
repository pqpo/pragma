import { z } from "zod";

export const CodeRepositoryContextInjectionModeSchema = z
  .enum(["model_decision", "always_on"])
  .default("model_decision");

export const CodeRepositoryAuthSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("none"),
  }),
  z.object({
    strategy: z.literal("token"),
    tokenEnv: z.string().min(1),
    username: z.string().min(1).default("x-access-token"),
  }),
  z.object({
    strategy: z.literal("ssh"),
    privateKeyEnv: z.string().min(1),
    knownHostsEnv: z.string().min(1).optional(),
  }),
  z.object({
    strategy: z.literal("credential_helper"),
    helperEnv: z.string().min(1),
  }),
]);

export const CodeRepositorySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().min(1),
  cloneUrl: z.string().min(1).refine(isSafeCloneUrl, {
    message:
      "cloneUrl must be an https:// URL, ssh:// URL, or scp-style SSH URL without embedded credentials.",
  }),
  defaultBranch: z.string().min(1).refine(isSafeBranchName, {
    message: "defaultBranch must be a valid branch name and must not start with '-'.",
  }),
  provider: z.enum(["github", "gitlab", "bitbucket", "generic"]).default("generic"),
  description: z.string().min(1).optional(),
  allowedBranches: z.array(z.string().min(1).refine(isSafeBranchName)).optional(),
  shallowClone: z.boolean().default(true),
});

export const CodeRepositoryManagerConfigSchema = z
  .object({
    contextInjection: z
      .object({
        mode: CodeRepositoryContextInjectionModeSchema,
      })
      .default({ mode: "model_decision" }),
    auth: CodeRepositoryAuthSchema.default({ strategy: "none" }),
    repositories: z.array(CodeRepositorySchema).default([]),
  })
  .superRefine((config, context) => {
    const seenIds = new Set<string>();

    for (const [index, repository] of config.repositories.entries()) {
      if (seenIds.has(repository.id)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "id"],
          message: `Duplicate repository id: ${repository.id}`,
        });
      }

      seenIds.add(repository.id);

      if (
        repository.allowedBranches !== undefined &&
        !repository.allowedBranches.includes(repository.defaultBranch)
      ) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "allowedBranches"],
          message: "allowedBranches must include defaultBranch.",
        });
      }
    }
  });

export type CodeRepositoryContextInjectionMode = z.infer<
  typeof CodeRepositoryContextInjectionModeSchema
>;
export type CodeRepositoryAuth = z.infer<typeof CodeRepositoryAuthSchema>;
export type CodeRepository = z.infer<typeof CodeRepositorySchema>;
export type CodeRepositoryManagerConfig = z.infer<typeof CodeRepositoryManagerConfigSchema>;
export type CodeRepositoryManagerConfigInput = z.input<typeof CodeRepositoryManagerConfigSchema>;

export const CodeRepositoryManagerRepositoriesContextSchema = z.union([
  z.array(CodeRepositorySchema),
  z.object({
    repositories: z.array(CodeRepositorySchema),
  }),
]);

export type CodeRepositoryManagerRepositoriesContext = z.infer<
  typeof CodeRepositoryManagerRepositoriesContextSchema
>;

export function parseCodeRepositoryManagerConfig(
  input: CodeRepositoryManagerConfigInput,
): CodeRepositoryManagerConfig {
  return CodeRepositoryManagerConfigSchema.parse(input);
}

export function parseCodeRepositoryManagerRepositoriesContext(
  input: unknown,
): readonly CodeRepository[] {
  const context = CodeRepositoryManagerRepositoriesContextSchema.parse(input);

  return Array.isArray(context) ? context : context.repositories;
}

function isSafeCloneUrl(value: string): boolean {
  if (value !== value.trim() || value.startsWith("-") || hasControlCharacter(value)) {
    return false;
  }

  if (isScpStyleSshUrl(value)) {
    return true;
  }

  try {
    const url = new URL(value);

    if (url.username.length > 0 || url.password.length > 0) {
      return false;
    }

    return url.protocol === "https:" || url.protocol === "ssh:";
  } catch {
    return false;
  }
}

function isScpStyleSshUrl(value: string): boolean {
  return /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[^\s\0]+$/.test(value);
}

function isSafeBranchName(value: string): boolean {
  if (
    value !== value.trim() ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("@{") ||
    hasUnsafeBranchCharacter(value)
  ) {
    return false;
  }

  return value.split("/").every((part) => {
    return (
      part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")
    );
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function hasUnsafeBranchCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || "~^:?*[\\".includes(character);
  });
}
