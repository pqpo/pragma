import { useCallback, useEffect, useRef, useState } from "react";

export type MissionClientOperationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "sending" | "saving_options" | "compacting" | "restoring";
      readonly token: string;
    };

export function claimMissionClientOperation(
  current: MissionClientOperationState,
  kind: Exclude<MissionClientOperationState["kind"], "idle">,
  token: string,
): MissionClientOperationState | null {
  return current.kind === "idle" ? { kind, token } : null;
}

export function releaseMissionClientOperation(
  current: MissionClientOperationState,
  token: string,
): MissionClientOperationState {
  return current.kind !== "idle" && current.token === token ? { kind: "idle" } : current;
}

export function useMissionClientOperation(missionId: string): {
  readonly state: MissionClientOperationState;
  readonly begin: (
    kind: Exclude<MissionClientOperationState["kind"], "idle">,
  ) => string | undefined;
  readonly finish: (token: string) => void;
} {
  const [state, setState] = useState<MissionClientOperationState>({ kind: "idle" });
  const stateRef = useRef<MissionClientOperationState>({ kind: "idle" });

  useEffect(() => {
    stateRef.current = { kind: "idle" };
    setState(stateRef.current);
  }, [missionId]);

  const begin = useCallback(
    (kind: Exclude<MissionClientOperationState["kind"], "idle">): string | undefined => {
      const token = crypto.randomUUID();
      const claimed = claimMissionClientOperation(stateRef.current, kind, token);
      if (claimed === null) return undefined;
      stateRef.current = claimed;
      setState(claimed);
      return token;
    },
    [],
  );

  const finish = useCallback((token: string): void => {
    const released = releaseMissionClientOperation(stateRef.current, token);
    if (released === stateRef.current) return;
    stateRef.current = released;
    setState(released);
  }, []);

  return { state, begin, finish };
}
