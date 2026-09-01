import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DesktopRuntimeModel,
  DesktopToolPermissionMode,
  MissionModelOverride,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import type { RuntimeDisplayIdentity } from "../../lib/runtime-display.ts";

export function useMissionOptions(options: {
  readonly missionId: string;
  readonly executorRef: string;
  readonly isFlow: boolean;
  readonly persistedToolPermissionMode: DesktopToolPermissionMode;
  readonly persistedModelOverride?: MissionModelOverride | undefined;
  readonly saving: boolean;
  readonly controlsDisabled: boolean;
  readonly api?: PragmaDesktopAPI | undefined;
  readonly beginSave: () => string | undefined;
  readonly finishSave: (token: string) => void;
  readonly persist?:
    | ((options: {
        readonly toolPermissionMode: DesktopToolPermissionMode;
        readonly modelOverride?: MissionModelOverride | undefined;
      }) => void | Promise<void>)
    | undefined;
  readonly onError: (error: unknown) => void;
  readonly onClearError: () => void;
}) {
  const [models, setModels] = useState<readonly DesktopRuntimeModel[]>([]);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeDisplayIdentity>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [defaultModelSelection, setDefaultModelSelection] = useState<MissionModelOverride>();
  const [modelResetRequired, setModelResetRequired] = useState(false);
  const [toolPermissionMode, setToolPermissionMode] = useState<DesktopToolPermissionMode>(
    options.persistedToolPermissionMode,
  );
  const [modelOverride, setModelOverride] = useState<MissionModelOverride | undefined>(
    options.persistedModelOverride,
  );
  const modelRuntimeIdRef = useRef<string | undefined>(undefined);
  const callbacksRef = useRef({
    onError: options.onError,
    onClearError: options.onClearError,
    persist: options.persist,
  });
  callbacksRef.current = {
    onError: options.onError,
    onClearError: options.onClearError,
    persist: options.persist,
  };

  useEffect(() => {
    if (options.saving) return;
    setToolPermissionMode(options.persistedToolPermissionMode);
    setModelOverride(options.persistedModelOverride);
  }, [options.persistedModelOverride, options.persistedToolPermissionMode, options.saving]);

  useEffect(() => {
    setModels([]);
    setRuntimeIdentity(undefined);
    setDefaultModelSelection(undefined);
    setModelResetRequired(false);
    modelRuntimeIdRef.current = undefined;
    callbacksRef.current.onClearError();
    if (options.api === undefined || options.isFlow) return;
    let cancelled = false;
    const load = (showLoading: boolean) => {
      if (showLoading) setModelsLoading(true);
      void options
        .api!.getMissionModelOptions(options.executorRef, options.missionId)
        .then((result) => {
          if (cancelled) return;
          modelRuntimeIdRef.current = result.runtime.id;
          setRuntimeIdentity(result.runtime);
          setModels(result.models);
          setDefaultModelSelection(result.defaultSelection);
          setModelResetRequired(result.status === "reset_required");
          callbacksRef.current.onClearError();
        })
        .catch((loadError: unknown) => {
          if (!cancelled) callbacksRef.current.onError(loadError);
        })
        .finally(() => {
          if (!cancelled && showLoading) setModelsLoading(false);
        });
    };
    const unsubscribe = options.api.subscribeRuntimeModelCatalog((runtimeId) => {
      if (modelRuntimeIdRef.current === undefined || modelRuntimeIdRef.current === runtimeId) {
        load(false);
      }
    });
    load(true);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [options.api, options.executorRef, options.isFlow, options.missionId]);

  const save = useCallback(
    async (
      nextToolPermissionMode: DesktopToolPermissionMode,
      nextModelOverride: MissionModelOverride | undefined,
    ): Promise<void> => {
      if (options.controlsDisabled) return;
      const operationToken = options.beginSave();
      if (operationToken === undefined) return;
      const previousToolPermissionMode = toolPermissionMode;
      const previousModelOverride = modelOverride;
      setToolPermissionMode(nextToolPermissionMode);
      setModelOverride(nextModelOverride);
      try {
        await callbacksRef.current.persist?.({
          toolPermissionMode: nextToolPermissionMode,
          ...(nextModelOverride === undefined ? {} : { modelOverride: nextModelOverride }),
        });
        callbacksRef.current.onClearError();
      } catch (saveError) {
        setToolPermissionMode(previousToolPermissionMode);
        setModelOverride(previousModelOverride);
        callbacksRef.current.onError(saveError);
      } finally {
        options.finishSave(operationToken);
      }
    },
    [
      modelOverride,
      options.beginSave,
      options.controlsDisabled,
      options.finishSave,
      toolPermissionMode,
    ],
  );

  return {
    models,
    runtimeIdentity,
    modelsLoading,
    defaultModelSelection,
    modelResetRequired,
    toolPermissionMode,
    modelOverride,
    save,
  };
}
