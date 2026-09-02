import { z } from "zod";

const EXPERT_MENTION_ID = "[0-9a-hjkmnp-tv-z]{16}";

export const ExpertMentionRefSchema = z
  .string()
  .regex(new RegExp(`^expert:${EXPERT_MENTION_ID}$`), "Expected a canonical Expert reference.");

export const ExpertMentionSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("mention"), ref: ExpertMentionRefSchema }).strict(),
]);

export type ExpertMentionSegment = z.infer<typeof ExpertMentionSegmentSchema>;

const EXPERT_MENTION_TOKEN = new RegExp(`<@(expert:${EXPERT_MENTION_ID})>`, "g");

export function formatExpertMentionToken(ref: string): string {
  return `<@${ExpertMentionRefSchema.parse(ref)}>`;
}

export function parseExpertMentionSegments(value: string): readonly ExpertMentionSegment[] {
  const segments: ExpertMentionSegment[] = [];
  let offset = 0;
  for (const match of value.matchAll(EXPERT_MENTION_TOKEN)) {
    const index = match.index;
    const ref = match[1];
    if (index > offset) segments.push({ kind: "text", text: value.slice(offset, index) });
    if (ref !== undefined) segments.push({ kind: "mention", ref });
    offset = index + match[0].length;
  }
  if (offset < value.length) segments.push({ kind: "text", text: value.slice(offset) });
  return segments.length === 0 ? [{ kind: "text", text: value }] : segments;
}

export function serializeExpertMentionSegments(segments: readonly ExpertMentionSegment[]): string {
  return segments
    .map((segment) =>
      segment.kind === "mention" ? formatExpertMentionToken(segment.ref) : segment.text,
    )
    .join("");
}
