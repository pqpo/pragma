import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import {
  CaretDown,
  CheckCircle,
  Copy,
  File,
  Folder,
  GitBranch,
  ImageSquare,
  SpinnerGap,
  Toolbox,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { ExpertPromptAttachment } from "@pragma/shared";

import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import { MissionImagePreviewDialog } from "../../components/MissionAttachments.tsx";
import { MarkdownContent, StreamingMarkdownContent } from "../../components/MarkdownContent.tsx";
import { i18n } from "../../i18n/index.ts";
import {
  missionAttachmentOriginalUrl,
  missionAttachmentPreviewUrl,
  type MissionChatEntry,
} from "../../../../shared/contracts/index.ts";
import type { LocalMissionUserMessage } from "./mission-command-delivery.ts";
import type { LocalMissionContextOperation } from "./mission-conversation-model.ts";
import { MissionLiveEntryStore, useMissionLiveEntry } from "./mission-live-entry-store.ts";

export async function copyMissionReply(
  content: string,
  clipboard: Pick<Clipboard, "writeText"> = window.navigator.clipboard,
): Promise<"copied" | "failed"> {
  try {
    await clipboard.writeText(content);
    return "copied";
  } catch {
    return "failed";
  }
}

export function LocalMissionUserMessageView(props: {
  readonly message: LocalMissionUserMessage;
  readonly missionId: string;
  readonly retryDisabled?: boolean | undefined;
  readonly onRetry?: ((message: LocalMissionUserMessage) => void) | undefined;
}) {
  const { t } = useTranslation("missions");
  return (
    <div
      className={
        props.message.status === "failed"
          ? "mission-user-message is-local is-failed"
          : "mission-user-message is-local"
      }
    >
      <div>
        <MissionMessageAttachments
          attachments={props.message.attachments}
          missionId={props.missionId}
        />
        <MissionMessageContent source={props.message.content} />
        {props.message.status === "failed" ? (
          <small>
            {t("messageSendFailed")}
            {props.onRetry === undefined ? null : (
              <button
                type="button"
                disabled={props.retryDisabled}
                onClick={() => props.onRetry?.(props.message)}
              >
                {t("retryChatSync")}
              </button>
            )}
          </small>
        ) : null}
      </div>
    </div>
  );
}

export function MissionContextOperationEntry(props: {
  readonly operation:
    LocalMissionContextOperation | Extract<MissionChatEntry, { kind: "context_operation" }>;
  readonly retryDisabled?: boolean | undefined;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const failed = props.operation.status === "failed";
  return (
    <div
      className={`mission-context-operation is-${props.operation.status}`}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      {props.operation.status === "running" ? (
        <SpinnerGap className="spin" size={17} aria-hidden="true" />
      ) : failed ? (
        <WarningCircle size={17} weight="fill" aria-hidden="true" />
      ) : (
        <CheckCircle size={17} weight="fill" aria-hidden="true" />
      )}
      <span>
        <strong>
          {props.operation.status === "running"
            ? t("contextCompactionStarted", { ns: "missions" })
            : failed
              ? t("contextCompactionFailed", { ns: "missions" })
              : props.operation.status === "skipped"
                ? t("contextCompactionNotNeeded", { ns: "missions" })
                : t("contextCompactionCompleted", { ns: "missions" })}
        </strong>
        {props.operation.error === undefined ? null : <small>{props.operation.error}</small>}
      </span>
      {failed && props.onRetry !== undefined ? (
        <button type="button" disabled={props.retryDisabled} onClick={props.onRetry}>
          {t("actions.retry", { ns: "common" })}
        </button>
      ) : null}
    </div>
  );
}

export function MissionThinkingPlaceholder(props: { readonly executorName: string }) {
  const { t } = useTranslation("missions");
  return (
    <div className="mission-assistant-message mission-thinking-placeholder" aria-live="polite">
      <p>
        <SpinnerGap size={17} aria-hidden="true" />
        {t("thinkingActive", { name: props.executorName })}
      </p>
    </div>
  );
}

export const MissionChatEntryView = memo(function MissionChatEntryView(props: {
  readonly entry: MissionChatEntry;
  readonly liveEntryStore?: MissionLiveEntryStore | undefined;
  readonly missionId?: string | undefined;
  readonly userLabel?: string | undefined;
  readonly paintExecutionId?: string | undefined;
  readonly onVisibleContent?:
    ((executionId: string | undefined, element: HTMLElement | null) => void) | undefined;
  readonly showExecutorLabel?: boolean | undefined;
  readonly showCopy?: boolean | undefined;
  readonly showBranch?: boolean | undefined;
  readonly onBranch?:
    ((entry: Extract<MissionChatEntry, { kind: "assistant" }>) => void) | undefined;
}) {
  const { t } = useTranslation("missions");
  const entry = useMissionLiveEntry(props.liveEntryStore, props.entry);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copyStatusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const assistantElementRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (entry.kind !== "assistant" || entry.content.length === 0) return;
    props.onVisibleContent?.(
      props.paintExecutionId ?? entry.executionId,
      assistantElementRef.current,
    );
  }, [entry, props.onVisibleContent, props.paintExecutionId]);

  useEffect(
    () => () => {
      if (copyStatusTimerRef.current !== undefined) clearTimeout(copyStatusTimerRef.current);
    },
    [],
  );

  const showCopyStatus = (status: "copied" | "failed") => {
    if (copyStatusTimerRef.current !== undefined) clearTimeout(copyStatusTimerRef.current);
    setCopyStatus(status);
    copyStatusTimerRef.current = setTimeout(() => {
      copyStatusTimerRef.current = undefined;
      setCopyStatus("idle");
    }, 2_000);
  };

  if (entry.kind === "user") {
    if (entry.delivery?.removed === true || entry.delivery?.status === "queued") {
      return null;
    }
    return (
      <div className="mission-user-message">
        <div>
          {props.userLabel === undefined ? null : (
            <small className="mission-message-sender">{props.userLabel}</small>
          )}
          <MissionMessageAttachments
            attachments={entry.attachments ?? []}
            missionId={props.missionId}
          />
          <MissionMessageContent source={entry.content} />
        </div>
      </div>
    );
  }
  if (entry.kind === "thinking") {
    return (
      <MissionThinkingEntry
        entry={entry}
        onVisibleContent={props.onVisibleContent}
        paintExecutionId={props.paintExecutionId}
        showExecutorLabel={props.showExecutorLabel}
      />
    );
  }
  if (entry.kind === "tool") {
    return <MissionToolCallEntry entry={entry} />;
  }
  if (entry.kind === "agent_activity") {
    return <MissionAgentActivityEntry entry={entry} />;
  }
  if (entry.kind === "context_operation") {
    return <MissionContextOperationEntry operation={entry} retryDisabled={false} />;
  }
  const assistantEntry = entry;
  return (
    <div
      className="mission-assistant-message"
      data-mission-execution-id={props.paintExecutionId}
      ref={assistantElementRef}
    >
      {props.showExecutorLabel ? <MissionExecutorLabel entry={assistantEntry} /> : null}
      <MissionMessageContent
        source={assistantEntry.content}
        streaming={assistantEntry.streaming === true}
      />
      {props.showCopy || props.showBranch ? (
        <div className="mission-message-actions">
          {props.showCopy ? (
            <button
              className="mission-message-icon-action"
              type="button"
              aria-label={t("copyReply")}
              title={t("copyReply")}
              onClick={() => {
                void copyMissionReply(assistantEntry.content).then(showCopyStatus);
              }}
            >
              <Copy size={15} aria-hidden="true" />
            </button>
          ) : null}
          {props.showBranch ? (
            <button
              className="mission-message-icon-action"
              type="button"
              aria-label={t("createBranch")}
              title={t("createBranch")}
              onClick={() => props.onBranch?.(assistantEntry)}
            >
              <GitBranch size={15} aria-hidden="true" />
            </button>
          ) : null}
          {copyStatus === "idle" ? null : (
            <span className="mission-message-action-status" role="status">
              {copyStatus === "copied" ? t("replyCopied") : t("replyCopyFailed")}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
});

function MissionMessageAttachments(props: {
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly missionId?: string | undefined;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <div className="mission-message-attachments">
      {props.attachments.map((attachment) =>
        attachment.kind === "image" && props.missionId !== undefined ? (
          <MissionImageAttachment
            attachment={attachment}
            key={attachment.id}
            missionId={props.missionId}
          />
        ) : (
          <MissionAttachmentLabel attachment={attachment} key={attachment.id} />
        ),
      )}
    </div>
  );
}

function MissionImageAttachment(props: {
  readonly attachment: ExpertPromptAttachment;
  readonly missionId: string;
}) {
  const { t } = useTranslation("missions");
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (failed) return <MissionAttachmentLabel attachment={props.attachment} />;
  return (
    <>
      <figure className="mission-image-attachment">
        <button
          type="button"
          aria-label={t("viewOriginalImage", { name: props.attachment.name })}
          onClick={() => setOpen(true)}
        >
          <img
            alt={t("attachmentPreviewAlt", { name: props.attachment.name })}
            loading="lazy"
            src={missionAttachmentPreviewUrl(props.missionId, props.attachment.id)}
            onError={() => setFailed(true)}
          />
        </button>
        <figcaption>{props.attachment.name}</figcaption>
      </figure>
      {open ? (
        <MissionImagePreviewDialog
          name={props.attachment.name}
          src={missionAttachmentOriginalUrl(props.missionId, props.attachment.id)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function MissionAttachmentLabel(props: { readonly attachment: ExpertPromptAttachment }) {
  const { t } = useTranslation("missions");
  const Icon =
    props.attachment.kind === "image"
      ? ImageSquare
      : props.attachment.kind === "directory"
        ? Folder
        : File;
  return (
    <span className="mission-attachment-label">
      <Icon size={16} aria-hidden="true" />
      <span>
        <strong>{props.attachment.name}</strong>
        <small>{t(`attachmentKind.${props.attachment.kind}`)}</small>
      </span>
    </span>
  );
}

function MissionExecutorLabel(props: { readonly entry: MissionChatEntry }) {
  const label = missionChatEntryExecutorLabel(props.entry);
  if (label === undefined) return null;
  return (
    <small
      className="mission-output-executor"
      data-mission-executor-id={props.entry.executorId}
      title={props.entry.executorId}
    >
      <ExpertAvatar avatarId={props.entry.executorAvatarId} size="xs" />
      <span>{label}</span>
    </small>
  );
}

function MissionAgentActivityEntry(props: {
  readonly entry: Extract<MissionChatEntry, { kind: "agent_activity" }>;
}) {
  const { t } = useTranslation("missions");
  const status =
    props.entry.phase === "started"
      ? t("statusRunning")
      : props.entry.phase === "completed"
        ? t("statusCompleted")
        : t("statusFailed");
  const target = props.entry.label ?? props.entry.targetSessionIds.at(0);
  return (
    <div className={`mission-chat-activity mission-agent-activity is-${props.entry.phase}`}>
      <UsersThree size={17} aria-hidden="true" />
      <span>
        {t(`agentAction.${props.entry.action}`)}
        {target === undefined ? null : <small>{target}</small>}
      </span>
      <small>{status}</small>
      {props.entry.error === undefined ? null : <p role="alert">{props.entry.error}</p>}
    </div>
  );
}

export function MissionThinkingEntry(props: {
  readonly entry: Extract<MissionChatEntry, { kind: "thinking" }>;
  readonly paintExecutionId?: string | undefined;
  readonly onVisibleContent?:
    ((executionId: string | undefined, element: HTMLElement | null) => void) | undefined;
  readonly showExecutorLabel?: boolean | undefined;
}) {
  const { t } = useTranslation("missions");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const streaming = props.entry.streaming === true;
  const showsFullContent = streaming || expanded;

  useLayoutEffect(() => {
    if (props.entry.content.length === 0) return;
    props.onVisibleContent?.(props.paintExecutionId ?? props.entry.executionId, elementRef.current);
  }, [props.entry, props.onVisibleContent, props.paintExecutionId]);

  return (
    <div
      className={`mission-thinking-entry${showsFullContent ? " is-expanded" : ""}${
        streaming ? " is-streaming" : ""
      }`}
      data-mission-execution-id={props.paintExecutionId ?? props.entry.executionId}
      aria-live={streaming ? "polite" : undefined}
      ref={elementRef}
    >
      {props.showExecutorLabel ? <MissionExecutorLabel entry={props.entry} /> : null}
      <p id={contentId}>{props.entry.content}</p>
      {streaming ? null : (
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={expanded ? t("collapseThinking") : t("expandThinking")}
          title={expanded ? t("collapseThinking") : t("expandThinking")}
          onClick={() => setExpanded((current) => !current)}
        >
          <CaretDown size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export const MissionToolCallBlock = memo(function MissionToolCallBlock(props: {
  readonly collapsed: boolean;
  readonly entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[];
}) {
  const { t } = useTranslation("missions");
  if (props.entries.length === 1) {
    return <MissionToolCallEntry entry={props.entries[0]!} />;
  }
  if (!props.collapsed) {
    return (
      <div className="mission-tool-run">
        {props.entries.map((entry) => (
          <MissionToolCallEntry entry={entry} key={entry.id} />
        ))}
      </div>
    );
  }
  const status = toolGroupStatus(props.entries);
  return (
    <details className={`mission-chat-activity mission-tool-entry mission-tool-group is-${status}`}>
      <summary>
        <Toolbox size={16} aria-hidden="true" />
        <span>{t("toolCalls", { count: props.entries.length })}</span>
        <small>{toolStatusLabel(status)}</small>
        <CaretDown size={14} aria-hidden="true" />
      </summary>
      <div className="mission-tool-group-items">
        {props.entries.map((entry) => (
          <MissionToolCallEntry entry={entry} key={entry.id} />
        ))}
      </div>
    </details>
  );
}, sameMissionToolCallBlockProps);

function sameMissionToolCallBlockProps(
  previous: {
    readonly collapsed: boolean;
    readonly entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[];
  },
  next: {
    readonly collapsed: boolean;
    readonly entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[];
  },
): boolean {
  return (
    previous.collapsed === next.collapsed &&
    previous.entries.length === next.entries.length &&
    previous.entries.every((entry, index) => entry === next.entries[index])
  );
}

function MissionToolCallEntry(props: {
  readonly entry: Extract<MissionChatEntry, { kind: "tool" }>;
}) {
  const { t } = useTranslation("missions");
  const className = `mission-chat-activity mission-tool-entry is-${props.entry.status}`;
  const hasDetails =
    props.entry.inputPreview !== undefined ||
    props.entry.outputPreview !== undefined ||
    props.entry.error !== undefined;
  const row = (
    <>
      <Toolbox size={16} aria-hidden="true" />
      <span>{props.entry.toolName}</span>
      <small>{toolStatusLabel(props.entry.status)}</small>
    </>
  );
  if (!hasDetails) {
    return (
      <div className={`${className} mission-tool-static-row`}>
        {row}
        <span aria-hidden="true" />
      </div>
    );
  }
  return (
    <details className={className}>
      <summary>
        {row}
        <CaretDown size={14} aria-hidden="true" />
      </summary>
      <div className="mission-tool-entry-details">
        {props.entry.inputPreview !== undefined ? (
          <section>
            <strong>{t("input")}</strong>
            <pre>{props.entry.inputPreview}</pre>
          </section>
        ) : null}
        {props.entry.outputPreview !== undefined ? (
          <section>
            <strong>{t("output")}</strong>
            <pre>{props.entry.outputPreview}</pre>
          </section>
        ) : null}
        {props.entry.error !== undefined ? <p>{props.entry.error}</p> : null}
      </div>
    </details>
  );
}

export const MissionMessageContent = memo(function MissionMessageContent(props: {
  readonly source: string;
  readonly streaming?: boolean | undefined;
}) {
  return (
    <div className="mission-markdown">
      {props.streaming === true ? (
        <StreamingMarkdownContent source={props.source} codeBlockControls />
      ) : (
        <MarkdownContent source={props.source} codeBlockControls />
      )}
    </div>
  );
});

function missionChatEntryExecutorLabel(entry: MissionChatEntry): string | undefined {
  return entry.executorName ?? entry.executorId;
}

function toolStatusLabel(status: Extract<MissionChatEntry, { kind: "tool" }>["status"]): string {
  switch (status) {
    case "running":
      return i18n.t("statusRunning", { ns: "missions" });
    case "approval_required":
      return i18n.t("statusApproval", { ns: "missions" });
    case "succeeded":
      return i18n.t("statusCompleted", { ns: "missions" });
    case "failed":
      return i18n.t("statusFailed", { ns: "missions" });
  }
}

function toolGroupStatus(
  entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[],
): Extract<MissionChatEntry, { kind: "tool" }>["status"] {
  if (entries.some((entry) => entry.status === "approval_required")) return "approval_required";
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  return "succeeded";
}
