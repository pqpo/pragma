import type { ExpertPromptAttachment } from "@pragma/shared";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type {
  MissionCommandOutcome,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";

export interface LocalMissionUserMessage {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly status: "pending" | "failed";
  readonly retryMode?: "same-request" | "new-request" | undefined;
}

export interface PendingMissionQueuedMessage {
  readonly requestId: string;
  readonly content: string;
  readonly attachments: readonly ExpertPromptAttachment[];
}

export interface MissionCommandDeliveryState {
  readonly optimisticMessages: readonly LocalMissionUserMessage[];
  readonly setOptimisticMessages: Dispatch<SetStateAction<LocalMissionUserMessage[]>>;
  readonly pendingQueuedMessages: readonly PendingMissionQueuedMessage[];
  readonly setPendingQueuedMessages: Dispatch<SetStateAction<PendingMissionQueuedMessage[]>>;
  readonly awaitingRequestId: string | null;
  readonly setAwaitingRequestId: Dispatch<SetStateAction<string | null>>;
  readonly recordSubmission: (
    message: LocalMissionUserMessage,
    replacedRequestId?: string | undefined,
  ) => void;
  readonly discardSubmission: (requestId: string) => void;
}

export function useMissionCommandDelivery(options: {
  readonly missionId: string;
  readonly subscribe?: PragmaDesktopAPI["subscribeMissionCommandOutcomes"] | undefined;
  readonly onApplied: (outcome: MissionCommandOutcome) => void;
  readonly onRejected: (outcome: MissionCommandOutcome) => void;
}): MissionCommandDeliveryState {
  const [optimisticMessages, setOptimisticMessages] = useState<LocalMissionUserMessage[]>([]);
  const [pendingQueuedMessages, setPendingQueuedMessages] = useState<PendingMissionQueuedMessage[]>(
    [],
  );
  const [awaitingRequestId, setAwaitingRequestId] = useState<string | null>(null);
  const submittedMessagesRef = useRef(new Map<string, LocalMissionUserMessage>());
  const callbacksRef = useRef({ onApplied: options.onApplied, onRejected: options.onRejected });
  callbacksRef.current = { onApplied: options.onApplied, onRejected: options.onRejected };

  useEffect(() => {
    if (options.subscribe === undefined) return;
    return options.subscribe((outcome) => {
      if (outcome.missionId !== options.missionId) return;
      if (outcome.state === "applied") {
        submittedMessagesRef.current.delete(outcome.requestId);
        setAwaitingRequestId((current) => (current === outcome.requestId ? null : current));
        callbacksRef.current.onApplied(outcome);
        return;
      }
      setPendingQueuedMessages((current) =>
        current.filter((message) => message.requestId !== outcome.requestId),
      );
      setOptimisticMessages((current) =>
        rejectMissionCommandDelivery({
          requestId: outcome.requestId,
          optimisticMessages: current,
          submitted: submittedMessagesRef.current.get(outcome.requestId),
        }),
      );
      submittedMessagesRef.current.delete(outcome.requestId);
      setAwaitingRequestId((current) => (current === outcome.requestId ? null : current));
      callbacksRef.current.onRejected(outcome);
    });
  }, [options.missionId, options.subscribe]);

  useEffect(() => {
    submittedMessagesRef.current.clear();
    setOptimisticMessages([]);
    setPendingQueuedMessages([]);
    setAwaitingRequestId(null);
  }, [options.missionId]);

  return {
    optimisticMessages,
    setOptimisticMessages,
    pendingQueuedMessages,
    setPendingQueuedMessages,
    awaitingRequestId,
    setAwaitingRequestId,
    recordSubmission(message, replacedRequestId) {
      if (replacedRequestId !== undefined) submittedMessagesRef.current.delete(replacedRequestId);
      submittedMessagesRef.current.set(message.id, message);
    },
    discardSubmission(requestId) {
      submittedMessagesRef.current.delete(requestId);
    },
  };
}

export function createMissionSendAttempt(input: {
  readonly content: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly retry?: LocalMissionUserMessage | undefined;
  readonly createRequestId: () => string;
  readonly now: () => string;
}): LocalMissionUserMessage {
  const requestId =
    input.retry?.retryMode === "same-request" ? input.retry.id : input.createRequestId();
  return input.retry === undefined
    ? {
        id: requestId,
        content: input.content,
        createdAt: input.now(),
        attachments: [...input.attachments],
        status: "pending",
      }
    : { ...input.retry, id: requestId, status: "pending" };
}

export function rejectMissionCommandDelivery(input: {
  readonly requestId: string;
  readonly optimisticMessages: readonly LocalMissionUserMessage[];
  readonly submitted?: LocalMissionUserMessage | undefined;
}): LocalMissionUserMessage[] {
  if (input.optimisticMessages.some((message) => message.id === input.requestId)) {
    return input.optimisticMessages.map((message) =>
      message.id === input.requestId
        ? { ...message, status: "failed", retryMode: "new-request" }
        : message,
    );
  }
  return input.submitted === undefined
    ? [...input.optimisticMessages]
    : [
        ...input.optimisticMessages,
        { ...input.submitted, status: "failed", retryMode: "new-request" },
      ];
}
