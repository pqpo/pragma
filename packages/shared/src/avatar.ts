import { z } from "zod";

export const PragmaAvatarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/u,
    "Use only lowercase letters, numbers, dots, underscores, and hyphens.",
  );

export const PragmaAvatarOwnerKindSchema = z.enum(["expert", "team"]);

export const DEFAULT_PRAGMA_EXPERT_AVATAR_ID = PragmaAvatarIdSchema.parse(
  "pragma.avatar.expert.default",
);
export const DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID = PragmaAvatarIdSchema.parse(
  "pragma.avatar.team.default",
);

export type PragmaAvatarId = z.infer<typeof PragmaAvatarIdSchema>;
export type PragmaAvatarOwnerKind = z.infer<typeof PragmaAvatarOwnerKindSchema>;

export interface PragmaAvatarCatalog {
  readonly expert: readonly PragmaAvatarId[];
  readonly team: readonly PragmaAvatarId[];
}

export const DEFAULT_PRAGMA_AVATAR_CATALOG: PragmaAvatarCatalog = Object.freeze({
  expert: Object.freeze([DEFAULT_PRAGMA_EXPERT_AVATAR_ID]),
  team: Object.freeze([DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID]),
});

export function defaultPragmaAvatarId(kind: PragmaAvatarOwnerKind): PragmaAvatarId {
  return kind === "expert" ? DEFAULT_PRAGMA_EXPERT_AVATAR_ID : DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID;
}

export function resolvePragmaAvatarId(
  kind: PragmaAvatarOwnerKind,
  requestedId: unknown,
  catalog: PragmaAvatarCatalog = DEFAULT_PRAGMA_AVATAR_CATALOG,
): PragmaAvatarId {
  const parsed = PragmaAvatarIdSchema.safeParse(requestedId);
  if (parsed.success && catalog[kind].includes(parsed.data)) return parsed.data;
  return defaultPragmaAvatarId(kind);
}
