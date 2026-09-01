import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { MissionChatSnapshot, PragmaDesktopAPI } from "../../../../shared/contracts/index.ts";
import {
  startMissionContextOperation,
  type LocalMissionContextOperation,
} from "./mission-conversation-model.ts";

export function useMissionContextOperations(options: {
  readonly missionId: string;
  readonly canCompact: boolean;
  readonly api?: PragmaDesktopAPI | undefined;
  readonly begin: () => string | undefined;
  readonly finish: (token: string) => void;
  readonly updateChat: Dispatch<SetStateAction<MissionChatSnapshot | null>>;
  readonly formatError: (error: unknown) => string;
  readonly followLatest: () => void;
}) {
  const [operations, setOperations] = useState<LocalMissionContextOperation[]>([]);

  useEffect(() => setOperations([]), [options.missionId]);

  const compact = useCallback(
    async (retryOperationId?: string): Promise<void> => {
      if (options.api === undefined || !options.canCompact) return;
      const operationToken = options.begin();
      if (operationToken === undefined) return;
      const operationId = retryOperationId ?? crypto.randomUUID();
      setOperations((current) =>
        startMissionContextOperation(current, {
          id: operationId,
          createdAt: new Date().toISOString(),
          retry: retryOperationId !== undefined,
        }),
      );
      options.followLatest();
      try {
        const result = await options.api.compactMissionContext(options.missionId);
        options.updateChat((current) =>
          current === null ? current : { ...current, contextWindow: result.contextWindow },
        );
        setOperations((current) =>
          current.map((operation) =>
            operation.id === operationId
              ? {
                  ...operation,
                  status: result.outcome === "compacted" ? "succeeded" : "skipped",
                }
              : operation,
          ),
        );
      } catch (compactError) {
        setOperations((current) =>
          current.map((operation) =>
            operation.id === operationId
              ? { ...operation, status: "failed", error: options.formatError(compactError) }
              : operation,
          ),
        );
      } finally {
        options.finish(operationToken);
      }
    },
    [
      options.api,
      options.begin,
      options.canCompact,
      options.finish,
      options.followLatest,
      options.formatError,
      options.missionId,
      options.updateChat,
    ],
  );

  return { operations, compact };
}
