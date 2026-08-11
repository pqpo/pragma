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
export const BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS = Object.freeze(
  Array.from({ length: 27 }, (_, index) =>
    PragmaAvatarIdSchema.parse(`pragma.avatar.expert.${String(index + 1).padStart(2, "0")}`),
  ),
);
export const FALLBACK_PRAGMA_EXPERT_AVATAR_ID = BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS[10]!;

export type PragmaAvatarId = z.infer<typeof PragmaAvatarIdSchema>;
export type PragmaAvatarOwnerKind = z.infer<typeof PragmaAvatarOwnerKindSchema>;

export interface PragmaAvatarCatalog {
  readonly expert: readonly PragmaAvatarId[];
  readonly team: readonly PragmaAvatarId[];
}

export const DEFAULT_PRAGMA_AVATAR_CATALOG: PragmaAvatarCatalog = Object.freeze({
  expert: BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS,
  team: BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS,
});

export function defaultPragmaAvatarId(kind: PragmaAvatarOwnerKind): PragmaAvatarId {
  void kind;
  return FALLBACK_PRAGMA_EXPERT_AVATAR_ID;
}

export function resolvePragmaAvatarId(
  kind: PragmaAvatarOwnerKind,
  requestedId: unknown,
  catalog: PragmaAvatarCatalog = DEFAULT_PRAGMA_AVATAR_CATALOG,
): PragmaAvatarId {
  const parsed = PragmaAvatarIdSchema.safeParse(requestedId);
  if (
    parsed.success &&
    (parsed.data === DEFAULT_PRAGMA_EXPERT_AVATAR_ID ||
      parsed.data === DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID)
  ) {
    return FALLBACK_PRAGMA_EXPERT_AVATAR_ID;
  }
  if (parsed.success && catalog[kind].includes(parsed.data)) return parsed.data;
  return defaultPragmaAvatarId(kind);
}

export function randomPragmaExpertAvatarId(random: () => number = Math.random): PragmaAvatarId {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Avatar random source must return a finite number in [0, 1).");
  }
  return BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS[
    Math.floor(value * BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS.length)
  ]!;
}
