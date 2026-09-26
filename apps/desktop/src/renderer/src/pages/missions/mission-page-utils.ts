import { type Dispatch, type SetStateAction } from "react";
import { parseExpertMentionSegments } from "@pragma/shared";
import {
  type Mission,
  type MissionChatEntry,
  type MissionConversationSnapshot,
  type MissionStatusUpdate,
  type MissionSummary,
  type MissionWorkRecord,
  type ExpertMentionCandidate,
  type PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { type MissionConversationBlock } from "./mission-conversation-model.ts";
import type { MissionListSource } from "./missions-page-state.tsx";

export function entryContentLength(entry: MissionChatEntry): number {
  if (entry.kind === "tool") {
    return (entry.inputPreview?.length ?? 0) + (entry.outputPreview?.length ?? 0);
  }
  if (entry.kind === "agent_activity") return entry.label?.length ?? 0;
  if (entry.kind === "context_operation") return entry.error?.length ?? 0;
  return entry.content.length;
}

export function missionConversationBlockKey(
  missionId: string,
  index: number,
  block: MissionConversationBlock,
): string {
  if (block.type === "tools") {
    return `tools:${block.entries[0]?.id ?? `${missionId}:${index}`}`;
  }
  return block.item.entry.id;
}

export function missionFooterTip(
  mission: Mission,
  chat: MissionConversationSnapshot | null,
): string | null {
  if (mission.lifecycleStatus === "completed") {
    return i18n.t("reopenToContinue", { ns: "missions" });
  }
  const execution =
    mission.execution !== undefined &&
    ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
      ? mission.execution
      : (chat?.execution ?? mission.execution);
  if (execution === undefined) return null;
  if (execution.status === "failed")
    return execution.error ?? i18n.t("executionFailed", { ns: "missions" });
  if (execution.status === "cancelled") {
    return i18n.t("executionInterrupted", { ns: "missions" });
  }
  if (
    ["queued", "running", "waiting"].includes(execution.status) &&
    chat?.execution?.interruptible === false
  ) {
    return i18n.t("resumeBeforeInterrupt", { ns: "missions" });
  }
  return null;
}

export function formatInteractionData(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function workRecordDepth(
  record: MissionWorkRecord,
  records: readonly MissionWorkRecord[],
): number {
  const byKey = new Map(records.map((candidate) => [candidate.recordId, candidate]));
  let depth = 0;
  let parentKey = record.parentRecordId;
  const visited = new Set<string>();
  while (parentKey !== undefined && !visited.has(parentKey)) {
    visited.add(parentKey);
    depth += 1;
    parentKey = byKey.get(parentKey)?.parentRecordId;
  }
  return Math.min(depth, 6);
}

export function missionWorkRecordTitle(record: MissionWorkRecord): string {
  if (record.fallbackOrdinal === undefined) return record.title;
  return i18n.t("runtimeAgentFallbackName", {
    ns: "missions",
    number: record.fallbackOrdinal,
  });
}

export function missionWorkInputSenderName(
  record: MissionWorkRecord,
  records: readonly MissionWorkRecord[],
): string {
  if (record.parentRecordId === undefined) {
    return record.kind === "root"
      ? i18n.t("you", { ns: "missions" })
      : i18n.t("mainAgent", { ns: "missions" });
  }
  const parent = records.find((candidate) => candidate.recordId === record.parentRecordId);
  return parent === undefined
    ? i18n.t("mainAgent", { ns: "missions" })
    : missionWorkRecordTitle(parent);
}

export function workStatusLabel(
  status: MissionWorkRecord["status"],
  waitReason?: MissionWorkRecord["waitReason"],
): string {
  switch (status) {
    case "queued":
      return i18n.t("statusQueued", { ns: "missions" });
    case "running":
      return i18n.t("statusWorking", { ns: "missions" });
    case "waiting":
      return waitReason === "experts"
        ? i18n.t("statusWaitingExperts", { ns: "missions" })
        : waitReason === "human_input"
          ? i18n.t("statusNeedsInput", { ns: "missions" })
          : i18n.t("statusWaiting", { ns: "missions" });
    case "succeeded":
      return i18n.t("statusSucceeded", { ns: "missions" });
    case "failed":
      return i18n.t("statusFailed", { ns: "missions" });
    case "cancelled":
    case "interrupted":
      return i18n.t("statusCancelled", { ns: "missions" });
  }
}

export function missionStatusLabel(mission: Mission | MissionSummary, preparing = false): string {
  if (mission.lifecycleStatus === "completed") return i18n.t("statusCompleted", { ns: "missions" });
  if (
    preparing &&
    (mission.execution === undefined ||
      !["queued", "running", "waiting"].includes(mission.execution.status))
  ) {
    return i18n.t("statusPreparing", { ns: "missions" });
  }
  switch (mission.execution?.status) {
    case "queued":
      return i18n.t("statusQueued", { ns: "missions" });
    case "running":
      return i18n.t("statusWorking", { ns: "missions" });
    case "waiting":
      return mission.execution.waitReason === "experts"
        ? i18n.t("statusWaitingExperts", { ns: "missions" })
        : mission.execution.waitReason === "human_input"
          ? i18n.t("statusNeedsInput", { ns: "missions" })
          : i18n.t("statusWaiting", { ns: "missions" });
    case "succeeded":
      return i18n.t("statusSucceeded", { ns: "missions" });
    case "failed":
      return i18n.t("statusFailed", { ns: "missions" });
    case "cancelled":
      return i18n.t("statusCancelled", { ns: "missions" });
    default:
      return i18n.t("statusReady", { ns: "missions" });
  }
}

export function missionListSourceForMission(mission: Mission): MissionListSource {
  return mission.origin.type === "automation" ? "automation" : "task";
}

export function missionListSourceForSummary(
  mission: MissionSummary,
): MissionListSource | undefined {
  if (mission.source.type === "internal") return undefined;
  return mission.source.type === "task" ? "task" : "automation";
}

export function formatMissionListTitle(
  title: string,
  mentionCandidates: readonly ExpertMentionCandidate[],
  unavailableLabel: string,
): string {
  const candidateByRef = new Map(
    mentionCandidates.map((candidate) => [candidate.ref, candidate] as const),
  );
  return parseExpertMentionSegments(title)
    .map((segment) =>
      segment.kind === "text"
        ? segment.text
        : `@${candidateByRef.get(segment.ref)?.name ?? unavailableLabel}`,
    )
    .join("");
}

export function teamMissionsForMentionCandidates(
  missions: readonly MissionSummary[],
): readonly MissionSummary[] {
  return missions.filter((mission) => mission.executor.kind === "team");
}

export function missionToSummary(
  mission: Mission,
  source: MissionSummary["source"] = mission.origin.type === "automation"
    ? { type: "automation", automationRef: mission.origin.automationRef }
    : mission.origin.type === "user"
      ? { type: "task" }
      : { type: "internal" },
): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    workspace: { basename: mission.workspace.basename },
    executor: { kind: mission.executor.kind, name: mission.executor.name },
    ...(mission.execution === undefined
      ? {}
      : {
          execution: {
            id: mission.execution.id,
            status: mission.execution.status,
            ...(mission.execution.waitReason === undefined
              ? {}
              : { waitReason: mission.execution.waitReason }),
          },
        }),
    source,
    lifecycleStatus: mission.lifecycleStatus,
    updatedAt: mission.updatedAt,
  };
}

export function applyMissionStatusUpdateToSummary(
  mission: MissionSummary,
  update: MissionStatusUpdate,
): MissionSummary {
  if (update.execution === undefined) return mission;
  if (mission.execution?.id !== undefined && mission.execution.id !== update.execution.id) {
    return mission;
  }
  if (
    mission.execution !== undefined &&
    isTerminalMissionExecutionStatus(mission.execution.status) &&
    !isTerminalMissionExecutionStatus(update.execution.status)
  ) {
    return mission;
  }
  const waitReason =
    update.execution.status === "waiting" ? mission.execution?.waitReason : undefined;
  return {
    ...mission,
    execution: {
      id: update.execution.id,
      status: update.execution.status,
      ...(waitReason === undefined ? {} : { waitReason }),
    },
  };
}

export function applyMissionStatusUpdateToMission(
  mission: Mission,
  update: MissionStatusUpdate,
): Mission {
  if (update.execution === undefined || mission.execution?.id !== update.execution.id) {
    return mission;
  }
  if (
    isTerminalMissionExecutionStatus(mission.execution.status) &&
    !isTerminalMissionExecutionStatus(update.execution.status)
  ) {
    return mission;
  }
  const execution = {
    id: mission.execution.id,
    inputMessageId: mission.execution.inputMessageId,
    ...(mission.execution.sessionId === undefined
      ? {}
      : { sessionId: mission.execution.sessionId }),
    ...(mission.execution.contextMountsFingerprint === undefined
      ? {}
      : { contextMountsFingerprint: mission.execution.contextMountsFingerprint }),
    startedAt: mission.execution.startedAt,
    ...(mission.execution.finishedAt === undefined
      ? {}
      : { finishedAt: mission.execution.finishedAt }),
  };
  return {
    ...mission,
    execution: {
      ...execution,
      status: update.execution.status,
      ...(update.execution.status === "failed" && mission.execution.error !== undefined
        ? { error: mission.execution.error }
        : {}),
      ...(update.execution.status === "waiting" && mission.execution.waitReason !== undefined
        ? { waitReason: mission.execution.waitReason }
        : {}),
    },
  };
}

function isTerminalMissionExecutionStatus(
  status: NonNullable<Mission["execution"]>["status"],
): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function upsertMissionSummary(
  missions: readonly MissionSummary[],
  updated: MissionSummary,
): MissionSummary[] {
  const current = missions.find((mission) => mission.id === updated.id);
  if (current !== undefined && current.updatedAt > updated.updatedAt) return [...missions];
  return [...missions.filter((mission) => mission.id !== updated.id), updated].toSorted(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function setHumanAnswer(
  update: Dispatch<SetStateAction<Record<string, Record<string, string | readonly string[]>>>>,
  interactionId: string,
  question: string,
  value: string | readonly string[] | undefined,
): void {
  update((current) => {
    const answers = { ...current[interactionId] };
    if (value === undefined) delete answers[question];
    else answers[question] = value;
    const next = { ...current };
    if (Object.keys(answers).length === 0) delete next[interactionId];
    else next[interactionId] = answers;
    return next;
  });
}

export function setHumanCustomAnswer(
  update: Dispatch<SetStateAction<Record<string, Record<string, string>>>>,
  interactionId: string,
  question: string,
  value: string,
): void {
  update((current) => {
    const answers = { ...current[interactionId] };
    if (value === "") delete answers[question];
    else answers[question] = value;
    const next = { ...current };
    if (Object.keys(answers).length === 0) delete next[interactionId];
    else next[interactionId] = answers;
    return next;
  });
}

export function setHumanQuestionNote(
  update: Dispatch<SetStateAction<Record<string, Record<string, string>>>>,
  interactionId: string,
  question: string,
  value: string,
): void {
  update((current) => {
    const notes = { ...current[interactionId] };
    if (value === "") delete notes[question];
    else notes[question] = value;
    const next = { ...current };
    if (Object.keys(notes).length === 0) delete next[interactionId];
    else next[interactionId] = notes;
    return next;
  });
}

export function desktopApi(): PragmaDesktopAPI | undefined {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}
