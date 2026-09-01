import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { HumanInteractionResponse } from "@pragma/shared";

import type {
  MissionChatSnapshot,
  MissionHumanInteraction,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";

export interface MissionHumanResponseAttempt {
  readonly requestId: string;
  readonly responseKey: string;
}

export function resolveMissionHumanResponseAttempt(
  current: MissionHumanResponseAttempt | undefined,
  response: HumanInteractionResponse,
  createRequestId: () => string,
): MissionHumanResponseAttempt {
  const responseKey = JSON.stringify(response);
  return current?.responseKey === responseKey
    ? current
    : { requestId: createRequestId(), responseKey };
}

export function useMissionHumanInteraction(options: {
  readonly missionId: string;
  readonly api?: PragmaDesktopAPI | undefined;
  readonly updateChat: Dispatch<SetStateAction<MissionChatSnapshot | null>>;
  readonly onResponded?: (() => void | Promise<void>) | undefined;
  readonly onError: (error: unknown) => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<string, Record<string, string>>>({});
  const [answers, setAnswers] = useState<
    Record<string, Record<string, string | readonly string[]>>
  >({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, Record<string, string>>>({});
  const [responding, setResponding] = useState(false);
  const attemptsRef = useRef(new Map<string, MissionHumanResponseAttempt>());
  const callbacksRef = useRef({ onResponded: options.onResponded, onError: options.onError });
  callbacksRef.current = { onResponded: options.onResponded, onError: options.onError };

  useEffect(() => {
    attemptsRef.current.clear();
    setQuestionIndex(0);
    setNotes({});
    setQuestionNotes({});
    setAnswers({});
    setCustomAnswers({});
    setResponding(false);
  }, [options.missionId]);

  const respond = useCallback(
    async (
      interaction: MissionHumanInteraction,
      response: HumanInteractionResponse,
    ): Promise<void> => {
      if (options.api === undefined || responding) return;
      const attempt = resolveMissionHumanResponseAttempt(
        attemptsRef.current.get(interaction.interactionId),
        response,
        () => crypto.randomUUID(),
      );
      attemptsRef.current.set(interaction.interactionId, attempt);
      setResponding(true);
      try {
        await options.api.respondToMissionHumanInteraction({
          missionId: options.missionId,
          interactionId: interaction.interactionId,
          requestId: attempt.requestId,
          response,
        });
        attemptsRef.current.delete(interaction.interactionId);
        options.updateChat((current) =>
          current === null
            ? current
            : {
                ...current,
                pendingInteractions: current.pendingInteractions.filter(
                  (item) => item.interactionId !== interaction.interactionId,
                ),
              },
        );
        setQuestionIndex(0);
        setNotes((current) => withoutKey(current, interaction.interactionId));
        setQuestionNotes((current) => withoutKey(current, interaction.interactionId));
        setAnswers((current) => withoutKey(current, interaction.interactionId));
        setCustomAnswers((current) => withoutKey(current, interaction.interactionId));
        await callbacksRef.current.onResponded?.();
      } catch (responseError) {
        callbacksRef.current.onError(responseError);
      } finally {
        setResponding(false);
      }
    },
    [options.api, options.missionId, options.updateChat, responding],
  );

  return {
    questionIndex,
    setQuestionIndex,
    notes,
    setNotes,
    questionNotes,
    setQuestionNotes,
    answers,
    setAnswers,
    customAnswers,
    setCustomAnswers,
    responding,
    respond,
  };
}

function withoutKey<T>(current: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...current };
  delete next[key];
  return next;
}
