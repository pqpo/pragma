import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";

import { ArrowCounterClockwise, ArrowUp, SpinnerGap, Stop } from "@phosphor-icons/react";
import type { ExpertPromptAttachmentKind } from "@pragma/shared";
import { useTranslation } from "react-i18next";

import {
  MissionAttachmentList,
  MissionAttachmentPicker,
} from "../../components/MissionAttachments.tsx";
import { TeamMentionComposer } from "../../components/TeamMentionComposer.tsx";
import { shouldSubmitComposerOnEnter } from "../../lib/composer-keyboard.ts";
import { clipboardImageFile, stageClipboardImage } from "../../lib/mission-attachments.ts";
import type {
  ExpertMentionCandidate,
  Mission,
  PickMissionAttachmentsResult,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import {
  resolveMissionComposerRestore,
  type MissionComposerSnapshot,
} from "./mission-composer-recovery.ts";
import { useMissionComposerState } from "./use-mission-composer-state.ts";

export type MissionComposerAction = "send" | "loading" | "interrupt" | "recover";
export type MissionComposerRestoreResult = "restored" | "conflict" | "wrong-mission";

export interface MissionComposerHandle {
  readonly snapshot: () => MissionComposerSnapshot;
  readonly clear: () => void;
  readonly restore: (snapshot: MissionComposerSnapshot) => MissionComposerRestoreResult;
  readonly replaceDraft: (missionId: string, draft: string) => void;
  readonly focus: (missionId: string) => void;
}

export function canMeasureMissionComposerGrowthWithoutReset(
  previousDraft: string | undefined,
  nextDraft: string,
): boolean {
  return (
    previousDraft !== undefined &&
    nextDraft.length > previousDraft.length &&
    nextDraft.startsWith(previousDraft)
  );
}

export function resolveMissionComposerAction(input: {
  readonly draft: string;
  readonly sending: boolean;
  readonly executionActive: boolean;
  readonly interruptible: boolean;
  readonly recoveryAvailable?: boolean;
  readonly awaitingRequest: boolean;
  readonly hasPendingQueuedMessage: boolean;
}): MissionComposerAction {
  if (input.sending) return "loading";
  if (input.draft.trim() !== "") return "send";
  if (input.executionActive && input.interruptible) return "interrupt";
  if (input.executionActive && input.recoveryAvailable === true) return "recover";
  if (input.executionActive || input.awaitingRequest || input.hasPendingQueuedMessage) {
    return "loading";
  }
  return "send";
}

export function routeMissionAttachmentResult(input: {
  readonly result: PickMissionAttachmentsResult;
  readonly owned: boolean;
  readonly accept: (result: PickMissionAttachmentsResult) => void;
  readonly discard: (attachmentIds: readonly string[]) => void;
}): void {
  if (input.owned) {
    input.accept(input.result);
    return;
  }
  const attachmentIds = input.result.attachments.map((attachment) => attachment.id);
  if (attachmentIds.length > 0) input.discard(attachmentIds);
}

export function recoverFailedMissionSend(input: {
  readonly recovery: MissionComposerSnapshot;
  readonly composer: Pick<MissionComposerHandle, "restore"> | null;
  readonly preserve: ((snapshot: MissionComposerSnapshot) => void) | undefined;
}): void {
  if (input.recovery.attachments.length > 0) {
    const restored = input.composer?.restore(input.recovery) === "restored";
    if (!restored) input.preserve?.(input.recovery);
    return;
  }
  if (input.composer === null) input.preserve?.(input.recovery);
}

export const MissionChatComposer = forwardRef<
  MissionComposerHandle,
  {
    readonly mission: Mission;
    readonly initialDraft?: string | undefined;
    readonly initialRecovery?: MissionComposerSnapshot | undefined;
    readonly onInitialRecoveryConsumed?: ((missionId: string) => void) | undefined;
    readonly onUnmountState?: ((snapshot: MissionComposerSnapshot) => void) | undefined;
    readonly mentionCandidates: readonly ExpertMentionCandidate[];
    readonly imageUnsupported: boolean;
    readonly isFlow: boolean;
    readonly sending: boolean;
    readonly clientOperationBusy: boolean;
    readonly compactingContext: boolean;
    readonly hasPendingQueuedMessage: boolean;
    readonly executionActive: boolean;
    readonly interruptible: boolean;
    readonly interrupting: boolean;
    readonly recoveryAvailable: boolean;
    readonly awaitingRequest: boolean;
    readonly toolbarOptions: ReactNode;
    readonly contextWindowControl: ReactNode;
    readonly onSubmit: () => void;
    readonly onInterrupt: () => void;
    readonly onRecover: () => void;
    readonly onError: (error: unknown) => void;
    readonly onAttachmentLimit: () => void;
    readonly onAttachmentsAccepted: () => void;
  }
>(function MissionChatComposer(props, ref) {
  const { t } = useTranslation(["missions", "common"]);
  const inputRef = useRef<HTMLTextAreaElement | HTMLDivElement | null>(null);
  const resizeFrameRef = useRef<number | undefined>(undefined);
  const previousDraftRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const initialRecoveryRef = useRef(props.initialRecovery);
  const initialRecoveryConsumedRef = useRef(props.onInitialRecoveryConsumed);
  initialRecoveryConsumedRef.current = props.onInitialRecoveryConsumed;
  const attachmentOwnerKey = `${props.mission.id}:${props.mission.lifecycleStatus}:${String(props.isFlow)}`;
  const attachmentOwnerKeyRef = useRef(attachmentOwnerKey);
  attachmentOwnerKeyRef.current = attachmentOwnerKey;
  const {
    draft,
    setDraft,
    clearDraft,
    attachments,
    attachmentPreviews,
    clearAttachments,
    restoreAttachments,
    addAttachments,
    removeAttachment,
  } = useMissionComposerState({
    mission: props.mission,
    initialDraft: initialRecoveryRef.current?.draft ?? props.initialDraft,
    initialAttachments: initialRecoveryRef.current?.attachments,
    initialAttachmentPreviews: initialRecoveryRef.current?.attachmentPreviews,
    onUnmountState: props.onUnmountState,
    discardDrafts: desktopApi()?.discardMissionAttachmentDrafts,
    onAttachmentLimit: props.onAttachmentLimit,
    onAttachmentsAccepted: props.onAttachmentsAccepted,
  });

  useEffect(() => {
    const initialRecovery = initialRecoveryRef.current;
    if (initialRecovery?.missionId === props.mission.id) {
      initialRecoveryConsumedRef.current?.(props.mission.id);
    }
  }, [props.mission.id]);

  const assignInput = useCallback((element: HTMLTextAreaElement | HTMLDivElement | null) => {
    inputRef.current = element;
  }, []);

  useEffect(() => {
    if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = undefined;
      const input = inputRef.current;
      if (input === null) return;
      const previousDraft = previousDraftRef.current;
      previousDraftRef.current = draft;
      if (canMeasureMissionComposerGrowthWithoutReset(previousDraft, draft)) {
        const nextHeight = `${Math.min(input.scrollHeight, 130)}px`;
        if (input.style.height !== nextHeight) input.style.height = nextHeight;
        return;
      }
      input.style.height = "auto";
      const nextHeight = `${Math.min(input.scrollHeight, 130)}px`;
      if (input.style.height !== nextHeight) input.style.height = nextHeight;
    });
    return () => {
      if (resizeFrameRef.current !== undefined) cancelAnimationFrame(resizeFrameRef.current);
    };
  }, [draft]);

  useImperativeHandle(
    ref,
    () => ({
      snapshot: () => ({
        missionId: props.mission.id,
        draft,
        attachments,
        attachmentPreviews,
      }),
      clear: () => {
        clearDraft();
        clearAttachments();
      },
      restore: (snapshot) => {
        const decision = resolveMissionComposerRestore({
          current: {
            missionId: props.mission.id,
            draft,
            attachments,
            attachmentPreviews,
          },
          recovery: snapshot,
        });
        if (decision === "wrong-mission") return "wrong-mission";
        if (decision === "conflict") return "conflict";
        if (decision === "restore") {
          setDraft(snapshot.draft);
          restoreAttachments(snapshot.attachments, snapshot.attachmentPreviews);
        }
        return "restored";
      },
      replaceDraft: (missionId, nextDraft) => {
        if (missionId === props.mission.id) setDraft(nextDraft);
      },
      focus: (missionId) => {
        if (missionId === props.mission.id) inputRef.current?.focus();
      },
    }),
    [
      attachmentPreviews,
      attachments,
      clearAttachments,
      clearDraft,
      draft,
      props.mission.id,
      restoreAttachments,
      setDraft,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const acceptPickedAttachments = (
    result: PickMissionAttachmentsResult,
    expectedOwnerKey: string,
  ): void => {
    routeMissionAttachmentResult({
      result,
      owned:
        mountedRef.current &&
        attachmentOwnerKeyRef.current === expectedOwnerKey &&
        props.mission.lifecycleStatus === "active" &&
        !props.isFlow,
      accept: addAttachments,
      discard: (attachmentIds) => {
        void desktopApi()?.discardMissionAttachmentDrafts({ attachmentIds: [...attachmentIds] });
      },
    });
  };

  const pickAttachments = async (kind: ExpertPromptAttachmentKind) => {
    if (props.isFlow) return;
    const expectedOwnerKey = attachmentOwnerKeyRef.current;
    try {
      acceptPickedAttachments(
        await window.pragmaDesktop.pickMissionAttachments({ kind }),
        expectedOwnerKey,
      );
    } catch (error) {
      if (mountedRef.current) props.onError(error);
    }
  };

  const pasteImage = async (file: File) => {
    const expectedOwnerKey = attachmentOwnerKeyRef.current;
    try {
      const result = await stageClipboardImage(file, (input) =>
        window.pragmaDesktop.stageMissionClipboardImage(input),
      );
      acceptPickedAttachments(result, expectedOwnerKey);
    } catch (error) {
      if (mountedRef.current) props.onError(error);
    }
  };

  const completed = props.mission.lifecycleStatus === "completed";
  const disabled = props.clientOperationBusy || props.compactingContext || completed;
  const composerAction = resolveMissionComposerAction({
    draft,
    sending: props.sending,
    executionActive: props.executionActive,
    interruptible: props.interruptible,
    recoveryAvailable: props.recoveryAvailable,
    awaitingRequest: props.awaitingRequest,
    hasPendingQueuedMessage: props.hasPendingQueuedMessage,
  });
  const placeholder = props.compactingContext
    ? t("contextCompactionInputDisabled", { ns: "missions" })
    : completed
      ? t("reopenToContinue", { ns: "missions" })
      : props.isFlow
        ? t("flowContinues", { ns: "missions" })
        : t("messageExecutor", {
            ns: "missions",
            name: props.mission.executor.name,
          });
  const ariaLabel = t("messageExecutor", {
    ns: "missions",
    name: props.mission.executor.name,
  });

  return (
    <div className="mission-chat-composer" aria-busy={props.clientOperationBusy}>
      <MissionAttachmentList
        attachments={attachments}
        previews={attachmentPreviews}
        imageUnsupported={props.imageUnsupported}
        onRemove={removeAttachment}
      />
      {props.mission.executor.kind === "team" ? (
        <TeamMentionComposer
          inputRef={assignInput}
          value={draft}
          candidates={props.mentionCandidates}
          onChange={setDraft}
          onSubmit={props.onSubmit}
          disabled={disabled}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          menuLabel={t("mentionMembers", { ns: "missions" })}
          emptyLabel={t("mentionNoMatches", { ns: "missions" })}
          unavailableLabel={t("mentionUnavailable", { ns: "missions" })}
          onPaste={(event) => {
            const file = clipboardImageFile(event.clipboardData);
            if (file === undefined || disabled) return;
            event.preventDefault();
            void pasteImage(file);
          }}
          variant="mission"
        />
      ) : (
        <textarea
          ref={assignInput}
          rows={1}
          value={draft}
          disabled={props.isFlow || disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-describedby={
            props.compactingContext ? "mission-context-compaction-status" : undefined
          }
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const file = clipboardImageFile(event.clipboardData);
            if (file === undefined || props.isFlow || disabled) return;
            event.preventDefault();
            void pasteImage(file);
          }}
          onKeyDown={(event) => {
            if (shouldSubmitComposerOnEnter(event.nativeEvent)) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
      )}
      <div className="mission-chat-composer-toolbar">
        <div className="mission-chat-options" aria-label={t("missionOptions")}>
          <MissionAttachmentPicker
            compact
            disabled={props.isFlow || disabled}
            onPick={pickAttachments}
          />
          {props.toolbarOptions}
        </div>
        <div className="mission-chat-actions">
          {props.contextWindowControl}
          {composerAction === "interrupt" ? (
            <button
              className="is-interrupt"
              type="button"
              aria-label={t("interrupt", { ns: "missions" })}
              title={t("interrupt", { ns: "missions" })}
              disabled={props.interrupting}
              onClick={props.onInterrupt}
            >
              <Stop size={17} weight="fill" aria-hidden="true" />
            </button>
          ) : composerAction === "recover" ? (
            <button
              className="is-recovery"
              type="button"
              aria-label={t("resume", { ns: "missions" })}
              title={t("resume", { ns: "missions" })}
              disabled={props.clientOperationBusy}
              onClick={props.onRecover}
            >
              <ArrowCounterClockwise size={19} aria-hidden="true" />
            </button>
          ) : composerAction === "loading" ? (
            <button
              className="is-loading"
              type="button"
              aria-label={t("loading", { ns: "common" })}
              title={t("loading", { ns: "common" })}
              aria-busy="true"
              disabled
            >
              <SpinnerGap size={19} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("send", { ns: "missions" })}
              disabled={props.isFlow || draft.trim() === "" || disabled}
              onClick={props.onSubmit}
            >
              <ArrowUp size={19} weight="bold" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function desktopApi(): PragmaDesktopAPI | undefined {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}
