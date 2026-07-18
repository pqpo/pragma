import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Brain,
  Check,
  FolderOpen,
  GearSix,
  PaperPlaneTilt,
  Sparkle,
  StopCircle,
  X,
} from "@phosphor-icons/react";

import type {
  DesktopRuntimeAvailability,
  DesktopRuntimeModel,
  StewardChatSnapshot,
  StewardInteraction,
  StewardSessionState,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";

const WORKSPACE_KEY = "pragma.steward.task-workspace";

export function HomePage(props: {
  readonly onOpenStudio: () => void;
  readonly onOpenMissions: () => void;
  readonly onOpenModelSettings: () => void;
  readonly onOpenRuntimeSettings: () => void;
}) {
  const [snapshot, setSnapshot] = useState<StewardChatSnapshot>({ state: null, entries: [] });
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [runtimeId, setRuntimeId] = useState("pi");
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [workspace, setWorkspace] = useState(() =>
    typeof window === "undefined" ? "" : (window.localStorage.getItem(WORKSPACE_KEY) ?? ""),
  );
  const [message, setMessage] = useState("");
  const [interactions, setInteractions] = useState<readonly StewardInteraction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configurationNeeded, setConfigurationNeeded] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const api = window.pragmaDesktop;
    const [chat, pending] = await Promise.all([
      api.getStewardChat(),
      api
        .getStewardState()
        .then((state) => (state === null ? Promise.resolve([]) : api.listStewardInteractions())),
    ]);
    setSnapshot(chat);
    setInteractions(pending);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getStewardState(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([state, availability]) => {
        if (cancelled) return;
        setSnapshot((current) => ({ ...current, state }));
        setRuntimes(availability);
        setRuntimeId(state?.runtimeId ?? "pi");
        if (state !== null) {
          void refresh().catch((loadError: unknown) => setError(errorMessage(loadError)));
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (snapshot.state?.status !== "running" && snapshot.state?.status !== "waiting") return;
    const timer = setInterval(() => {
      void refresh().catch((loadError: unknown) => setError(errorMessage(loadError)));
    }, 600);
    return () => clearInterval(timer);
  }, [snapshot.state?.status]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [snapshot.entries.length, interactions.length]);

  const selectedRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.id === runtimeId),
    [runtimeId, runtimes],
  );
  const selectedModel = useMemo(
    () => selectedRuntime?.models?.find((model) => runtimeModelKey(model) === modelKey),
    [modelKey, selectedRuntime],
  );
  const modelSelection = useMemo(
    () =>
      selectedModel === undefined
        ? undefined
        : {
            model: { providerId: selectedModel.provider.id, modelId: selectedModel.id },
            ...(thinkingLevel === "" ? {} : { thinkingLevel }),
          },
    [selectedModel, thinkingLevel],
  );

  useEffect(() => {
    const models = selectedRuntime?.models ?? [];
    const remembered = snapshot.state?.modelSelection;
    const rememberedKey =
      snapshot.state?.runtimeId === runtimeId && remembered !== undefined
        ? JSON.stringify([remembered.model.providerId, remembered.model.modelId])
        : undefined;
    const model =
      models.find((candidate) => runtimeModelKey(candidate) === rememberedKey) ??
      models.find((candidate) => candidate.default) ??
      models[0];
    setModelKey(model === undefined ? "" : runtimeModelKey(model));
    setThinkingLevel(
      model === undefined
        ? ""
        : rememberedKey === runtimeModelKey(model) && remembered?.thinkingLevel !== undefined
          ? remembered.thinkingLevel
          : (model.thinking?.defaultLevel ?? ""),
    );
  }, [runtimeId, runtimes, snapshot.state?.modelSelection, snapshot.state?.runtimeId]);

  const initialized = snapshot.state !== null;
  const turnActive = snapshot.state?.status === "running" || snapshot.state?.status === "waiting";
  const canSend = message.trim() !== "" && !busy && runtimeId !== "" && !turnActive;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    setConfigurationNeeded(false);
    try {
      if ((await window.pragmaDesktop.listModelProviders()).length === 0) {
        setConfigurationNeeded(true);
        return;
      }
      if (selectedRuntime?.status !== "available") {
        throw new Error(selectedRuntime?.reason ?? "The selected Runtime is unavailable.");
      }
      if (modelSelection === undefined) {
        throw new Error(
          selectedRuntime.modelDiscoveryError ??
            "No model is available for this Runtime. Configure a model provider first.",
        );
      }
      let state: StewardSessionState | null = snapshot.state;
      if (state === null) state = await window.pragmaDesktop.initializeSteward({ runtimeId });
      const content = message.trim();
      setMessage("");
      const running = await window.pragmaDesktop.promptSteward({
        content,
        requestId: crypto.randomUUID(),
        modelSelection,
        ...(workspace === "" ? {} : { taskWorkspaceId: workspace }),
      });
      setSnapshot((current) => ({ ...current, state: running }));
      await refresh();
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="steward-home">
      <header className="steward-home-header">
        <div>
          <span className="steward-eyebrow">PRAGMA STEWARD</span>
          <h1>Your orchestration workspace</h1>
        </div>
        {initialized ? (
          <button
            className="steward-text-button"
            type="button"
            onClick={() => {
              if (
                !window.confirm("Reset the Steward session? Existing history will remain archived.")
              ) {
                return;
              }
              void window.pragmaDesktop.resetSteward().then(() => {
                setSnapshot({ state: null, entries: [] });
                setInteractions([]);
              });
            }}
          >
            Reset session
          </button>
        ) : null}
      </header>

      <div className={snapshot.entries.length === 0 ? "steward-chat is-empty" : "steward-chat"}>
        {snapshot.entries.length === 0 ? (
          <div className="steward-welcome">
            <span className="steward-orb">
              <Sparkle size={28} weight="fill" />
            </span>
            <h2>What would you like to orchestrate?</h2>
            <p>Create or update an Expert, assemble a Team, design a Flow, or submit a task.</p>
          </div>
        ) : (
          <div className="steward-messages">
            {snapshot.entries.map((entry) => (
              <article key={entry.id} className={`steward-message is-${entry.role}`}>
                {entry.role === "tool" ? (
                  <span className="steward-tool-name">{entry.toolName}</span>
                ) : null}
                <div>{entry.content}</div>
                {entry.role === "tool" &&
                !entry.isError &&
                /projectRevision|changedRefs/.test(entry.content) ? (
                  <button type="button" onClick={props.onOpenStudio}>
                    Open Studio <ArrowRight size={14} />
                  </button>
                ) : null}
                {entry.role === "tool" &&
                !entry.isError &&
                /workspaceLabel|executorRef/.test(entry.content) ? (
                  <button type="button" onClick={props.onOpenMissions}>
                    Open Missions <ArrowRight size={14} />
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        )}

        {interactions.map((interaction) => (
          <article className="steward-approval" key={interaction.interactionId}>
            <strong>{interaction.title}</strong>
            <p>{interaction.prompt}</p>
            <pre>{JSON.stringify(interaction.data, null, 2)}</pre>
            <div>
              <button type="button" onClick={() => void respond(interaction, false)}>
                <X size={15} /> Reject
              </button>
              <button
                className="is-primary"
                type="button"
                onClick={() => void respond(interaction, true)}
              >
                <Check size={15} /> Approve
              </button>
            </div>
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <div className="steward-composer-wrap">
        {error === null ? null : <div className="steward-error">{error}</div>}
        {configurationNeeded ? (
          <div className="steward-configuration-notice" role="alert">
            <div>
              <strong>Configure a model before chatting</strong>
              <span>The PI Runtime needs at least one Model Provider with an API key.</span>
            </div>
            <button type="button" onClick={props.onOpenModelSettings}>
              Configure models <ArrowRight size={14} />
            </button>
          </div>
        ) : null}
        <div className="steward-composer">
          <textarea
            value={message}
            placeholder="Ask the Steward to create an expert, design a flow, or run a task…"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="steward-composer-footer">
            <div className="steward-context-controls">
              <select
                aria-label="Runtime"
                value={runtimeId}
                disabled={busy || turnActive}
                onChange={(event) => void changeRuntime(event.target.value)}
              >
                {runtimes.length === 0 ? <option value="pi">PI Runtime</option> : null}
                {runtimes.map((runtime) => (
                  <option
                    value={runtime.id}
                    key={runtime.id}
                    disabled={runtime.status !== "available"}
                  >
                    {runtime.displayName}
                    {runtime.status === "available" ? "" : " · unavailable"}
                  </option>
                ))}
              </select>
              <select
                aria-label="Model"
                value={modelKey}
                disabled={busy || turnActive || selectedRuntime?.status !== "available"}
                onChange={(event) => {
                  const nextKey = event.target.value;
                  const nextModel = selectedRuntime?.models?.find(
                    (model) => runtimeModelKey(model) === nextKey,
                  );
                  setModelKey(nextKey);
                  setThinkingLevel(nextModel?.thinking?.defaultLevel ?? "");
                }}
              >
                {(selectedRuntime?.models?.length ?? 0) === 0 ? (
                  <option value="">No model configured</option>
                ) : null}
                {selectedRuntime?.models?.map((model) => (
                  <option value={runtimeModelKey(model)} key={runtimeModelKey(model)}>
                    {model.displayName} · {model.provider.displayName}
                  </option>
                ))}
              </select>
              <label className="steward-thinking-select">
                <Brain size={16} aria-hidden="true" />
                <select
                  aria-label="Thinking depth"
                  value={thinkingLevel}
                  disabled={busy || turnActive || selectedModel?.thinking === undefined}
                  onChange={(event) => setThinkingLevel(event.target.value)}
                >
                  <option value="">Default thinking</option>
                  {selectedModel?.thinking?.supportedLevels.map((level) => (
                    <option value={level.value} key={level.value}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                title="Manage Runtime Environments"
                onClick={props.onOpenRuntimeSettings}
              >
                <GearSix size={16} /> Manage runtimes
              </button>
              <button
                type="button"
                title={workspace || "Choose task workspace"}
                onClick={() =>
                  void window.pragmaDesktop.pickWorkspace().then((result) => {
                    if (!result.ok || result.path === undefined) return;
                    window.localStorage.setItem(WORKSPACE_KEY, result.path);
                    setWorkspace(result.path);
                  })
                }
              >
                <FolderOpen size={16} />{" "}
                {workspace === "" ? "Task workspace" : workspace.split(/[\\/]/).at(-1)}
              </button>
            </div>
            {turnActive ? (
              <button
                className="steward-send is-stop"
                type="button"
                onClick={() => void window.pragmaDesktop.interruptSteward().then(refresh)}
              >
                <StopCircle size={19} />
              </button>
            ) : (
              <button
                className="steward-send"
                type="button"
                disabled={!canSend}
                onClick={() => void send()}
                title={selectedRuntime?.displayName}
              >
                <PaperPlaneTilt size={19} weight="fill" />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );

  async function respond(interaction: StewardInteraction, approved: boolean) {
    setBusy(true);
    try {
      await window.pragmaDesktop.respondStewardInteraction({
        interactionId: interaction.interactionId,
        requestId: crypto.randomUUID(),
        approved,
      });
      await refresh();
    } catch (respondError) {
      setError(errorMessage(respondError));
    } finally {
      setBusy(false);
    }
  }

  async function changeRuntime(nextRuntimeId: string) {
    if (nextRuntimeId === runtimeId) return;
    if (!initialized) {
      setRuntimeId(nextRuntimeId);
      return;
    }
    const confirmed = window.confirm(
      "Switching Runtime starts a new Steward session. The current conversation context will be lost. Continue?",
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await window.pragmaDesktop.resetSteward();
      setRuntimeId(nextRuntimeId);
      setSnapshot({ state: null, entries: [] });
      setInteractions([]);
      const state = await window.pragmaDesktop.initializeSteward({ runtimeId: nextRuntimeId });
      setSnapshot({ state, entries: [] });
    } catch (switchError) {
      setError(errorMessage(switchError));
    } finally {
      setBusy(false);
    }
  }
}

function runtimeModelKey(model: DesktopRuntimeModel): string {
  return JSON.stringify([model.provider.id, model.id]);
}
