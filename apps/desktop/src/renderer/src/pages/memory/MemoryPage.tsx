import { useCallback, useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, ShieldCheck, Trash, WarningCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  DesktopMemoryEvidence,
  DesktopMemoryItem,
  DesktopMemoryPlaneStatus,
} from "../../../../shared/contracts/index.ts";
import { ConfirmationDialog, Dialog } from "../../components/Dialog.tsx";
import { errorMessage } from "../../lib/errors.ts";

type MemoryView = "all" | "episodic" | "semantic" | "health";

export function MemoryPage() {
  const { t } = useTranslation("memory");
  const [view, setView] = useState<MemoryView>("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly DesktopMemoryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [health, setHealth] = useState<DesktopMemoryPlaneStatus>();
  const [evidence, setEvidence] = useState<DesktopMemoryEvidence>();
  const [reason, setReason] = useState("");
  const [dialog, setDialog] = useState<"revise" | "forget">();
  const [revisionDraft, setRevisionDraft] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [records, status] = await Promise.all([
        window.pragmaDesktop.listMemoryItems({
          module: view === "health" ? "all" : view,
          status: "all",
          query,
          limit: 200,
        }),
        window.pragmaDesktop.getMemoryPlaneStatus(),
      ]);
      setItems(records);
      setHealth(status);
      setSelectedId((current) =>
        current !== undefined && records.some((item) => key(item) === current)
          ? current
          : records[0] === undefined
            ? undefined
            : key(records[0]),
      );
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [query, view]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 120);
    return () => clearTimeout(timer);
  }, [reload]);

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
        {(["all", "episodic", "semantic", "health"] as const).map((id) => (
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

      {view === "health" ? (
        <MemoryHealth health={health} />
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
                <span>{item.module === "episodic" ? t("episodes") : t("facts")}</span>
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
                    <dd>{refs(selected.rootRefs)}</dd>
                    <dt>{t("producers")}</dt>
                    <dd>{refs(selected.producerRefs)}</dd>
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
                        {binding.consumerRef.type}:{binding.consumerRef.id}
                      </span>
                      <span>
                        {t("recall")} {binding.recall} · {t("export")} {binding.export} · p
                        {binding.permissionRevision}
                      </span>
                      {binding.recall === "allow" ? (
                        <button
                          type="button"
                          disabled={reason.trim() === "" || actionBusy}
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
                        >
                          {t("disableRecall")}
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {selected.visibility.mode === "restricted" ||
                  selected.rootRefs.length === 0 ? null : (
                    <button
                      type="button"
                      disabled={reason.trim() === "" || actionBusy}
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
                    >
                      {t("restrictVisibility")}
                    </button>
                  )}
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
      {props.health.modules.map((module) => (
        <article key={module.moduleId}>
          <strong>
            {module.moduleId}@{module.moduleVersion}
          </strong>
          <span>
            {module.status} · lag {module.lag} · records {module.work?.records ?? 0}
          </span>
        </article>
      ))}
    </section>
  );
}

function key(item: DesktopMemoryItem): string {
  return `${item.module}:${item.id}`;
}

function refs(values: readonly { readonly type: string; readonly id: string }[]): string {
  return values.map((value) => `${value.type}:${value.id}`).join(", ") || "—";
}
