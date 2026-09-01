import { useCallback, useEffect, useRef, useState } from "react";

import type { ExpertPromptAttachment } from "@pragma/shared";

import type {
  Mission,
  PickMissionAttachmentsResult,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import {
  mergeMissionAttachmentPreviews,
  mergeMissionAttachments,
} from "../../lib/mission-attachments.ts";
import { readMissionDraft, writeMissionDraft } from "../../lib/mission-draft.ts";

export function useMissionComposerState(options: {
  readonly mission: Pick<Mission, "id" | "lifecycleStatus">;
  readonly discardDrafts?: PragmaDesktopAPI["discardMissionAttachmentDrafts"] | undefined;
  readonly onAttachmentLimit: () => void;
  readonly onAttachmentsAccepted: () => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(options.mission));
  const [attachments, setAttachments] = useState<readonly ExpertPromptAttachment[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const attachmentIdsRef = useRef<readonly string[]>([]);
  const draftMissionIdRef = useRef<string | null>(options.mission.id);
  const callbacksRef = useRef({
    onAttachmentLimit: options.onAttachmentLimit,
    onAttachmentsAccepted: options.onAttachmentsAccepted,
  });
  callbacksRef.current = {
    onAttachmentLimit: options.onAttachmentLimit,
    onAttachmentsAccepted: options.onAttachmentsAccepted,
  };

  const discard = useCallback(
    (attachmentIds: readonly string[]): void => {
      if (attachmentIds.length > 0) {
        void options.discardDrafts?.({ attachmentIds: [...attachmentIds] });
      }
    },
    [options.discardDrafts],
  );

  const clearAttachments = useCallback((): void => {
    attachmentIdsRef.current = [];
    setAttachments([]);
    setAttachmentPreviews({});
  }, []);

  const restoreAttachments = useCallback(
    (
      restoredAttachments: readonly ExpertPromptAttachment[],
      restoredPreviews: Readonly<Record<string, string>>,
    ): void => {
      attachmentIdsRef.current = restoredAttachments.map((attachment) => attachment.id);
      setAttachments(restoredAttachments);
      setAttachmentPreviews(restoredPreviews);
    },
    [],
  );

  const addAttachments = useCallback(
    (result: PickMissionAttachmentsResult): void => {
      setAttachments((current) => {
        const next = mergeMissionAttachments(current, result.attachments);
        if (next === undefined) {
          callbacksRef.current.onAttachmentLimit();
          discard(result.attachments.map((attachment) => attachment.id));
          return current;
        }
        const acceptedIds = new Set(next.map((attachment) => attachment.id));
        const rejectedIds = result.attachments
          .filter((attachment) => !acceptedIds.has(attachment.id))
          .map((attachment) => attachment.id);
        discard(rejectedIds);
        attachmentIdsRef.current = next.map((attachment) => attachment.id);
        if (next.length > current.length) {
          setAttachmentPreviews((previews) =>
            mergeMissionAttachmentPreviews(previews, result, next),
          );
          callbacksRef.current.onAttachmentsAccepted();
        }
        return next;
      });
    },
    [discard],
  );

  const removeAttachment = useCallback(
    (id: string): void => {
      discard([id]);
      setAttachments((current) => {
        const next = current.filter((attachment) => attachment.id !== id);
        attachmentIdsRef.current = next.map((attachment) => attachment.id);
        return next;
      });
      setAttachmentPreviews((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [discard],
  );

  useEffect(
    () => () => {
      discard(attachmentIdsRef.current);
    },
    [discard],
  );

  useEffect(() => {
    discard(attachmentIdsRef.current);
    attachmentIdsRef.current = [];
    draftMissionIdRef.current = null;
    setDraft(initialDraft(options.mission));
    setAttachments([]);
    setAttachmentPreviews({});
  }, [discard, options.mission.id]);

  useEffect(() => {
    if (draftMissionIdRef.current === null) {
      draftMissionIdRef.current = options.mission.id;
      return;
    }
    if (draftMissionIdRef.current !== options.mission.id) return;
    writeMissionDraft(
      typeof window === "undefined" ? undefined : window.localStorage,
      options.mission.id,
      draft,
    );
  }, [draft, options.mission.id]);

  useEffect(() => {
    if (options.mission.lifecycleStatus !== "completed") return;
    setDraft("");
    discard(attachmentIdsRef.current);
    clearAttachments();
    writeMissionDraft(
      typeof window === "undefined" ? undefined : window.localStorage,
      options.mission.id,
      "",
    );
  }, [clearAttachments, discard, options.mission.id, options.mission.lifecycleStatus]);

  return {
    draft,
    setDraft,
    attachments,
    attachmentPreviews,
    clearAttachments,
    restoreAttachments,
    addAttachments,
    removeAttachment,
    discardAttachments: discard,
  };
}

function initialDraft(mission: Pick<Mission, "id" | "lifecycleStatus">): string {
  return mission.lifecycleStatus === "active"
    ? readMissionDraft(typeof window === "undefined" ? undefined : window.localStorage, mission.id)
    : "";
}
