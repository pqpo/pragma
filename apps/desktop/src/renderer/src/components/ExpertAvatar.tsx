import {
  BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES,
  FALLBACK_PRAGMA_EXPERT_AVATAR_ID,
  resolvePragmaAvatarId,
  type PragmaAvatarOwnerKind,
} from "@pragma/shared";

import avatar01 from "../assets/expert-avatars/expert-01.jpg";
import avatar02 from "../assets/expert-avatars/expert-02.jpg";
import avatar03 from "../assets/expert-avatars/expert-03.jpg";
import avatar04 from "../assets/expert-avatars/expert-04.jpg";
import avatar05 from "../assets/expert-avatars/expert-05.jpg";
import avatar06 from "../assets/expert-avatars/expert-06.jpg";
import avatar07 from "../assets/expert-avatars/expert-07.jpg";
import avatar08 from "../assets/expert-avatars/expert-08.jpg";
import avatar09 from "../assets/expert-avatars/expert-09.jpg";
import avatar10 from "../assets/expert-avatars/expert-10.jpg";
import avatar11 from "../assets/expert-avatars/expert-11.jpg";
import avatar12 from "../assets/expert-avatars/expert-12.jpg";
import avatar13 from "../assets/expert-avatars/expert-13.jpg";
import avatar14 from "../assets/expert-avatars/expert-14.jpg";
import avatar15 from "../assets/expert-avatars/expert-15.jpg";
import avatar16 from "../assets/expert-avatars/expert-16.jpg";
import avatar17 from "../assets/expert-avatars/expert-17.jpg";
import avatar18 from "../assets/expert-avatars/expert-18.jpg";
import avatar19 from "../assets/expert-avatars/expert-19.jpg";
import avatar20 from "../assets/expert-avatars/expert-20.jpg";
import avatar21 from "../assets/expert-avatars/expert-21.jpg";
import avatar22 from "../assets/expert-avatars/expert-22.jpg";
import avatar23 from "../assets/expert-avatars/expert-23.jpg";
import avatar24 from "../assets/expert-avatars/expert-24.jpg";
import avatar25 from "../assets/expert-avatars/expert-25.jpg";
import avatar26 from "../assets/expert-avatars/expert-26.jpg";
import avatar27 from "../assets/expert-avatars/expert-27.jpg";

const avatarSources = [
  avatar01,
  avatar02,
  avatar03,
  avatar04,
  avatar05,
  avatar06,
  avatar07,
  avatar08,
  avatar09,
  avatar10,
  avatar11,
  avatar12,
  avatar13,
  avatar14,
  avatar15,
  avatar16,
  avatar17,
  avatar18,
  avatar19,
  avatar20,
  avatar21,
  avatar22,
  avatar23,
  avatar24,
  avatar25,
  avatar26,
  avatar27,
] as const;

export const EXPERT_AVATAR_OPTIONS = BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES.map(
  (profile, index) => ({
    ...profile,
    id: profile.avatarId,
    source: avatarSources[index]!,
  }),
);

const sourceById = new Map(EXPERT_AVATAR_OPTIONS.map(({ id, source }) => [id, source]));

export function expertAvatarSource(
  avatarId: unknown,
  kind: PragmaAvatarOwnerKind = "expert",
): string {
  const resolved = resolvePragmaAvatarId(kind, avatarId);
  return sourceById.get(resolved) ?? sourceById.get(FALLBACK_PRAGMA_EXPERT_AVATAR_ID)!;
}

export function ExpertAvatar(props: {
  readonly avatarId: unknown;
  readonly team?: boolean | undefined;
  readonly size?: "xs" | "sm" | "md" | "picker" | "lg" | undefined;
  readonly className?: string | undefined;
}) {
  const classes = [
    "pragma-avatar",
    `pragma-avatar-${props.size ?? "md"}`,
    props.team ? "is-team" : undefined,
    props.className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} aria-hidden="true">
      <img src={expertAvatarSource(props.avatarId, props.team ? "team" : "expert")} alt="" />
      {props.team ? <span className="pragma-avatar-team-badge">team</span> : null}
    </span>
  );
}
