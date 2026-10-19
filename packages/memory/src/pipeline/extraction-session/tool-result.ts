import { deliver } from "./evidence.ts";
import type { SessionState } from "./schema.ts";

/** Internal operation data; presentation text is never parsed to recover control fields. */
export type ExtractionToolResult = {
  text: string;
  candidate?: string;
  cursor?: number;
  pageCursor?: string;
};

/** Historical tools keep their original footer; v2 presents continuation in Feedback. */
export function paginatedToolResult(
  state: SessionState,
  body: string,
  legacyFooter: string,
  continuation: Pick<ExtractionToolResult, "cursor" | "pageCursor">,
): ExtractionToolResult {
  return {
    text: deliver(
      state,
      state.toolContractVersion === 1 ? [body, legacyFooter].filter(Boolean).join("\n") : body,
    ),
    ...continuation,
  };
}
