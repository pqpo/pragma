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
export const PragmaAvatarGenderSchema = z.enum(["woman", "man", "nonbinary"]);
export const PragmaAvatarPersonalityTraitSchema = z.enum([
  "adaptable",
  "analytical",
  "bold",
  "calm",
  "collaborative",
  "confident",
  "creative",
  "curious",
  "decisive",
  "diplomatic",
  "empathetic",
  "energetic",
  "focused",
  "independent",
  "inventive",
  "meticulous",
  "optimistic",
  "patient",
  "perceptive",
  "persuasive",
  "pragmatic",
  "reliable",
  "sociable",
  "strategic",
  "thoughtful",
]);

export const PragmaExpertAvatarProfileSchema = z
  .object({
    avatarId: PragmaAvatarIdSchema,
    name: z.string().trim().min(1).max(50),
    gender: PragmaAvatarGenderSchema,
    personality: z.array(PragmaAvatarPersonalityTraitSchema).length(3).readonly(),
  })
  .readonly();

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

function defineAvatarProfile(
  index: number,
  name: string,
  gender: PragmaAvatarGender,
  personality: readonly [
    PragmaAvatarPersonalityTrait,
    PragmaAvatarPersonalityTrait,
    PragmaAvatarPersonalityTrait,
  ],
): PragmaExpertAvatarProfile {
  const profile = PragmaExpertAvatarProfileSchema.parse({
    avatarId: BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS[index - 1],
    name,
    gender,
    personality,
  });
  return Object.freeze({ ...profile, personality: Object.freeze(profile.personality) });
}

/**
 * Stable fictional personas for the built-in Expert avatar images. Avatar IDs remain the portable
 * identity; this profile catalog only supplies human- and Agent-readable selection metadata.
 */
export const BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES = Object.freeze([
  defineAvatarProfile(1, "Zara", "woman", ["analytical", "calm", "perceptive"]),
  defineAvatarProfile(2, "Tom", "man", ["curious", "optimistic", "collaborative"]),
  defineAvatarProfile(3, "Kai", "nonbinary", ["decisive", "bold", "pragmatic"]),
  defineAvatarProfile(4, "Mina", "woman", ["patient", "empathetic", "thoughtful"]),
  defineAvatarProfile(5, "Leo", "man", ["creative", "strategic", "confident"]),
  defineAvatarProfile(6, "Noah", "man", ["energetic", "adaptable", "sociable"]),
  defineAvatarProfile(7, "Ada", "woman", ["meticulous", "analytical", "focused"]),
  defineAvatarProfile(8, "Owen", "man", ["pragmatic", "calm", "reliable"]),
  defineAvatarProfile(9, "Eli", "nonbinary", ["curious", "collaborative", "inventive"]),
  defineAvatarProfile(10, "Maya", "woman", ["diplomatic", "empathetic", "strategic"]),
  defineAvatarProfile(11, "Finn", "nonbinary", ["energetic", "optimistic", "adaptable"]),
  defineAvatarProfile(12, "Ruby", "woman", ["bold", "creative", "independent"]),
  defineAvatarProfile(13, "Hugo", "man", ["analytical", "focused", "confident"]),
  defineAvatarProfile(14, "Noor", "woman", ["patient", "thoughtful", "diplomatic"]),
  defineAvatarProfile(15, "Jamie", "nonbinary", ["adaptable", "collaborative", "curious"]),
  defineAvatarProfile(16, "Skye", "woman", ["decisive", "bold", "energetic"]),
  defineAvatarProfile(17, "Iris", "woman", ["strategic", "meticulous", "calm"]),
  defineAvatarProfile(18, "Felix", "man", ["sociable", "optimistic", "persuasive"]),
  defineAvatarProfile(19, "Cora", "woman", ["creative", "perceptive", "confident"]),
  defineAvatarProfile(20, "Theo", "man", ["pragmatic", "reliable", "collaborative"]),
  defineAvatarProfile(21, "Nia", "woman", ["calm", "empathetic", "focused"]),
  defineAvatarProfile(22, "Evan", "man", ["analytical", "inventive", "meticulous"]),
  defineAvatarProfile(23, "Luna", "woman", ["perceptive", "creative", "empathetic"]),
  defineAvatarProfile(24, "Alex", "nonbinary", ["independent", "adaptable", "curious"]),
  defineAvatarProfile(25, "Vera", "woman", ["thoughtful", "strategic", "reliable"]),
  defineAvatarProfile(26, "Sam", "man", ["energetic", "pragmatic", "optimistic"]),
  defineAvatarProfile(27, "Cleo", "woman", ["inventive", "decisive", "sociable"]),
]);

const expertAvatarProfileById = new Map(
  BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES.map((profile) => [profile.avatarId, profile]),
);

export type PragmaAvatarId = z.infer<typeof PragmaAvatarIdSchema>;
export type PragmaAvatarOwnerKind = z.infer<typeof PragmaAvatarOwnerKindSchema>;
export type PragmaAvatarGender = z.infer<typeof PragmaAvatarGenderSchema>;
export type PragmaAvatarPersonalityTrait = z.infer<typeof PragmaAvatarPersonalityTraitSchema>;
export type PragmaExpertAvatarProfile = z.infer<typeof PragmaExpertAvatarProfileSchema>;

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

export function resolvePragmaExpertAvatarProfile(avatarId: unknown): PragmaExpertAvatarProfile {
  const resolved = resolvePragmaAvatarId("expert", avatarId);
  return (
    expertAvatarProfileById.get(resolved) ??
    expertAvatarProfileById.get(FALLBACK_PRAGMA_EXPERT_AVATAR_ID)!
  );
}
