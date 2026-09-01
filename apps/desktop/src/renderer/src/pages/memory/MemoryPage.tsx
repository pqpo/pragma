import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CheckCircle,
  Cube,
  Database,
  FileText,
  MagnifyingGlass,
  Play,
  ShieldCheck,
  StopCircle,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  DesktopMemoryEvidence,
  DesktopMemoryExtractionBoard,
  DesktopMemoryExtractionTask,
  DesktopMemoryExtractionTaskDetail,
  DesktopMemoryItem,
  DesktopMemoryPlaneStatus,
  ListDesktopMemoryExtractionJobs,
  MissionChatSnapshot,
  MemoryKnowledgeInitializationCandidate,
  MemorySkillCandidate,
} from "../../../../shared/contracts/index.ts";
import { classifyDesktopMemoryProblem } from "../../../../shared/memory-problem.ts";
import { ConfirmationDialog, Dialog } from "../../components/Dialog.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { MissionChatEntryView } from "../missions/MissionsPage.tsx";
import { applyMissionChatPatches } from "../missions/mission-conversation-model.ts";

type MemoryView =
  | "all"
  | "episodic"
  | "semantic"
  | "candidates"
  | "skillCandidates"
  | "extractions"
  | "health"
  | "taskDetails";
const MEMORY_EXTRACTION_LANES = ["waiting", "attention", "running", "completed"] as const;
type MemoryExtractionLane = (typeof MEMORY_EXTRACTION_LANES)[number];
type MemoryExtractionPageCursor = NonNullable<
  ListDesktopMemoryExtractionJobs["pages"][MemoryExtractionLane]["cursor"]
>;
const INITIAL_MEMORY_EXTRACTION_PAGES: ListDesktopMemoryExtractionJobs["pages"] = {
  waiting: { pageIndex: 0 },
  attention: { pageIndex: 0 },
  running: { pageIndex: 0 },
  completed: { pageIndex: 0 },
};

export function MemoryPage(props: { readonly onConfigureExtraction?: () => void } = {}) {
  const { t } = useTranslation("memory");
  const [view, setView] = useState<MemoryView>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly DesktopMemoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [health, setHealth] = useState<DesktopMemoryPlaneStatus>();
  const [extractionBoard, setExtractionBoard] = useState<DesktopMemoryExtractionBoard>();
  const [activeExtractionTasks, setActiveExtractionTasks] = useState<
    readonly DesktopMemoryExtractionTask[]
  >([]);
  const [evidence, setEvidence] = useState<DesktopMemoryEvidence>();
  const [candidates, setCandidates] = useState<readonly MemoryKnowledgeInitializationCandidate[]>(
    [],
  );
  const [skillCandidates, setSkillCandidates] = useState<readonly MemorySkillCandidate[]>([]);
  const [expertNames, setExpertNames] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState("");
  const [dialog, setDialog] = useState<"revise" | "forget">();
  const [revisionDraft, setRevisionDraft] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busyExtractionTask, setBusyExtractionTask] = useState<string>();
  const [extractionPages, setExtractionPages] = useState(INITIAL_MEMORY_EXTRACTION_PAGES);
  const [extractionPageCursors, setExtractionPageCursors] = useState<
    Record<MemoryExtractionLane, readonly (MemoryExtractionPageCursor | undefined)[]>
  >({ waiting: [undefined], attention: [undefined], running: [undefined], completed: [undefined] });
  const extractionRequestVersion = useRef(0);
  const hasLoaded = useRef(false);

  const reload = useCallback(
    async (silent = false) => {
      const requestVersion = (extractionRequestVersion.current += 1);
      if (!silent && !hasLoaded.current) setLoading(true);
      try {
        const [
          records,
          status,
          extractionJobs,
          activeTasks,
          candidateRecords,
          skillCandidateRecords,
          experts,
        ] = await Promise.all([
          view === "extractions" ||
          view === "taskDetails" ||
          view === "candidates" ||
          view === "skillCandidates"
            ? Promise.resolve([])
            : window.pragmaDesktop.listMemoryItems({
                module: view === "health" ? "all" : view,
                status: "all",
                query,
                limit: 200,
              }),
          window.pragmaDesktop.getMemoryPlaneStatus(),
          view === "extractions"
            ? window.pragmaDesktop.listMemoryExtractionJobs({ pages: extractionPages })
            : Promise.resolve(undefined),
          view === "taskDetails"
            ? window.pragmaDesktop.listActiveMemoryExtractionTasks()
            : Promise.resolve([]),
          view === "candidates"
            ? window.pragmaDesktop.listMemoryKnowledgeInitializations({ state: "pending_review" })
            : Promise.resolve([]),
          view === "skillCandidates"
            ? window.pragmaDesktop.listMemorySkillCandidates()
            : Promise.resolve([]),
          view === "candidates" || view === "skillCandidates"
            ? window.pragmaDesktop.listExperts()
            : Promise.resolve([]),
        ]);
        setItems(records);
        setHealth(status);
        if (extractionJobs !== undefined && requestVersion === extractionRequestVersion.current) {
          setExtractionBoard(extractionJobs);
          const resetLanes = MEMORY_EXTRACTION_LANES.filter(
            (lane) => extractionJobs.lanes[lane].pageIndex !== extractionPages[lane].pageIndex,
          );
          if (resetLanes.length > 0) {
            setExtractionPages((current) => {
              const next = { ...current };
              for (const lane of resetLanes) next[lane] = { pageIndex: 0 };
              return next;
            });
            setExtractionPageCursors((current) => {
              const next = { ...current };
              for (const lane of resetLanes) next[lane] = [undefined];
              return next;
            });
          }
        }
        if (view === "taskDetails" && requestVersion === extractionRequestVersion.current) {
          setActiveExtractionTasks(activeTasks);
        }
        setCandidates(candidateRecords);
        setSkillCandidates(skillCandidateRecords);
        if (view === "candidates" || view === "skillCandidates") {
          setExpertNames(Object.fromEntries(experts.map((expert) => [expert.ref, expert.name])));
        }
        const selectableIds =
          view === "candidates"
            ? candidateRecords.map((candidate) => candidate.id)
            : view === "skillCandidates"
              ? skillCandidateRecords.map((candidate) => candidate.id)
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
      } catch {
        setError(t("loadError"));
        return undefined;
      } finally {
        hasLoaded.current = true;
        setLoading(false);
      }
    },
    [extractionPages, query, t, view],
  );

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 120);
    return () => clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    if (view !== "extractions" && view !== "taskDetails") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const board = await reload(true);
      if (!cancelled) {
        timer = setTimeout(
          () => void poll(),
          view === "taskDetails" ? 2_000 : memoryExtractionPollDelay(board),
        );
      }
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [reload, view]);

  useEffect(() => {
    if (view !== "skillCandidates") return;
    const timer = setInterval(() => void reload(true), 2_000);
    return () => clearInterval(timer);
  }, [reload, view]);

  const selected = useMemo(
    () => items.find((item) => key(item) === selectedId),
    [items, selectedId],
  );

  const run = async (
    operation: () => Promise<unknown>,
    action: MemoryActionKind = "memory-governance",
  ) => {
    if (!canRunMemoryAction(action, reason)) return false;
    setActionBusy(true);
    try {
      await operation();
      setReason("");
      setEvidence(undefined);
      await reload();
      return true;
    } catch {
      setError(t("actionError"));
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
    } catch {
      setError(t("extractionActionError"));
    } finally {
      setBusyExtractionTask(undefined);
    }
  };

  const changeExtractionPage = (lane: MemoryExtractionLane, pageIndex: number) => {
    const currentPage = extractionPages[lane].pageIndex;
    const cursor =
      pageIndex === currentPage + 1
        ? extractionBoard?.lanes[lane].nextCursor
        : extractionPageCursors[lane][pageIndex];
    if (pageIndex > 0 && cursor === undefined) return;
    extractionRequestVersion.current += 1;
    setExtractionPageCursors((current) => {
      const laneCursors = [...current[lane]];
      laneCursors[pageIndex] = cursor;
      return { ...current, [lane]: laneCursors };
    });
    setExtractionPages((current) => ({
      ...current,
      [lane]: pageIndex === 0 ? { pageIndex } : { pageIndex, cursor: cursor! },
    }));
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
            "candidates",
            "skillCandidates",
            "extractions",
            "health",
            "taskDetails",
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
      <MemoryDegradedAlert health={health} onViewTasks={() => setView("extractions")} />

      {view === "health" ? (
        <MemoryHealth health={health} />
      ) : view === "taskDetails" ? (
        <MemoryExtractionTaskDetails tasks={activeExtractionTasks} />
      ) : view === "extractions" ? (
        <MemoryExtractionJobs
          board={extractionBoard}
          loading={loading && extractionBoard === undefined}
          busyTask={busyExtractionTask}
          onRefresh={() => void reload(true)}
          onAction={manageExtraction}
          onPageChange={changeExtractionPage}
          onConfigureExtraction={props.onConfigureExtraction}
          onReviewCandidates={(module) =>
            setView(module === "skill" ? "skillCandidates" : "candidates")
          }
        />
      ) : view === "skillCandidates" ? (
        <MemorySkillCandidates
          candidates={skillCandidates}
          expertNames={expertNames}
          selectedId={selectedId}
          busy={actionBusy}
          onSelect={setSelectedId}
          onChange={setSkillCandidates}
          onAction={async (operation) => await run(operation, "knowledge-initialization")}
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
                }}
              >
                <span>{t("candidates")}</span>
                <strong>{candidate.name}</strong>
                <small
                  className="memory-candidate-expert"
                  title={formatMemoryCandidateExpert(candidate.expertRef, expertNames)}
                >
                  {formatMemoryCandidateExpert(candidate.expertRef, expertNames)}
                </small>
                <small>{t("revision", { revision: candidate.revision })}</small>
              </button>
            ))}
          </aside>
          <main className="memory-detail">
            {(() => {
              const candidate = candidates.find((item) => item.id === selectedId);
              if (candidate === undefined) return <p>{t("selectCandidate")}</p>;
              return (
                <>
                  <header className="memory-candidate-header">
                    <div className="memory-candidate-meta">
                      <span className="memory-status is-pending_review">pending_review</span>
                      <small title={formatMemoryCandidateExpert(candidate.expertRef, expertNames)}>
                        {formatMemoryCandidateExpert(candidate.expertRef, expertNames)}
                      </small>
                    </div>
                    <label className="memory-candidate-field is-name">
                      <span>{t("candidateName")}</span>
                      <input
                        value={candidate.name}
                        maxLength={50}
                        onChange={(event) =>
                          setCandidates((current) =>
                            current.map((item) =>
                              item.id === candidate.id
                                ? { ...item, name: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="memory-candidate-field">
                      <span>{t("candidateDescription")}</span>
                      <textarea
                        value={candidate.description}
                        maxLength={500}
                        onChange={(event) =>
                          setCandidates((current) =>
                            current.map((item) =>
                              item.id === candidate.id
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                  </header>
                  <section className="memory-candidate-files">
                    <h3>{t("initializationFiles")}</h3>
                    <p className="memory-note">{t("initializationFilesDescription")}</p>
                    {candidate.files.map((file) => (
                      <details className="memory-candidate-file" key={file.id}>
                        <summary>
                          <span>{file.id}</span>
                          <small>{file.metadata.trigger}</small>
                        </summary>
                        <textarea
                          aria-label={file.id}
                          value={file.content}
                          onChange={(event) =>
                            setCandidates((current) =>
                              current.map((item) =>
                                item.id !== candidate.id
                                  ? item
                                  : {
                                      ...item,
                                      files: item.files.map((entry) =>
                                        entry.id === file.id
                                          ? { ...entry, content: event.target.value }
                                          : entry,
                                      ),
                                    },
                              ),
                            )
                          }
                        />
                      </details>
                    ))}
                  </section>
                  <div className="memory-actions memory-candidate-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={actionBusy}
                      onClick={() =>
                        void run(
                          async () =>
                            window.pragmaDesktop.updateMemoryKnowledgeInitialization({
                              id: candidate.id,
                              expectedRevision: candidate.revision,
                              name: candidate.name,
                              description: candidate.description,
                              files: [...candidate.files],
                            }),
                          "knowledge-initialization",
                        )
                      }
                    >
                      {t("saveCandidate")}
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={actionBusy}
                      onClick={() =>
                        void run(
                          async () =>
                            await window.pragmaDesktop.createMemoryKnowledgeStore({
                              id: candidate.id,
                              expectedRevision: candidate.revision,
                            }),
                          "knowledge-initialization",
                        )
                      }
                    >
                      {t("createKnowledgeStore")}
                    </button>
                    <button
                      className="danger-button is-danger"
                      type="button"
                      disabled={actionBusy}
                      onClick={() =>
                        void run(
                          async () =>
                            await window.pragmaDesktop.rejectMemoryKnowledgeInitialization({
                              id: candidate.id,
                              expectedRevision: candidate.revision,
                            }),
                          "knowledge-initialization",
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
                            .catch(() => {
                              setError(t("loadEvidenceError"));
                            })
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
                      reason.trim() === "" || actionBusy || selected.status === "invalidated"
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
                    {t("invalidate")}
                  </button>
                  <button
                    className="is-danger"
                    type="button"
                    disabled={reason.trim() === "" || actionBusy}
                    onClick={() => setDialog("forget")}
                  >
                    <Trash size={17} aria-hidden="true" /> {t("forget")}
                  </button>
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

export type MemoryActionKind = "memory-governance" | "knowledge-initialization";

export function canRunMemoryAction(action: MemoryActionKind, reason: string): boolean {
  return action === "knowledge-initialization" || reason.trim() !== "";
}

export function memoryExtractionPollDelay(board: DesktopMemoryExtractionBoard | undefined): number {
  return board !== undefined &&
    (board.lanes.waiting.totalTasks > 0 || board.lanes.running.totalTasks > 0)
    ? 2_000
    : 10_000;
}

const EMPTY_MEMORY_EXTRACTION_LANE = {
  tasks: [] as readonly DesktopMemoryExtractionTask[],
  pageIndex: 0,
  pageCount: 1,
  totalTasks: 0,
};

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
  readonly onPageChange: (lane: MemoryExtractionLane, pageIndex: number) => void;
  readonly onConfigureExtraction?: (() => void) | undefined;
  readonly onReviewCandidates?:
    ((module: DesktopMemoryExtractionTask["module"]) => void) | undefined;
}) {
  const { t } = useTranslation("memory");
  const [pendingDelete, setPendingDelete] = useState<DesktopMemoryExtractionTask>();
  const laneItemRefs = useRef<Partial<Record<MemoryExtractionLane, HTMLDivElement>>>({});

  const changeLanePage = (lane: MemoryExtractionLane, pageIndex: number) => {
    props.onPageChange(lane, pageIndex);
    laneItemRefs.current[lane]?.scrollTo({ top: 0 });
  };

  return (
    <section className="memory-health memory-extraction-jobs">
      <header className="memory-extraction-jobs-header">
        <p>{t("extractionsDescription")}</p>
        <button
          className="memory-extraction-refresh"
          type="button"
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          <ArrowClockwise size={17} aria-hidden="true" /> {t("refresh")}
        </button>
      </header>
      {props.loading ? <p>{t("loading")}</p> : null}
      {!props.loading ? (
        <div className="memory-extraction-board">
          {MEMORY_EXTRACTION_LANES.map((lane) => {
            const page = props.board?.lanes[lane] ?? EMPTY_MEMORY_EXTRACTION_LANE;
            return (
              <section className={`memory-extraction-lane is-${lane}`} key={lane}>
                <header>
                  <h3>{t(`extractionLanes.${lane}`)}</h3>
                  <span>{page.totalTasks}</span>
                </header>
                <div
                  className="memory-extraction-lane-items"
                  ref={(element) => {
                    if (element === null) delete laneItemRefs.current[lane];
                    else laneItemRefs.current[lane] = element;
                  }}
                >
                  {page.totalTasks === 0 ? (
                    <p className="memory-extraction-lane-empty">{t("emptyExtractionLane")}</p>
                  ) : null}
                  {page.tasks.map((task) => {
                    const taskKey = `${task.module}:${task.id}`;
                    const busy = props.busyTask === taskKey;
                    const problem = task.problem;
                    return (
                      <article className="memory-extraction-task" key={taskKey}>
                        <strong>
                          {task.title ??
                            t(task.module === "knowledge" ? "unknownAsset" : "unknownMission")}
                        </strong>
                        <div className="memory-extraction-task-statuses">
                          <span className={`memory-extraction-type is-${task.module}`}>
                            {t(`extractionTaskTypes.${task.module}`)}
                          </span>
                          {lane === "completed" && task.completion !== undefined ? (
                            <span className="memory-extraction-completion">
                              {t(`extractionCompletions.${task.completion}`)}
                            </span>
                          ) : null}
                        </div>
                        {lane === "attention" && problem !== undefined ? (
                          <section className={`memory-extraction-problem is-${problem.kind}`}>
                            <strong>{t(`extractionProblems.${problem.kind}.title`)}</strong>
                            <p>{t(`extractionProblems.${problem.kind}.description`)}</p>
                            <MemoryTechnicalDetails
                              code={problem.technicalCode}
                              module={task.module}
                              updatedAt={task.updatedAt}
                            />
                          </section>
                        ) : null}
                        {lane !== "completed" ? (
                          <footer>
                            {lane === "waiting" ? (
                              <button
                                className="is-primary"
                                type="button"
                                disabled={busy}
                                onClick={() => void props.onAction(task, "expedite")}
                              >
                                <Play size={16} aria-hidden="true" /> {t("extractNow")}
                              </button>
                            ) : null}
                            {lane === "attention" ? (
                              <>
                                {problem?.kind === "configuration" ? (
                                  <button
                                    className="is-primary"
                                    type="button"
                                    disabled={busy || props.onConfigureExtraction === undefined}
                                    onClick={props.onConfigureExtraction}
                                  >
                                    {t("configureExtraction")}
                                  </button>
                                ) : problem?.kind === "capacity" ? (
                                  <button
                                    className="is-primary"
                                    type="button"
                                    disabled={busy || props.onReviewCandidates === undefined}
                                    onClick={() => props.onReviewCandidates?.(task.module)}
                                  >
                                    {t("reviewCandidates")}
                                  </button>
                                ) : problem?.kind === "dependency" ? (
                                  <button
                                    className="is-primary"
                                    type="button"
                                    disabled={busy}
                                    onClick={props.onRefresh}
                                  >
                                    <ArrowClockwise size={16} aria-hidden="true" /> {t("refresh")}
                                  </button>
                                ) : (
                                  <button
                                    className="is-primary"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void props.onAction(task, "retry")}
                                  >
                                    <ArrowCounterClockwise size={16} aria-hidden="true" />
                                    {t("retryExtraction")}
                                  </button>
                                )}
                                {problem?.kind === "configuration" ||
                                problem?.kind === "capacity" ? (
                                  <button
                                    className="is-secondary"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void props.onAction(task, "retry")}
                                  >
                                    <ArrowCounterClockwise size={16} aria-hidden="true" />
                                    {t("retryExtraction")}
                                  </button>
                                ) : null}
                                {problem?.kind === "invalid_output" &&
                                props.onConfigureExtraction !== undefined ? (
                                  <button
                                    className="is-secondary"
                                    type="button"
                                    disabled={busy}
                                    onClick={props.onConfigureExtraction}
                                  >
                                    {t("configureExtraction")}
                                  </button>
                                ) : null}
                                <button
                                  className="is-danger"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setPendingDelete(task)}
                                >
                                  <Trash size={16} aria-hidden="true" /> {t("abandonExtraction")}
                                </button>
                              </>
                            ) : null}
                            {lane === "running" ? (
                              <button
                                className="is-secondary"
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
                {page.pageCount > 1 ? (
                  <nav
                    className="memory-extraction-pagination"
                    aria-label={t("extractionPagination", {
                      lane: t(`extractionLanes.${lane}`),
                    })}
                  >
                    <button
                      type="button"
                      disabled={page.pageIndex === 0}
                      onClick={() => changeLanePage(lane, page.pageIndex - 1)}
                    >
                      {t("previousPage")}
                    </button>
                    <span>
                      {t("pageStatus", {
                        page: page.pageIndex + 1,
                        total: page.pageCount,
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={page.pageIndex === page.pageCount - 1}
                      onClick={() => changeLanePage(lane, page.pageIndex + 1)}
                    >
                      {t("nextPage")}
                    </button>
                  </nav>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
      {pendingDelete === undefined ? null : (
        <ConfirmationDialog
          title={t("abandonExtractionTitle")}
          description={t("abandonExtractionDescription", {
            title:
              pendingDelete.title ??
              t(pendingDelete.module === "knowledge" ? "unknownAsset" : "unknownMission"),
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("abandonExtraction")}
          busyLabel={t("abandoningExtraction")}
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

function MemoryTechnicalDetails(props: {
  readonly code: string;
  readonly module: string;
  readonly updatedAt?: string | undefined;
}) {
  const { t } = useTranslation("memory");
  const diagnostic = [
    `module=${props.module}`,
    `code=${props.code}`,
    ...(props.updatedAt === undefined ? [] : [`updatedAt=${props.updatedAt}`]),
  ].join("\n");
  return (
    <details className="memory-technical-details">
      <summary>{t("technicalDetails")}</summary>
      <code>{props.code}</code>
      <button type="button" onClick={() => void window.navigator.clipboard.writeText(diagnostic)}>
        {t("copyDiagnostics")}
      </button>
    </details>
  );
}

function MemoryExtractionTaskDetails(props: {
  readonly tasks: readonly DesktopMemoryExtractionTask[];
}) {
  const { t } = useTranslation("memory");
  const tasks = props.tasks;
  const [selectedKey, setSelectedKey] = useState<string>();
  const [detail, setDetail] = useState<DesktopMemoryExtractionTaskDetail>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [chat, setChat] = useState<MissionChatSnapshot>();
  const [loadError, setLoadError] = useState(false);
  const detailRequestVersion = useRef(0);
  const detailLoadingKey = useRef<string | undefined>(undefined);
  const selected = tasks.find((task) => `${task.module}:${task.id}` === selectedKey) ?? tasks[0];

  useEffect(() => {
    if (selected === undefined) {
      setSelectedKey(undefined);
      setDetail(undefined);
      setChat(undefined);
      return;
    }
    setSelectedKey(`${selected.module}:${selected.id}`);
  }, [selected?.id, selected?.module]);

  const loadDetail = useCallback(async () => {
    if (selected === undefined) return;
    const taskKey = `${selected.module}:${selected.id}`;
    if (detailLoadingKey.current === taskKey) return;
    detailLoadingKey.current = taskKey;
    const requestVersion = (detailRequestVersion.current += 1);
    try {
      const next = await window.pragmaDesktop.getMemoryExtractionTaskDetail({
        module: selected.module,
        id: selected.id,
      });
      if (requestVersion !== detailRequestVersion.current) return;
      setDetail(next);
      setSelectedRunId((current) =>
        current !== undefined && next.runs.some((run) => run.runId === current)
          ? current
          : next.runs[0]?.runId,
      );
      setLoadError(false);
    } catch {
      if (requestVersion === detailRequestVersion.current) setLoadError(true);
    } finally {
      if (detailLoadingKey.current === taskKey) detailLoadingKey.current = undefined;
    }
  }, [selected?.id, selected?.module]);

  useEffect(() => {
    void loadDetail();
    const timer = setInterval(() => void loadDetail(), 2_000);
    return () => {
      detailRequestVersion.current += 1;
      detailLoadingKey.current = undefined;
      clearInterval(timer);
    };
  }, [loadDetail]);

  const loadChat = useCallback(async () => {
    if (selectedRunId === undefined) {
      setChat(undefined);
      return;
    }
    try {
      setChat(await window.pragmaDesktop.getMemoryExtractionRunChat({ runId: selectedRunId }));
    } catch {
      setChat(detail?.runs.find((run) => run.runId === selectedRunId)?.chat);
    }
  }, [detail?.runs, selectedRunId]);

  useEffect(() => {
    void loadChat();
  }, [loadChat]);

  useEffect(
    () =>
      window.pragmaDesktop.subscribeMemoryExtractionRunChat((event) => {
        if (event.runId !== selectedRunId) return;
        if (event.update.kind === "invalidate") {
          void loadChat();
          return;
        }
        const update = event.update;
        setChat((current) => {
          if (current === undefined || current.missionId !== update.missionId) return current;
          if (update.revision <= current.revision) return current;
          return applyMissionChatPatches(current, update.patches, update.revision) ?? current;
        });
      }),
    [loadChat, selectedRunId],
  );

  const selectedRun = detail?.runs.find((run) => run.runId === selectedRunId);
  return (
    <section className="memory-task-details" aria-label={t("taskDetails")}>
      <aside className="memory-task-details-list">
        <header>
          <h2>{t("taskDetails")}</h2>
          <p>{t("taskDetailsDescription")}</p>
        </header>
        {tasks.length === 0 ? <p className="memory-note">{t("noActiveExtractionTasks")}</p> : null}
        {tasks.map((task) => {
          const taskKey = `${task.module}:${task.id}`;
          return (
            <button
              type="button"
              key={taskKey}
              className={
                taskKey === `${selected?.module}:${selected?.id}`
                  ? "memory-task-detail-item is-active"
                  : "memory-task-detail-item"
              }
              onClick={() => setSelectedKey(taskKey)}
            >
              <span>{t(`extractionTaskTypes.${task.module}`)}</span>
              <strong>{task.title ?? task.id}</strong>
              <small>{t(`extractionLanes.${task.lane}`)}</small>
              <small>{new Date(task.updatedAt).toLocaleString()}</small>
            </button>
          );
        })}
      </aside>
      <main className="memory-task-details-stream">
        {selected === undefined ? (
          <p>{t("selectExtractionTask")}</p>
        ) : loadError ? (
          <p className="memory-error" role="alert">
            {t("taskDetailsLoadError")}
          </p>
        ) : detail === undefined ? (
          <p>{t("loading")}</p>
        ) : (
          <>
            <header className="memory-task-details-header">
              <div>
                <span className={`memory-extraction-type is-${detail.task.module}`}>
                  {t(`extractionTaskTypes.${detail.task.module}`)}
                </span>
                <h2>{detail.task.title ?? detail.task.id}</h2>
                <p>{t("readOnlyTaskMessages")}</p>
              </div>
              {detail.runs.length > 1 ? (
                <div className="memory-task-run-select">
                  <span>{t("extractionAttempt")}</span>
                  <SelectMenu
                    ariaLabel={t("extractionAttempt")}
                    className="form-select"
                    value={selectedRunId ?? detail.runs[0]!.runId}
                    onChange={setSelectedRunId}
                    options={detail.runs.map((run, index) => ({
                      value: run.runId,
                      label: t("extractionAttemptOption", {
                        attempt: detail.runs.length - index,
                        status: run.status,
                      }),
                    }))}
                  />
                </div>
              ) : null}
            </header>
            {detail.lastFailure === undefined ? null : (
              <section className="memory-task-failure" role="status">
                <strong>{detail.lastFailure.code}</strong>
                <p>{detail.lastFailure.message}</p>
                <dl>
                  <dt>{t("failurePhase")}</dt>
                  <dd>{detail.lastFailure.phase}</dd>
                  <dt>HTTP</dt>
                  <dd>{detail.lastFailure.transport?.httpStatus ?? "—"}</dd>
                  <dt>{t("duration")}</dt>
                  <dd>
                    {detail.lastFailure.durationMs === undefined
                      ? "—"
                      : `${detail.lastFailure.durationMs} ms`}
                  </dd>
                  <dt>{t("runtimeTarget")}</dt>
                  <dd>
                    {[detail.lastFailure.runtime?.runtimeId, detail.lastFailure.runtime?.modelId]
                      .filter(Boolean)
                      .join(" / ") || "—"}
                  </dd>
                </dl>
              </section>
            )}
            <section className="memory-task-message-stream" aria-live="polite">
              {selectedRun === undefined ? (
                <p className="memory-note">{t("noExtractionMessages")}</p>
              ) : chat === undefined ? (
                <p>{t("loadingMessages")}</p>
              ) : chat.entries.length === 0 ? (
                <p className="memory-note">{t("noExtractionMessages")}</p>
              ) : (
                chat.entries.map((entry) => (
                  <MissionChatEntryView
                    entry={entry}
                    key={entry.id}
                    missionId={chat.missionId}
                    paintExecutionId={entry.executionId ?? chat.execution?.id}
                    showExecutorLabel
                  />
                ))
              )}
            </section>
          </>
        )}
      </main>
    </section>
  );
}

export function MemoryHealth(props: { readonly health?: DesktopMemoryPlaneStatus | undefined }) {
  const { t } = useTranslation("memory");
  if (props.health === undefined) return <p>{t("loading")}</p>;
  const targetBytes = props.health.storagePolicy?.canonicalFeedTargetBytes ?? 512 * 1_024 * 1_024;
  const usagePercent = Math.min(
    100,
    targetBytes === 0 ? 0 : (props.health.feed.logicalBytes / targetBytes) * 100,
  );
  const HealthIcon =
    props.health.state === "running"
      ? CheckCircle
      : props.health.state === "stopped"
        ? StopCircle
        : WarningCircle;
  const globalProblem =
    props.health.lastError === undefined
      ? undefined
      : classifyDesktopMemoryProblem(props.health.lastError.code);
  return (
    <section className={`memory-health is-${props.health.state}`} aria-label={t("health")}>
      <header className="memory-health-overview">
        <div className="memory-health-overview-state" role="status">
          <span className="memory-health-overview-icon" aria-hidden="true">
            <HealthIcon size={25} weight="bold" />
          </span>
          <div>
            <strong>{t(`healthStates.${props.health.state}`)}</strong>
            <span>
              {t("healthOverviewDescription", {
                modules: props.health.modules.length,
              })}
            </span>
            {globalProblem === undefined ? null : (
              <span className="memory-module-problem">
                <small>{t(`extractionProblems.${globalProblem.kind}.title`)}</small>
                <MemoryTechnicalDetails
                  code={globalProblem.technicalCode}
                  module="memory-plane"
                  updatedAt={props.health.lastError?.occurredAt}
                />
              </span>
            )}
          </div>
        </div>
        <dl className="memory-health-overview-metrics">
          <div>
            <Cube size={23} aria-hidden="true" />
            <dt>{t("healthMetrics.modules")}</dt>
            <dd>{props.health.modules.length}</dd>
          </div>
          <div>
            <FileText size={23} aria-hidden="true" />
            <dt>{t("healthMetrics.events")}</dt>
            <dd>{props.health.feed.eventCount}</dd>
          </div>
          <div>
            <ShieldCheck size={23} aria-hidden="true" />
            <dt>{t("healthMetrics.blocked")}</dt>
            <dd>{formatHealthBytes(props.health.feed.blockedBytes)}</dd>
          </div>
        </dl>
      </header>

      <div className="memory-health-details">
        <section className="memory-health-feed" aria-labelledby="memory-health-feed-title">
          <h3 id="memory-health-feed-title">{t("feedStorage")}</h3>
          <div className="memory-health-capacity">
            <span>{t("feedUsage")}</span>
            <strong>
              {formatHealthBytes(props.health.feed.logicalBytes)}
              <small> / {formatHealthBytes(targetBytes)}</small>
            </strong>
            <span>{formatHealthPercent(usagePercent)}</span>
            <progress max={100} value={usagePercent} aria-label={t("feedUsage")} />
            <small>{t("feedCapacity", { capacity: formatHealthBytes(targetBytes) })}</small>
          </div>
          <dl className="memory-health-feed-metrics">
            <div>
              <ShieldCheck size={24} aria-hidden="true" />
              <dt>{t("safeThrough")}</dt>
              <dd>{props.health.feed.safeThroughSequence}</dd>
            </div>
            <div>
              <Database size={24} aria-hidden="true" />
              <dt>{t("durableBlocked")}</dt>
              <dd>{formatHealthBytes(props.health.feed.blockedBytes)}</dd>
            </div>
          </dl>
        </section>

        <section className="memory-health-modules" aria-labelledby="memory-health-modules-title">
          <h3 id="memory-health-modules-title">{t("moduleStatus")}</h3>
          <div className="memory-health-module-table-wrap">
            <table className="memory-health-module-table">
              <thead>
                <tr>
                  <th>{t("moduleTable.module")}</th>
                  <th>{t("moduleTable.status")}</th>
                  <th>{t("moduleTable.lag")}</th>
                  <th>{t("moduleTable.records")}</th>
                  <th>{t("moduleTable.extracting")}</th>
                  <th>{t("moduleTable.attention")}</th>
                  <th>{t("moduleTable.rejected")}</th>
                </tr>
              </thead>
              <tbody>
                {props.health.modules.map((module) => {
                  const nameKey = memoryModuleNameKey(module.moduleId);
                  const problem =
                    module.lastErrorCode === undefined
                      ? undefined
                      : classifyDesktopMemoryProblem(module.lastErrorCode);
                  return (
                    <tr key={module.moduleId}>
                      <th scope="row">
                        <span className="memory-health-module-icon" aria-hidden="true">
                          <Cube size={19} />
                        </span>
                        <span>
                          <strong>
                            {nameKey === undefined ? module.moduleId : t(`moduleNames.${nameKey}`)}
                          </strong>
                          <small>
                            {module.moduleId}@{module.moduleVersion}
                          </small>
                          {problem === undefined ? null : (
                            <span className="memory-module-problem">
                              <small>{t(`extractionProblems.${problem.kind}.title`)}</small>
                              <MemoryTechnicalDetails
                                code={problem.technicalCode}
                                module={module.moduleId}
                              />
                            </span>
                          )}
                        </span>
                      </th>
                      <td>
                        <span className={`memory-health-status is-${module.status}`}>
                          {module.status === "healthy" ? (
                            <CheckCircle size={15} weight="fill" aria-hidden="true" />
                          ) : (
                            <WarningCircle size={15} weight="fill" aria-hidden="true" />
                          )}
                          {t(`moduleStatuses.${module.status}`)}
                        </span>
                      </td>
                      <td>{module.lag}</td>
                      <td>{module.work?.records ?? 0}</td>
                      <td>{(module.work?.pending ?? 0) + (module.work?.running ?? 0)}</td>
                      <td>{module.work?.needsAttention ?? 0}</td>
                      <td className="is-historical">{module.work?.rejected ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}

function formatHealthBytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function MemorySkillCandidates(props: {
  readonly candidates: readonly MemorySkillCandidate[];
  readonly expertNames: Readonly<Record<string, string>>;
  readonly selectedId?: string | undefined;
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onChange: (candidates: readonly MemorySkillCandidate[]) => void;
  readonly onAction: (operation: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation("memory");
  const candidate = props.candidates.find((item) => item.id === props.selectedId);
  const replace = (next: MemorySkillCandidate) =>
    props.onChange(props.candidates.map((item) => (item.id === next.id ? next : item)));
  const runAndReplace = async (operation: () => Promise<MemorySkillCandidate>) => {
    let next: MemorySkillCandidate | undefined;
    const ok = await props.onAction(async () => {
      next = await operation();
    });
    if (ok && next !== undefined) replace(next);
  };
  const patchPackage = (change: Partial<MemorySkillCandidate["package"]>) => {
    if (candidate === undefined) return;
    replace({ ...candidate, package: { ...candidate.package, ...change } });
  };
  return (
    <div className="memory-browser">
      <aside className="memory-list">
        {props.candidates.length === 0 ? <p>{t("noSkillCandidates")}</p> : null}
        {props.candidates.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              props.selectedId === item.id ? "memory-list-item is-active" : "memory-list-item"
            }
            onClick={() => props.onSelect(item.id)}
          >
            <span>{t("skillCandidate")}</span>
            <strong>{item.package.name}</strong>
            <small
              className="memory-candidate-expert"
              title={formatMemoryCandidateExpert(item.expertRef, props.expertNames)}
            >
              {formatMemoryCandidateExpert(item.expertRef, props.expertNames)}
            </small>
            <small>
              {item.state} · {t("revision", { revision: item.revision })}
            </small>
          </button>
        ))}
      </aside>
      <main className="memory-detail">
        {candidate === undefined ? (
          <p>{t("selectSkillCandidate")}</p>
        ) : (
          <>
            <header className="memory-candidate-header">
              <div className="memory-candidate-meta">
                <span className={`memory-status is-${candidate.state}`}>{candidate.state}</span>
                <small title={formatMemoryCandidateExpert(candidate.expertRef, props.expertNames)}>
                  {formatMemoryCandidateExpert(candidate.expertRef, props.expertNames)}
                </small>
              </div>
              <label className="memory-candidate-field is-name">
                <span>{t("skillName")}</span>
                <input
                  value={candidate.package.name}
                  maxLength={120}
                  onChange={(event) => patchPackage({ name: event.target.value })}
                />
              </label>
              <label className="memory-candidate-field">
                <span>{t("skillDescription")}</span>
                <textarea
                  value={candidate.package.description}
                  maxLength={500}
                  onChange={(event) => patchPackage({ description: event.target.value })}
                />
              </label>
            </header>
            {candidate.state === "needs_target" ? (
              <section>
                <h3>{t("chooseSkillTarget")}</h3>
                <p className="memory-note">{t("chooseSkillTargetDescription")}</p>
                <div className="memory-actions memory-candidate-actions">
                  {candidate.route.type === "needs_target"
                    ? candidate.route.options.map((option) => (
                        <button
                          key={option.bindingId}
                          className="secondary-button"
                          type="button"
                          disabled={props.busy}
                          onClick={() =>
                            void runAndReplace(
                              async () =>
                                await window.pragmaDesktop.resolveMemorySkillTarget({
                                  id: candidate.id,
                                  expectedRevision: candidate.revision,
                                  target: { type: "revise", bindingId: option.bindingId },
                                }),
                            )
                          }
                        >
                          {t("reviseExistingSkill", { name: option.name })}
                        </button>
                      ))
                    : null}
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={() =>
                      void runAndReplace(
                        async () =>
                          await window.pragmaDesktop.resolveMemorySkillTarget({
                            id: candidate.id,
                            expectedRevision: candidate.revision,
                            target: { type: "create" },
                          }),
                      )
                    }
                  >
                    {t("createNewSkill")}
                  </button>
                </div>
              </section>
            ) : (
              <section className="memory-candidate-files">
                <h3>{t("skillPackageFiles")}</h3>
                {candidate.package.files.map((file) => (
                  <details
                    className="memory-candidate-file"
                    key={file.path}
                    open={file.path === "SKILL.md"}
                  >
                    <summary>
                      <span>{file.path}</span>
                    </summary>
                    <textarea
                      value={file.content}
                      aria-label={file.path}
                      onChange={(event) =>
                        patchPackage({
                          files: candidate.package.files.map((entry) =>
                            entry.path === file.path
                              ? { ...entry, content: event.target.value }
                              : entry,
                          ),
                        })
                      }
                    />
                  </details>
                ))}
              </section>
            )}
            {candidate.evaluation === undefined ? null : (
              <section>
                <h3>{t("skillEvaluation")}</h3>
                <p className="memory-note">
                  {t(
                    candidate.evaluation.passed ? "skillEvaluationPassed" : "skillEvaluationFailed",
                  )}
                </p>
                {candidate.evaluation.cases.map((testCase) => (
                  <details className="memory-candidate-file" key={testCase.id}>
                    <summary>
                      <span>
                        {testCase.kind}: {testCase.id}
                      </span>
                      <small>{testCase.passed ? t("passed") : t("failed")}</small>
                    </summary>
                    <ul>
                      {testCase.assertions.map((assertion, index) => (
                        <li key={`${assertion.dimension}:${index}`}>
                          {assertion.dimension}: {assertion.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </section>
            )}
            <div className="memory-actions memory-candidate-actions">
              {candidate.state === "pending_review" ? (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={() =>
                      void runAndReplace(
                        async () =>
                          await window.pragmaDesktop.updateMemorySkillCandidate({
                            id: candidate.id,
                            expectedRevision: candidate.revision,
                            package: candidate.package,
                          }),
                      )
                    }
                  >
                    {t("saveAndReevaluate")}
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={() =>
                      void runAndReplace(
                        async () =>
                          await window.pragmaDesktop.approveMemorySkillCandidate({
                            id: candidate.id,
                            expectedRevision: candidate.revision,
                          }),
                      )
                    }
                  >
                    {t("approveSkill")}
                  </button>
                </>
              ) : null}
              {candidate.state === "needs_attention" ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={props.busy}
                  onClick={() =>
                    void runAndReplace(
                      async () =>
                        await window.pragmaDesktop.retryMemorySkillCandidate({
                          id: candidate.id,
                          expectedRevision: candidate.revision,
                        }),
                    )
                  }
                >
                  {t("retrySkillEvaluation")}
                </button>
              ) : null}
              {["pending_review", "needs_attention", "needs_target"].includes(candidate.state) ? (
                <button
                  className="danger-button is-danger"
                  type="button"
                  disabled={props.busy}
                  onClick={() =>
                    void runAndReplace(
                      async () =>
                        await window.pragmaDesktop.rejectMemorySkillCandidate({
                          id: candidate.id,
                          expectedRevision: candidate.revision,
                        }),
                    )
                  }
                >
                  {t("reject")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function formatHealthPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function memoryModuleNameKey(
  moduleId: string,
): "episodic" | "knowledgeLearning" | "semantic" | "skillLearning" | undefined {
  if (moduleId === "pragma.memory.episodic") return "episodic";
  if (moduleId === "pragma.memory.knowledge-learning") return "knowledgeLearning";
  if (moduleId === "pragma.memory.semantic") return "semantic";
  if (moduleId === "pragma.memory.skill-learning") return "skillLearning";
  return undefined;
}

export function MemoryDegradedAlert(props: {
  readonly health?: DesktopMemoryPlaneStatus | undefined;
  readonly onViewTasks?: (() => void) | undefined;
}) {
  const { t } = useTranslation("memory");
  const signature = memoryDegradedAlertSignature(props.health);
  const [dismissedSignature, setDismissedSignature] = useState<string>();
  if (props.health?.state !== "degraded") return null;
  if (dismissedSignature === signature) return null;
  const attention = props.health.modules.reduce(
    (total, module) => total + (module.work?.needsAttention ?? 0),
    0,
  );
  const extractionOnly =
    attention > 0 &&
    !props.health.modules.some((module) => module.status === "unavailable") &&
    !isNonExtractionPipelineError(props.health.lastError?.code);
  return (
    <div className="memory-error is-dismissible" role="alert">
      <WarningCircle size={20} aria-hidden="true" />
      <span className="memory-degraded-copy">
        <strong>{t(extractionOnly ? "extractionDegraded" : "memoryDegraded")}</strong>
        <br />
        {extractionOnly
          ? t("extractionDegradedDescription", { count: attention })
          : t("memoryDegradedDescription")}
      </span>
      {extractionOnly && props.onViewTasks !== undefined ? (
        <button className="memory-alert-action" type="button" onClick={props.onViewTasks}>
          {t("viewExtractionTasks")}
        </button>
      ) : null}
      <button
        className="memory-alert-close"
        type="button"
        aria-label={t("closeAlert")}
        title={t("closeAlert")}
        onClick={() => setDismissedSignature(signature)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function memoryDegradedAlertSignature(
  health: DesktopMemoryPlaneStatus | undefined,
): string | undefined {
  if (health?.state !== "degraded") return undefined;
  return JSON.stringify({
    state: health.state,
    lastError: health.lastError?.code,
    modules: health.modules.map((module) => ({
      id: module.moduleId,
      status: module.status,
      attention: module.work?.needsAttention ?? 0,
      error: module.lastErrorCode,
    })),
  });
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

export function formatMemoryCandidateExpert(
  expertRef: string,
  names: Readonly<Record<string, string>>,
): string {
  const name = names[expertRef];
  if (name === undefined) return expertRef;
  return `${name} (${expertRef.replace(/^expert:/u, "")})`;
}
