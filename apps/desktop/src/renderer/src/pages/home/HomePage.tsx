import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Brain,
  CaretDown,
  Check,
  PaperPlaneTilt,
  Sparkle,
  StopCircle,
  Toolbox,
  WarningCircle,
} from "@phosphor-icons/react";
import type { HumanInteractionResponse } from "@pragma/shared";

import type {
  DesktopRuntimeAvailability,
  DesktopRuntimeModel,
  StewardChatEntry,
  StewardChatSnapshot,
  StewardInteraction,
  StewardSessionState,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { readStewardTaskWorkspace } from "../../lib/steward-preferences.ts";
import { StewardInteractionCard } from "./StewardInteractionCard.tsx";

export function HomePage(props: {
  readonly onOpenStudio: () => void;
  readonly onOpenMissions: () => void;
  readonly onOpenModelSettings: () => void;
}) {
  const [snapshot, setSnapshot] = useState<StewardChatSnapshot>({ state: null, entries: [] });
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [runtimeId, setRuntimeId] = useState("pi");
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [workspace] = useState(() =>
    readStewardTaskWorkspace(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [message, setMessage] = useState("");
  const [interactions, setInteractions] = useState<readonly StewardInteraction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configurationNeeded, setConfigurationNeeded] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const api = window.pragmaDesktop;
    const chat = await api.getStewardChat();
    const pending = chat.state === null ? [] : await api.listStewardInteractions();
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
        setRuntimeId(
          state?.runtimeId ??
            availability.find((runtime) => runtime.isDefault)?.id ??
            availability.find((runtime) => runtime.status === "available")?.id ??
            "pi",
        );
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
            {snapshot.entries.map((entry) =>
              entry.role === "tool" ? (
                <StewardToolMessage
                  key={entry.id}
                  entry={entry}
                  onOpenStudio={props.onOpenStudio}
                  onOpenMissions={props.onOpenMissions}
                />
              ) : (
                <article key={entry.id} className={`steward-message is-${entry.role}`}>
                  <div>{entry.content}</div>
                </article>
              ),
            )}
          </div>
        )}

        {interactions.map((interaction) => (
          <StewardInteractionCard
            key={interaction.interactionId}
            interaction={interaction}
            responding={busy}
            onRespond={(response) => void respond(interaction, response)}
          />
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

  async function respond(interaction: StewardInteraction, response: HumanInteractionResponse) {
    setBusy(true);
    try {
      await window.pragmaDesktop.respondStewardInteraction({
        interactionId: interaction.interactionId,
        requestId: crypto.randomUUID(),
        response,
      });
      await refresh();
    } catch (respondError) {
      setError(errorMessage(respondError));
    } finally {
      setBusy(false);
    }
  }
}

function StewardToolMessage(props: {
  readonly entry: StewardChatEntry;
  readonly onOpenStudio: () => void;
  readonly onOpenMissions: () => void;
}) {
  const status =
    props.entry.toolStatus ??
    (props.entry.content === "Running" ? "running" : props.entry.isError ? "failed" : "succeeded");
  const hasDetails = status !== "running" && props.entry.content.trim() !== "";
  const label = status === "running" ? "Calling" : status === "failed" ? "Failed" : "Completed";
  const summary = (
    <>
      <Toolbox size={16} aria-hidden="true" />
      <strong>{props.entry.toolName ?? "tool"}</strong>
      <span>{label}</span>
      {status === "failed" ? (
        <WarningCircle size={15} aria-hidden="true" />
      ) : status === "succeeded" ? (
        <Check size={15} aria-hidden="true" />
      ) : null}
    </>
  );

  return (
    <article className={`steward-message is-tool is-${status}`}>
      {hasDetails ? (
        <details className="steward-tool-activity">
          <summary>
            {summary}
            <CaretDown className="steward-tool-caret" size={14} aria-hidden="true" />
          </summary>
          <pre>{props.entry.content}</pre>
        </details>
      ) : (
        <div
          className={
            status === "running" ? "steward-tool-status is-running" : "steward-tool-status"
          }
          role={status === "running" ? "status" : undefined}
        >
          {summary}
        </div>
      )}
      {status === "succeeded" && /projectRevision|changedRefs/.test(props.entry.content) ? (
        <button type="button" onClick={props.onOpenStudio}>
          Open Studio <ArrowRight size={14} />
        </button>
      ) : null}
      {status === "succeeded" && /workspaceLabel|executorRef/.test(props.entry.content) ? (
        <button type="button" onClick={props.onOpenMissions}>
          Open Missions <ArrowRight size={14} />
        </button>
      ) : null}
    </article>
  );
}

function runtimeModelKey(model: DesktopRuntimeModel): string {
  return JSON.stringify([model.provider.id, model.id]);
}
