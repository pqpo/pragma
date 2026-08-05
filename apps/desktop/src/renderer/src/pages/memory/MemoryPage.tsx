import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  MagnifyingGlass,
  Play,
  ShieldCheck,
  StopCircle,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  DesktopMemoryEvidence,
  DesktopMemoryExtractionBoard,
  DesktopMemoryExtractionTask,
  DesktopMemoryItem,
  DesktopMemoryPlaneStatus,
  DesktopKnowledgeCandidate,
  DesktopKnowledgeSource,
} from "../../../../shared/contracts/index.ts";
import { ConfirmationDialog, Dialog } from "../../components/Dialog.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";

type MemoryView =
  "all" | "episodic" | "semantic" | "knowledge" | "candidates" | "extractions" | "health";

export function MemoryPage() {
  const { t } = useTranslation("memory");
  const [view, setView] = useState<MemoryView>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly DesktopMemoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [health, setHealth] = useState<DesktopMemoryPlaneStatus>();
  const [extractionBoard, setExtractionBoard] = useState<DesktopMemoryExtractionBoard>();
  const [evidence, setEvidence] = useState<DesktopMemoryEvidence>();
  const [candidates, setCandidates] = useState<readonly DesktopKnowledgeCandidate[]>([]);
  const [knowledgeSource, setKnowledgeSource] = useState<DesktopKnowledgeSource>();
  const [bindingType, setBindingType] = useState<
    "pragma.expert" | "pragma.expert-team" | "pragma.flow" | "pragma.project"
  >("pragma.expert");
  const [bindingId, setBindingId] = useState("");
  const [allowExport, setAllowExport] = useState(false);
  const [publishPublic, setPublishPublic] = useState(false);
  const [reason, setReason] = useState("");
  const [dialog, setDialog] = useState<"revise" | "forget">();
  const [revisionDraft, setRevisionDraft] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busyExtractionTask, setBusyExtractionTask] = useState<string>();
  const hasLoaded = useRef(false);

  const reload = useCallback(
    async (silent = false) => {
      if (!silent && !hasLoaded.current) setLoading(true);
      try {
        const [records, status, extractionJobs, candidateRecords] = await Promise.all([
          view === "extractions" || view === "candidates"
            ? Promise.resolve([])
            : window.pragmaDesktop.listMemoryItems({
                module: view === "health" ? "all" : view,
                status: "all",
                query,
                limit: 200,
              }),
          window.pragmaDesktop.getMemoryPlaneStatus(),
          view === "extractions"
            ? window.pragmaDesktop.listMemoryExtractionJobs()
            : Promise.resolve(undefined),
          view === "candidates"
            ? window.pragmaDesktop.listKnowledgeCandidates({ state: "pending_review" })
            : Promise.resolve([]),
        ]);
        setItems(records);
        setHealth(status);
        if (extractionJobs !== undefined) setExtractionBoard(extractionJobs);
        setCandidates(candidateRecords);
        const selectableIds =
          view === "candidates"
            ? candidateRecords.map((candidate) => candidate.id)
            : records.map(key);
        setSelectedId((current) =>
          current !== undefined && selectableIds.includes(current)
            ? current
            : selectableIds[0] === undefined
              ? undefined
              : selectableIds[0],
        );
        setError(undefined);
        return extractionJobs;
      } catch (loadError) {
        setError(errorMessage(loadError));
        return undefined;
      } finally {
        hasLoaded.current = true;
        setLoading(false);
      }
    },
    [query, view],
  );

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 120);
    return () => clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    if (view !== "extractions") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const board = await reload(true);
      if (!cancelled) timer = setTimeout(() => void poll(), memoryExtractionPollDelay(board));
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [reload, view]);

  const selected = useMemo(
    () => items.find((item) => key(item) === selectedId),
    [items, selectedId],
  );

  const run = async (operation: () => Promise<unknown>) => {
    if (reason.trim() === "") return false;
    setActionBusy(true);
    try {
      await operation();
      setReason("");
      setEvidence(undefined);
      await reload();
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const manageExtraction = async (
    task: DesktopMemoryExtractionTask,
    action: "expedite" | "retry" | "interrupt" | "delete",
  ) => {
    const key = `${task.module}:${task.id}`;
    setBusyExtractionTask(key);
    setError(undefined);
    try {
      await window.pragmaDesktop.manageMemoryExtractionTask({
        module: task.module,
        action,
        id: task.id,
        expectedRevision: task.revision,
      });
      await reload(true);
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusyExtractionTask(undefined);
    }
  };

  return (
    <section className="memory-page">
      <header className="memory-page-header">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("description")}</p>
        </div>
        <label className="memory-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">{t("search")}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search")}
          />
        </label>
      </header>

      <nav className="memory-tabs" aria-label={t("title")}>
        {(
          [
            "all",
            "episodic",
            "semantic",
            "knowledge",
            "candidates",
            "extractions",
            "health",
          ] as const
        ).map((id) => (
          <button
            key={id}
            type="button"
            className={view === id ? "is-active" : undefined}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {t(id === "episodic" ? "episodes" : id === "semantic" ? "facts" : id)}
          </button>
        ))}
      </nav>

      {error !== undefined ? (
        <div className="memory-error" role="alert">
          <WarningCircle size={18} aria-hidden="true" /> {error}
        </div>
      ) : null}
      <MemoryDegradedAlert health={health} />

      {view === "health" ? (
        <MemoryHealth health={health} />
      ) : view === "extractions" ? (
        <MemoryExtractionJobs
          board={extractionBoard}
          loading={loading && extractionBoard === undefined}
          busyTask={busyExtractionTask}
          onRefresh={() => void reload(true)}
          onAction={manageExtraction}
        />
      ) : view === "candidates" ? (
        <div className="memory-browser">
          <aside className="memory-list">
            {candidates.length === 0 ? <p>{t("noCandidates")}</p> : null}
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={
                  selectedId === candidate.id ? "memory-list-item is-active" : "memory-list-item"
                }
                onClick={() => {
                  setSelectedId(candidate.id);
                  setBindingType(
                    candidate.rootRef.type === "pragma.expert" ||
                      candidate.rootRef.type === "pragma.expert-team" ||
                      candidate.rootRef.type === "pragma.flow"
                      ? candidate.rootRef.type
                      : "pragma.expert",
                  );
                  setBindingId(candidate.rootRef.id);
                  setKnowledgeSource(undefined);
                }}
              >
                <span>{t("candidates")}</span>
                <strong>{candidate.content.title}</strong>
                <small>{t("revision", { revision: candidate.revision })}</small>
              </button>
            ))}
          </aside>
          <main className="memory-detail">
            {(() => {
              const candidate = candidates.find((item) => item.id === selectedId);
              if (candidate === undefined) return <p>{t("selectCandidate")}</p>;
              const binding = { type: bindingType, id: bindingId.trim() };
              return (
                <>
                  <header>
                    <span className="memory-status is-pending_review">pending_review</span>
                    <h2>{candidate.content.title}</h2>
                    <p>{candidate.content.summary}</p>
                  </header>
                  <section>
                    <h3>{t("guidance")}</h3>
                    <ul>
                      {candidate.content.guidance.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h3>{t("sources")}</h3>
                    <div className="memory-evidence-list">
                      {candidate.sourceRefs.map((sourceRef) => (
                        <button
                          key={`${sourceRef.kind}:${sourceRef.id}:${sourceRef.revision}`}
                          type="button"
                          onClick={() =>
                            void window.pragmaDesktop
                              .getKnowledgeSource({ sourceRef })
                              .then(setKnowledgeSource)
                              .catch((value: unknown) => setError(errorMessage(value)))
                          }
                        >
                          {sourceRef.kind}:{sourceRef.id}@{sourceRef.revision}
                        </button>
                      ))}
                    </div>
                    {knowledgeSource === undefined ? null : (
                      <pre>{JSON.stringify(knowledgeSource, null, 2)}</pre>
                    )}
                  </section>
                  <section>
                    <h3>{t("publishBindings")}</h3>
                    <p className="memory-note">{t("publishBindingsDescription")}</p>
                    <label className="memory-dialog-field">
                      <span>{t("bindingType")}</span>
                      <SelectMenu
                        ariaLabel={t("bindingType")}
                        value={bindingType}
                        options={[
                          { value: "pragma.expert", label: "Expert" },
                          { value: "pragma.expert-team", label: "ExpertTeam" },
                          { value: "pragma.flow", label: "Flow" },
                          { value: "pragma.project", label: "Project" },
                        ]}
                        onChange={(value) => setBindingType(value as typeof bindingType)}
                      />
                    </label>
                    <label className="memory-dialog-field">
                      <span>{t("bindingId")}</span>
                      <input
                        value={bindingId}
                        onChange={(event) => setBindingId(event.target.value)}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={allowExport}
                        onChange={(event) => setAllowExport(event.target.checked)}
                      />{" "}
                      {t("allowBundleExport")}
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={publishPublic}
                        onChange={(event) => setPublishPublic(event.target.checked)}
                      />{" "}
                      {t("confirmPublic")}
                    </label>
                  </section>
                  <label className="memory-reason">
                    <span>{t("reason")}</span>
                    <input value={reason} onChange={(event) => setReason(event.target.value)} />
                  </label>
                  <div className="memory-actions">
                    <button
                      type="button"
                      disabled={reason.trim() === "" || binding.id === "" || actionBusy}
                      onClick={() =>
                        void run(
                          async () =>
                            await window.pragmaDesktop.publishKnowledgeCandidate({
                              id: candidate.id,
                              expectedRevision: candidate.revision,
                              reason,
                              bindings: [
                                {
                                  consumerRef: binding,
                                  recall: "allow",
                                  export: allowExport ? "allow" : "deny",
                                  permissionRevision: 1,
                                },
                              ],
                              visibility: publishPublic
                                ? { mode: "public" }
                                : { mode: "restricted", principals: [binding] },
                              confirmPublic: publishPublic,
                            }),
                        )
                      }
                    >
                      {t("publish")}
                    </button>
                    <button
                      className="is-danger"
                      type="button"
                      disabled={reason.trim() === "" || actionBusy}
                      onClick={() =>
                        void run(
                          async () =>
                            await window.pragmaDesktop.rejectKnowledgeCandidate({
                              id: candidate.id,
                              expectedRevision: candidate.revision,
                              reason,
                            }),
                        )
                      }
                    >
                      {t("reject")}
                    </button>
                  </div>
                </>
              );
            })()}
          </main>
        </div>
      ) : (
        <div className="memory-browser">
          <aside className="memory-list">
            {loading ? <p>{t("loading")}</p> : null}
            {!loading && items.length === 0 ? <p>{t("empty")}</p> : null}
            {items.map((item) => (
              <button
                key={key(item)}
                type="button"
                className={
                  key(item) === selectedId ? "memory-list-item is-active" : "memory-list-item"
                }
                onClick={() => {
                  setSelectedId(key(item));
                  setEvidence(undefined);
                }}
              >
                <span>
                  {item.module === "episodic"
                    ? t("episodes")
                    : item.module === "semantic"
                      ? t("facts")
                      : t("knowledge")}
                </span>
                <strong>{item.title}</strong>
                <small>
                  {t("revision", { revision: item.revision })} · {item.status}
                </small>
              </button>
            ))}
          </aside>
          <main className="memory-detail">
            {selected === undefined ? (
              <p>{t("select")}</p>
            ) : (
              <>
                <header>
                  <span className={`memory-status is-${selected.status}`}>{selected.status}</span>
                  <h2>{selected.title}</h2>
                  <p>{selected.summary}</p>
                </header>
                {selected.module === "knowledge" ? (
                  <section>
                    <h3>{t("guidance")}</h3>
                    <ul>
                      {selected.guidance.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                    {selected.origin === "bundle-import" ? (
                      <p className="memory-note">{t("importedKnowledgePersists")}</p>
                    ) : null}
                  </section>
                ) : null}
                <section>
                  <h3>{t("provenance")}</h3>
                  <dl>
                    <dt>{t("module")}</dt>
                    <dd>{selected.module}</dd>
                    <dt>{t("id")}</dt>
                    <dd>{selected.id}</dd>
                    <dt>{t("root")}</dt>
                    <dd>{formatMemorySubjectRefs(selected.rootRefs, selected.subjectNames)}</dd>
                    <dt>{t("producers")}</dt>
                    <dd>{formatMemorySubjectRefs(selected.producerRefs, selected.subjectNames)}</dd>
                    <dt>{t("visibility")}</dt>
                    <dd>{selected.visibility.mode}</dd>
                    <dt>{t("sensitivity")}</dt>
                    <dd>{selected.sensitivity}</dd>
                  </dl>
                </section>
                <section>
                  <h3>{t("bindings")}</h3>
                  <p className="memory-note">{t("permissionNote")}</p>
                  {selected.bindings.map((binding) => (
                    <div
                      className="memory-binding"
                      key={`${binding.consumerRef.type}:${binding.consumerRef.id}`}
                    >
                      <span>
                        {formatMemorySubjectRefs([binding.consumerRef], selected.subjectNames)}
                      </span>
                      <span>
                        {t("recall")} {binding.recall} · {t("export")} {binding.export} · p
                        {binding.permissionRevision}
                      </span>
                    </div>
                  ))}
                </section>
                {selected.module === "knowledge" ? null : (
                  <section>
                    <h3>{t("evidence")}</h3>
                    <div className="memory-evidence-list">
                      {selected.evidenceRefs.map((evidenceId) => (
                        <button
                          key={evidenceId}
                          type="button"
                          onClick={() =>
                            void window.pragmaDesktop
                              .getMemoryEvidence({
                                module: selected.module,
                                id: selected.id,
                                evidenceId,
                              })
                              .then(setEvidence)
                              .catch((value: unknown) => setError(errorMessage(value)))
                          }
                        >
                          {evidenceId}
                        </button>
                      ))}
                    </div>
                    {evidence !== undefined ? (
                      <pre>{JSON.stringify(evidence.payload, null, 2)}</pre>
                    ) : null}
                  </section>
                )}
                <label className="memory-reason">
                  <span>{t("reason")}</span>
                  <input value={reason} onChange={(event) => setReason(event.target.value)} />
                </label>
                <div className="memory-actions">
                  {selected.module === "semantic" ? (
                    <>
                      <button
                        type="button"
                        disabled={reason.trim() === "" || actionBusy}
                        onClick={() =>
                          void run(
                            async () =>
                              await window.pragmaDesktop.verifySemanticFact({
                                id: selected.id,
                                expectedRevision: selected.revision,
                                reason,
                              }),
                          )
                        }
                      >
                        <ShieldCheck size={17} aria-hidden="true" /> {t("verify")}
                      </button>
                      <button
                        type="button"
                        disabled={reason.trim() === "" || actionBusy}
                        onClick={() => {
                          setRevisionDraft(selected.statement);
                          setDialog("revise");
                        }}
                      >
                        {t("revise")}
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    disabled={
                      reason.trim() === "" ||
                      actionBusy ||
                      selected.status === "invalidated" ||
                      selected.status === "withdrawn"
                    }
                    onClick={() =>
                      void run(
                        async () =>
                          await window.pragmaDesktop.invalidateMemoryItem({
                            module: selected.module,
                            id: selected.id,
                            expectedRevision: selected.revision,
                            reason,
                          }),
                      )
                    }
                  >
                    {selected.module === "knowledge" ? t("withdraw") : t("invalidate")}
                  </button>
                  {selected.module === "knowledge" ? null : (
                    <button
                      className="is-danger"
                      type="button"
                      disabled={reason.trim() === "" || actionBusy}
                      onClick={() => setDialog("forget")}
                    >
                      <Trash size={17} aria-hidden="true" /> {t("forget")}
                    </button>
                  )}
                  {selected.bindings.map((binding) =>
                    binding.recall === "allow" ? (
                      <MemoryActionWithTooltip
                        key={`${binding.consumerRef.type}:${binding.consumerRef.id}`}
                        disabled={reason.trim() === "" || actionBusy}
                        label={t("disableRecall")}
                        tooltip={t("disableRecallTooltip", {
                          consumer: formatMemorySubjectRefs(
                            [binding.consumerRef],
                            selected.subjectNames,
                          ),
                        })}
                        onClick={() =>
                          void run(
                            async () =>
                              await window.pragmaDesktop.tightenMemoryAccess({
                                module: selected.module,
                                id: selected.id,
                                expectedRevision: selected.revision,
                                reason,
                                bindings: selected.bindings.map((candidate) =>
                                  candidate === binding
                                    ? {
                                        ...candidate,
                                        recall: "deny",
                                        permissionRevision: candidate.permissionRevision + 1,
                                      }
                                    : candidate,
                                ),
                              }),
                          )
                        }
                      />
                    ) : null,
                  )}
                  {selected.visibility.mode === "restricted" ||
                  selected.rootRefs.length === 0 ? null : (
                    <MemoryActionWithTooltip
                      disabled={reason.trim() === "" || actionBusy}
                      label={t("restrictVisibility")}
                      tooltip={t("restrictVisibilityTooltip", {
                        principals: formatMemorySubjectRefs(
                          selected.rootRefs,
                          selected.subjectNames,
                        ),
                      })}
                      onClick={() =>
                        void run(
                          async () =>
                            await window.pragmaDesktop.tightenMemoryAccess({
                              module: selected.module,
                              id: selected.id,
                              expectedRevision: selected.revision,
                              reason,
                              visibility: {
                                mode: "restricted",
                                principals: selected.rootRefs,
                              },
                            }),
                        )
                      }
                    />
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      )}
      {dialog === "revise" && selected?.module === "semantic" ? (
        <Dialog
          title={t("revisedStatement")}
          description={t("reviseDescription")}
          busy={actionBusy}
          onCancel={() => setDialog(undefined)}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={actionBusy}
                onClick={() => setDialog(undefined)}
              >
                {t("cancel")}
              </button>
              <button
                className="primary-button"
                type="submit"
                form="memory-revision-form"
                disabled={actionBusy || revisionDraft.trim() === ""}
              >
                {actionBusy ? t("saving") : t("save")}
              </button>
            </>
          }
        >
          <form
            id="memory-revision-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (revisionDraft.trim() === "" || actionBusy) return;
              void run(
                async () =>
                  await window.pragmaDesktop.reviseSemanticFact({
                    id: selected.id,
                    expectedRevision: selected.revision,
                    reason,
                    patch: { statement: revisionDraft },
                  }),
              ).then((saved) => {
                if (saved) setDialog(undefined);
              });
            }}
          >
            <label className="memory-dialog-field">
              <span>{t("revisedStatement")}</span>
              <input
                data-dialog-initial-focus
                value={revisionDraft}
                maxLength={4_000}
                disabled={actionBusy}
                onChange={(event) => setRevisionDraft(event.target.value)}
              />
            </label>
          </form>
        </Dialog>
      ) : null}
      {dialog === "forget" && selected !== undefined ? (
        <ConfirmationDialog
          title={t("forgetTitle")}
          description={t("forgottenConfirm")}
          cancelLabel={t("cancel")}
          confirmLabel={t("forget")}
          busyLabel={t("forgetting")}
          busy={actionBusy}
          tone="danger"
          onCancel={() => setDialog(undefined)}
          onConfirm={() => {
            void run(
              async () =>
                await window.pragmaDesktop.forgetMemoryItem({
                  module: selected.module,
                  id: selected.id,
                  expectedRevision: selected.revision,
                  reason,
                }),
            ).then((forgotten) => {
              if (forgotten) setDialog(undefined);
            });
          }}
        />
      ) : null}
    </section>
  );
}

export function memoryExtractionPollDelay(board: DesktopMemoryExtractionBoard | undefined): number {
  return board !== undefined && (board.counts.waiting > 0 || board.counts.running > 0)
    ? 2_000
    : 10_000;
}

export function MemoryActionWithTooltip(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly tooltip: string;
  readonly onClick: () => void;
}) {
  const tooltipId = useId();
  return (
    <span className="memory-action-with-tooltip">
      <button
        type="button"
        aria-describedby={tooltipId}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.label}
      </button>
      <span id={tooltipId} className="memory-action-tooltip" role="tooltip">
        {props.tooltip}
      </span>
    </span>
  );
}

export function MemoryExtractionJobs(props: {
  readonly board?: DesktopMemoryExtractionBoard | undefined;
  readonly loading: boolean;
  readonly busyTask?: string | undefined;
  readonly onRefresh: () => void;
  readonly onAction: (
    task: DesktopMemoryExtractionTask,
    action: "expedite" | "retry" | "interrupt" | "delete",
  ) => Promise<void>;
}) {
  const { t } = useTranslation("memory");
  const [pendingDelete, setPendingDelete] = useState<DesktopMemoryExtractionTask>();
  const lanes = ["waiting", "attention", "running", "completed"] as const;
  const tasks = props.board?.tasks ?? [];
  return (
    <section className="memory-health memory-extraction-jobs">
      <header className="memory-extraction-jobs-header">
        <div>
          <h2>{t("extractions")}</h2>
          <p>{t("extractionsDescription")}</p>
        </div>
        <button type="button" disabled={props.loading} onClick={props.onRefresh}>
          <ArrowClockwise size={17} aria-hidden="true" /> {t("refresh")}
        </button>
      </header>
      {props.loading ? <p>{t("loading")}</p> : null}
      {!props.loading ? (
        <div className="memory-extraction-board">
          {lanes.map((lane) => {
            const laneTasks = tasks.filter((task) => task.lane === lane);
            return (
              <section className={`memory-extraction-lane is-${lane}`} key={lane}>
                <header>
                  <h3>{t(`extractionLanes.${lane}`)}</h3>
                  <span>{props.board?.counts[lane] ?? 0}</span>
                </header>
                <div className="memory-extraction-lane-items">
                  {laneTasks.length === 0 ? (
                    <p className="memory-extraction-lane-empty">{t("emptyExtractionLane")}</p>
                  ) : null}
                  {laneTasks.map((task) => {
                    const taskKey = `${task.module}:${task.id}`;
                    const busy = props.busyTask === taskKey;
                    return (
                      <article className="memory-extraction-task" key={taskKey}>
                        <strong>
                          {task.title ??
                            t(task.module === "knowledge" ? "unknownAsset" : "unknownMission")}
                        </strong>
                        <span className={`memory-extraction-type is-${task.module}`}>
                          {t(`extractionTaskTypes.${task.module}`)}
                        </span>
                        {lane === "attention" && task.lastErrorCode !== undefined ? (
                          <code className="memory-extraction-error">{task.lastErrorCode}</code>
                        ) : null}
                        {lane !== "completed" ? (
                          <footer>
                            {lane === "waiting" ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void props.onAction(task, "expedite")}
                              >
                                <Play size={16} aria-hidden="true" /> {t("extractNow")}
                              </button>
                            ) : null}
                            {lane === "attention" ? (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void props.onAction(task, "retry")}
                                >
                                  <ArrowCounterClockwise size={16} aria-hidden="true" />
                                  {t("retryExtraction")}
                                </button>
                                <button
                                  className="is-danger"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setPendingDelete(task)}
                                >
                                  <Trash size={16} aria-hidden="true" /> {t("deleteExtraction")}
                                </button>
                              </>
                            ) : null}
                            {lane === "running" ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void props.onAction(task, "interrupt")}
                              >
                                <StopCircle size={16} aria-hidden="true" />
                                {t("interruptExtraction")}
                              </button>
                            ) : null}
                          </footer>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
      {pendingDelete === undefined ? null : (
        <ConfirmationDialog
          title={t("deleteExtractionTitle")}
          description={t("deleteExtractionDescription", {
            title:
              pendingDelete.title ??
              t(pendingDelete.module === "knowledge" ? "unknownAsset" : "unknownMission"),
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteExtraction")}
          busyLabel={t("deletingExtraction")}
          busy={props.busyTask === `${pendingDelete.module}:${pendingDelete.id}`}
          tone="danger"
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() => {
            void props.onAction(pendingDelete, "delete").then(() => setPendingDelete(undefined));
          }}
        />
      )}
    </section>
  );
}

function MemoryHealth(props: { readonly health?: DesktopMemoryPlaneStatus | undefined }) {
  const { t } = useTranslation("memory");
  if (props.health === undefined) return <p>{t("loading")}</p>;
  return (
    <section className="memory-health">
      <h2>{t("health")}</h2>
      <p>
        {t("healthSummary", {
          state: props.health.state,
          modules: props.health.modules.length,
          events: props.health.feed.eventCount,
        })}
      </p>
      <p>
        {t("storageHealth", {
          logical: formatHealthBytes(props.health.feed.logicalBytes),
          target: formatHealthBytes(
            props.health.storagePolicy?.canonicalFeedTargetBytes ?? 512 * 1_024 * 1_024,
          ),
          blocked: formatHealthBytes(props.health.feed.blockedBytes),
          safe: props.health.feed.safeThroughSequence,
        })}
      </p>
      {props.health.modules.map((module) => (
        <article key={module.moduleId}>
          <strong>
            {module.moduleId}@{module.moduleVersion}
          </strong>
          <span>
            {t("moduleHealthSummary", {
              status: module.status,
              lag: module.lag,
              records: module.work?.records ?? 0,
              pending: (module.work?.pending ?? 0) + (module.work?.running ?? 0),
              attention: module.work?.needsAttention ?? 0,
              rejected: module.work?.rejected ?? 0,
            })}
            {module.lastErrorCode === undefined ? null : (
              <>
                <br />
                <code>{t("lastExtractionError", { code: module.lastErrorCode })}</code>
              </>
            )}
          </span>
        </article>
      ))}
    </section>
  );
}

function formatHealthBytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export function MemoryDegradedAlert(props: {
  readonly health?: DesktopMemoryPlaneStatus | undefined;
}) {
  const { t } = useTranslation("memory");
  if (props.health?.state !== "degraded") return null;
  const attention = props.health.modules.reduce(
    (total, module) => total + (module.work?.needsAttention ?? 0),
    0,
  );
  const codes = [
    props.health.lastError?.code,
    ...props.health.modules.map((module) => module.lastErrorCode),
  ].filter(
    (code, index, values): code is string => code !== undefined && values.indexOf(code) === index,
  );
  const extractionOnly =
    attention > 0 &&
    !props.health.modules.some((module) => module.status === "unavailable") &&
    !isNonExtractionPipelineError(props.health.lastError?.code);
  return (
    <div className="memory-error" role="alert">
      <WarningCircle size={20} aria-hidden="true" />
      <span>
        <strong>{t(extractionOnly ? "extractionDegraded" : "memoryDegraded")}</strong>
        <br />
        {extractionOnly
          ? t("extractionDegradedDescription", { count: attention })
          : t("memoryDegradedDescription")}
        {codes.length === 0 ? null : (
          <>
            <br />
            <code>{t("lastExtractionError", { code: codes.join(", ") })}</code>
          </>
        )}
      </span>
    </div>
  );
}

function isNonExtractionPipelineError(code: string | undefined): boolean {
  return [
    "canonical_event_handoff_quarantined",
    "canonical_event_delivery_failed",
    "memory_pipeline_iteration_failed",
  ].includes(code ?? "");
}

function key(item: DesktopMemoryItem): string {
  return `${item.module}:${item.id}`;
}

export function formatMemorySubjectRefs(
  values: readonly { readonly type: string; readonly id: string }[],
  names: Readonly<Record<string, string>> = {},
): string {
  return (
    values
      .map((value) => {
        const ref = `${value.type}:${value.id}`;
        const name = names[ref];
        return name === undefined ? ref : `${name}(${ref})`;
      })
      .join(", ") || "—"
  );
}
