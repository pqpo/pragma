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
import { createMissionDraftPersistence, readMissionDraft } from "../../lib/mission-draft.ts";

export function useMissionComposerState(options: {
  readonly mission: Pick<Mission, "id" | "lifecycleStatus">;
  readonly initialDraft?: string | undefined;
  readonly initialAttachments?: readonly ExpertPromptAttachment[] | undefined;
  readonly initialAttachmentPreviews?: Readonly<Record<string, string>> | undefined;
  readonly discardDrafts?: PragmaDesktopAPI["discardMissionAttachmentDrafts"] | undefined;
  readonly onUnmountState?:
    | ((state: {
        readonly missionId: string;
        readonly draft: string;
        readonly attachments: readonly ExpertPromptAttachment[];
        readonly attachmentPreviews: Readonly<Record<string, string>>;
      }) => void)
    | undefined;
  readonly onAttachmentLimit: () => void;
  readonly onAttachmentsAccepted: () => void;
}) {
  const initialDraftOverrideRef = useRef(
    options.initialDraft === undefined
      ? undefined
      : { missionId: options.mission.id, draft: options.initialDraft },
  );
  const initialMissionLifecycleStatusRef = useRef(options.mission.lifecycleStatus);
  const lifecycleStatusRef = useRef({
    missionId: options.mission.id,
    status: options.mission.lifecycleStatus,
  });
  const [draft, setDraft] = useState(() =>
    initialDraft(options.mission, initialDraftOverrideRef.current),
  );
  const [attachments, setAttachments] = useState<readonly ExpertPromptAttachment[]>(
    () => options.initialAttachments ?? [],
  );
  const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
    () => options.initialAttachmentPreviews ?? {},
  );
  const attachmentIdsRef = useRef<readonly string[]>(
    (options.initialAttachments ?? []).map((attachment) => attachment.id),
  );
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  const attachmentPreviewsRef = useRef(attachmentPreviews);
  draftRef.current = draft;
  attachmentsRef.current = attachments;
  attachmentPreviewsRef.current = attachmentPreviews;
  const missionIdRef = useRef(options.mission.id);
  const draftPersistenceRef = useRef<ReturnType<typeof createMissionDraftPersistence> | null>(null);
  if (draftPersistenceRef.current === null) {
    draftPersistenceRef.current = createMissionDraftPersistence(
      typeof window === "undefined" ? undefined : window.localStorage,
    );
  }
  const callbacksRef = useRef({
    onAttachmentLimit: options.onAttachmentLimit,
    onAttachmentsAccepted: options.onAttachmentsAccepted,
    onUnmountState: options.onUnmountState,
    discardDrafts: options.discardDrafts,
  });
  callbacksRef.current = {
    onAttachmentLimit: options.onAttachmentLimit,
    onAttachmentsAccepted: options.onAttachmentsAccepted,
    onUnmountState: options.onUnmountState,
    discardDrafts: options.discardDrafts,
  };

  const discard = useCallback((attachmentIds: readonly string[]): void => {
    if (attachmentIds.length > 0) {
      void callbacksRef.current.discardDrafts?.({ attachmentIds: [...attachmentIds] });
    }
  }, []);

  const updateDraft = useCallback((nextDraft: string): void => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const clearAttachments = useCallback((): void => {
    attachmentIdsRef.current = [];
    attachmentsRef.current = [];
    attachmentPreviewsRef.current = {};
    setAttachments([]);
    setAttachmentPreviews({});
  }, []);

  const clearDraft = useCallback((): void => {
    draftPersistenceRef.current?.clear(options.mission.id);
    updateDraft("");
  }, [options.mission.id, updateDraft]);

  const removeDraft = useCallback((): void => {
    draftPersistenceRef.current?.remove(options.mission.id);
    updateDraft("");
  }, [options.mission.id, updateDraft]);

  const restoreAttachments = useCallback(
    (
      restoredAttachments: readonly ExpertPromptAttachment[],
      restoredPreviews: Readonly<Record<string, string>>,
    ): void => {
      attachmentIdsRef.current = restoredAttachments.map((attachment) => attachment.id);
      attachmentsRef.current = restoredAttachments;
      attachmentPreviewsRef.current = restoredPreviews;
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
        attachmentsRef.current = next;
        if (next.length > current.length) {
          setAttachmentPreviews((previews) => {
            const nextPreviews = mergeMissionAttachmentPreviews(previews, result, next);
            attachmentPreviewsRef.current = nextPreviews;
            return nextPreviews;
          });
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
        attachmentsRef.current = next;
        return next;
      });
      setAttachmentPreviews((current) => {
        const next = { ...current };
        delete next[id];
        attachmentPreviewsRef.current = next;
        return next;
      });
    },
    [discard],
  );

  useEffect(
    () => () => {
      // Flush the debounced value first. The snapshot callback then writes the
      // latest ref value, so an older pending timer can never win the handoff.
      draftPersistenceRef.current?.dispose();
      const onUnmountState = callbacksRef.current.onUnmountState;
      if (onUnmountState === undefined) {
        discard(attachmentIdsRef.current);
        return;
      }
      onUnmountState({
        missionId: missionIdRef.current,
        draft: draftRef.current,
        attachments: attachmentsRef.current,
        attachmentPreviews: attachmentPreviewsRef.current,
      });
    },
    [discard],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flushDraft = () => draftPersistenceRef.current?.flush();
    window.addEventListener("pagehide", flushDraft);
    return () => window.removeEventListener("pagehide", flushDraft);
  }, []);

  useEffect(() => {
    if (options.mission.lifecycleStatus !== "active") return;
    draftPersistenceRef.current?.schedule(options.mission.id, draft);
  }, [draft, options.mission.id, options.mission.lifecycleStatus]);

  useEffect(() => {
    if (options.initialDraft === undefined) return;
    initialDraftOverrideRef.current = {
      missionId: options.mission.id,
      draft: options.initialDraft,
    };
    updateDraft(options.initialDraft);
  }, [options.initialDraft, options.mission.id, updateDraft]);

  useEffect(() => {
    const previousLifecycle = lifecycleStatusRef.current;
    const sameMission = previousLifecycle.missionId === options.mission.id;
    lifecycleStatusRef.current = {
      missionId: options.mission.id,
      status: options.mission.lifecycleStatus,
    };
    if (options.mission.lifecycleStatus !== "completed") {
      return;
    }
    if (
      sameMission &&
      previousLifecycle.status === "completed" &&
      initialMissionLifecycleStatusRef.current === "completed" &&
      initialDraftOverrideRef.current?.missionId === options.mission.id
    ) {
      return;
    }
    removeDraft();
    discard(attachmentIdsRef.current);
    clearAttachments();
  }, [clearAttachments, discard, options.mission.id, options.mission.lifecycleStatus, removeDraft]);

  return {
    draft,
    setDraft: updateDraft,
    clearDraft,
    attachments,
    attachmentPreviews,
    clearAttachments,
    restoreAttachments,
    addAttachments,
    removeAttachment,
  };
}

function initialDraft(
  mission: Pick<Mission, "id" | "lifecycleStatus">,
  override?: { readonly missionId: string; readonly draft: string },
): string {
  if (override?.missionId === mission.id) return override.draft;
  return mission.lifecycleStatus === "active"
    ? readMissionDraft(typeof window === "undefined" ? undefined : window.localStorage, mission.id)
    : "";
}
