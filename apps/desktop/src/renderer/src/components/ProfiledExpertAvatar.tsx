import {
  resolvePragmaExpertAvatarProfile,
  type PragmaAvatarPersonalityTrait,
} from "@pragma/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ExpertAvatar } from "./ExpertAvatar.tsx";

export const EXPERT_AVATAR_PROFILE_HOVER_DELAY_MS = 500;
const AVATAR_PROFILE_CARD_GAP = 10;
const AVATAR_PROFILE_VIEWPORT_MARGIN = 12;

type AvatarProfileCardPlacement = "bottom" | "top" | "right" | "left";

export interface AvatarProfileCardRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface AvatarProfileCardPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: AvatarProfileCardPlacement;
}

function clampToViewport(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function positionAvatarProfileCard(input: {
  readonly anchor: AvatarProfileCardRect;
  readonly card: Pick<AvatarProfileCardRect, "width" | "height">;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number | undefined;
  readonly margin?: number | undefined;
}): AvatarProfileCardPosition {
  const gap = input.gap ?? AVATAR_PROFILE_CARD_GAP;
  const margin = input.margin ?? AVATAR_PROFILE_VIEWPORT_MARGIN;
  const available: Record<AvatarProfileCardPlacement, number> = {
    bottom: input.viewport.height - margin - input.anchor.bottom - gap,
    top: input.anchor.top - margin - gap,
    right: input.viewport.width - margin - input.anchor.right - gap,
    left: input.anchor.left - margin - gap,
  };
  const required: Record<AvatarProfileCardPlacement, number> = {
    bottom: input.card.height,
    top: input.card.height,
    right: input.card.width,
    left: input.card.width,
  };
  const preferred: readonly AvatarProfileCardPlacement[] = ["bottom", "top", "right", "left"];
  const placement =
    preferred.find((candidate) => available[candidate] >= required[candidate]) ??
    preferred.reduce((best, candidate) =>
      available[candidate] > available[best] ? candidate : best,
    );

  let left = input.anchor.left + (input.anchor.width - input.card.width) / 2;
  let top = input.anchor.bottom + gap;
  if (placement === "top") top = input.anchor.top - gap - input.card.height;
  if (placement === "right") {
    left = input.anchor.right + gap;
    top = input.anchor.top + (input.anchor.height - input.card.height) / 2;
  }
  if (placement === "left") {
    left = input.anchor.left - gap - input.card.width;
    top = input.anchor.top + (input.anchor.height - input.card.height) / 2;
  }

  return {
    placement,
    left: clampToViewport(left, margin, input.viewport.width - margin - input.card.width),
    top: clampToViewport(top, margin, input.viewport.height - margin - input.card.height),
  };
}

function personalityLabel(trait: PragmaAvatarPersonalityTrait, t: (key: string) => string): string {
  return t(`avatarPersonalityTraits.${trait}`);
}

const useSafeLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

export function ProfiledExpertAvatar(props: {
  readonly avatarId: unknown;
  readonly team?: boolean | undefined;
  readonly size?: "xs" | "sm" | "md" | "picker" | "lg" | undefined;
  readonly className?: string | undefined;
}) {
  const { t } = useTranslation("studio");
  const profile = resolvePragmaExpertAvatarProfile(props.avatarId);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<AvatarProfileCardPosition | null>(null);

  const hide = useCallback(() => {
    if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    showTimerRef.current = undefined;
    setOpen(false);
    setPosition(null);
  }, []);
  const scheduleShow = useCallback(() => {
    if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = undefined;
      setOpen(true);
    }, EXPERT_AVATAR_PROFILE_HOVER_DELAY_MS);
  }, []);
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (anchor === undefined || card === undefined) return;
    setPosition(
      positionAvatarProfileCard({
        anchor,
        card,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    );
  }, []);

  useEffect(
    () => () => {
      if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    },
    [],
  );
  useSafeLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);
  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reposition);
    if (anchorRef.current !== null) observer?.observe(anchorRef.current);
    if (cardRef.current !== null) observer?.observe(cardRef.current);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [open, updatePosition]);

  const card = open ? (
    <span
      className={
        position === null
          ? "expert-avatar-profile-card"
          : "expert-avatar-profile-card is-positioned"
      }
      data-placement={position?.placement}
      ref={cardRef}
      role="tooltip"
      style={
        position === null
          ? undefined
          : ({ left: position.left, top: position.top } satisfies CSSProperties)
      }
    >
      <strong>{profile.name}</strong>
      <span>
        <small>{t("avatarGender")}</small>
        {t(`avatarGenders.${profile.gender}`)}
      </span>
      <span>
        <small>{t("avatarPersonality")}</small>
        {profile.personality.map((trait) => personalityLabel(trait, t)).join(" · ")}
      </span>
    </span>
  ) : null;

  return (
    <span
      className={["expert-avatar-profile", props.className].filter(Boolean).join(" ")}
      data-avatar-profile={profile.avatarId}
      ref={anchorRef}
      onMouseEnter={scheduleShow}
      onMouseLeave={hide}
    >
      <ExpertAvatar avatarId={profile.avatarId} team={props.team} size={props.size} />
      {card !== null && typeof document !== "undefined" ? createPortal(card, document.body) : null}
    </span>
  );
}
