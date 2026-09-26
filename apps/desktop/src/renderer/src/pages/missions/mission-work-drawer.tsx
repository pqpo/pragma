import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, SpinnerGap, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  type MissionChatEntry,
  type MissionWorkRecord,
  type ExpertMentionCandidate,
} from "../../../../shared/contracts/index.ts";
import { groupMissionConversationEntries } from "./mission-conversation-model.ts";
import { MissionChatEntryView, MissionToolCallBlock } from "./mission-chat-presentation.tsx";
import {
  entryContentLength,
  missionWorkRecordTitle,
  workStatusLabel,
} from "./mission-page-utils.ts";

export function MissionWorkDrawer(props: {
  readonly record: MissionWorkRecord;
  readonly inputSenderName: string;
  readonly mentionCandidates?: readonly ExpertMentionCandidate[] | undefined;
  readonly entries: readonly MissionChatEntry[];
  readonly loading: boolean;
  readonly onLoadEarlier?: (() => void | Promise<void>) | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const conversationBlocks = useMemo(
    () =>
      groupMissionConversationEntries(
        props.entries.map((entry) => ({ type: "durable" as const, entry })),
      ),
    [props.entries],
  );
  const lastEntry = props.entries.at(-1);
  const conversationFingerprint =
    lastEntry === undefined
      ? "empty"
      : `${lastEntry.id}:${lastEntry.kind}:${entryContentLength(lastEntry)}`;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    if (prependScrollHeightRef.current !== null) {
      scroll.scrollTop += scroll.scrollHeight - prependScrollHeightRef.current;
      prependScrollHeightRef.current = null;
      setShowJumpToLatest(true);
      return;
    }
    if (followLatestRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [conversationFingerprint, props.entries.length]);

  const loadEarlier = async (): Promise<void> => {
    const scroll = scrollRef.current;
    prependScrollHeightRef.current = scroll?.scrollHeight ?? null;
    followLatestRef.current = false;
    try {
      await props.onLoadEarlier?.();
    } finally {
      requestAnimationFrame(() => {
        const current = scrollRef.current;
        const previousHeight = prependScrollHeightRef.current;
        if (current !== null && previousHeight !== null) {
          current.scrollTop += current.scrollHeight - previousHeight;
        }
        prependScrollHeightRef.current = null;
        setShowJumpToLatest(true);
      });
    }
  };

  return (
    <div className="mission-work-drawer-layer" role="presentation">
      <button
        className="mission-work-drawer-scrim"
        type="button"
        aria-label={t("actions.close", { ns: "common" })}
        onClick={props.onClose}
      />
      <aside
        className="mission-work-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mission-work-drawer-title"
      >
        <header>
          <div>
            <small>{t("agentConversation", { ns: "missions" })}</small>
            <h2 id="mission-work-drawer-title">{missionWorkRecordTitle(props.record)}</h2>
            <p>
              {workStatusLabel(props.record.status, props.record.waitReason)} ·{" "}
              {t("readOnlyConversation", { ns: "missions" })}
              {props.record.status === "running" || props.record.status === "waiting" ? (
                <span className="mission-work-streaming">
                  <SpinnerGap size={13} aria-hidden="true" />
                  {t("streaming", { ns: "missions" })}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("actions.close", { ns: "common" })}
            onClick={props.onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="mission-work-drawer-body">
          <div
            className="mission-chat-scroll mission-work-conversation-scroll"
            ref={scrollRef}
            aria-live="polite"
            onScroll={(event) => {
              const element = event.currentTarget;
              const nearBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight < 72;
              followLatestRef.current = nearBottom;
              if (nearBottom) setShowJumpToLatest(false);
            }}
          >
            <div className="mission-chat-list mission-work-conversation-list">
              {props.onLoadEarlier === undefined ? null : (
                <button
                  className="mission-load-earlier"
                  type="button"
                  disabled={props.loading}
                  onClick={() => void loadEarlier()}
                >
                  {props.loading
                    ? t("loadingEarlier", { ns: "missions" })
                    : t("loadEarlier", { ns: "missions" })}
                </button>
              )}
              {props.loading && props.entries.length === 0 ? (
                <p className="mission-work-conversation-empty">
                  <SpinnerGap size={14} aria-hidden="true" />
                  {t("streaming", { ns: "missions" })}
                </p>
              ) : props.entries.length === 0 ? (
                <p className="mission-work-conversation-empty">
                  {t("waitingForAgentConversation", { ns: "missions" })}
                </p>
              ) : (
                conversationBlocks.map((block) => {
                  if (block.type === "tools") {
                    return (
                      <MissionToolCallBlock
                        collapsed={block.collapsed}
                        entries={block.entries}
                        key={`tools:${block.entries[0]!.id}`}
                        mentionCandidates={props.mentionCandidates}
                      />
                    );
                  }
                  return block.item.type === "durable" ? (
                    <MissionChatEntryView
                      entry={block.item.entry}
                      key={block.item.entry.id}
                      mentionCandidates={props.mentionCandidates}
                      userLabel={props.inputSenderName}
                    />
                  ) : null;
                })
              )}
            </div>
            {showJumpToLatest ? (
              <button
                className="mission-jump-latest"
                type="button"
                onClick={() => {
                  const scroll = scrollRef.current;
                  if (scroll !== null) scroll.scrollTop = scroll.scrollHeight;
                  followLatestRef.current = true;
                  setShowJumpToLatest(false);
                }}
              >
                <CaretDown size={15} aria-hidden="true" />
                {t("jumpLatest", { ns: "missions" })}
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
