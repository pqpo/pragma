import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Brain,
  CaretRight,
  Database,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type {
  DesktopMissionMemoryActivity,
  DesktopMissionMemoryAttentionContent,
  DesktopMissionMemoryRecallPage,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { memoryContextTitle } from "../../components/ContextStoreBrowser.tsx";
import {
  MemoryStoreBrowser,
  type ContextStoreBrowserSource,
} from "../../components/MemoryStoreBrowser.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";

type MemoryContentApi = Pick<
  PragmaDesktopAPI,
  "getMissionMemoryAttention" | "listMissionMemoryRecall"
>;
type Selection = NonNullable<DesktopMissionMemoryActivity["attention"]>[number]["entries"][number];
type AttentionItem = Selection & { contexts: Array<{ id: string; number: number }> };

function attentionItems(activity: DesktopMissionMemoryActivity | undefined): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  for (const [index, context] of (activity?.attention ?? []).entries()) {
    for (const entry of context.entries) {
      const key = `${entry.module}:${entry.memoryId}:${entry.revision}`;
      const prior = items.get(key);
      if (prior === undefined)
        items.set(key, { ...entry, contexts: [{ id: context.contextId, number: index + 1 }] });
      else prior.contexts.push({ id: context.contextId, number: index + 1 });
    }
  }
  return [...items.values()];
}

export function MissionMemoryActivity(props: {
  readonly activity?: DesktopMissionMemoryActivity | undefined;
  readonly error?: string | undefined;
  readonly loading: boolean;
  readonly onBrowseStore: () => void;
  readonly onRefresh?: (() => void) | undefined;
  readonly onBrowseSource?: ((path: string) => void) | undefined;
  readonly source?: ContextStoreBrowserSource | undefined;
  readonly api?: MemoryContentApi | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const [view, setView] = useState<string>("overview");
  const [selectedAttention, setSelectedAttention] = useState<AttentionItem>();
  const [sourcePath, setSourcePath] = useState<string>();
  const [visibleRounds, setVisibleRounds] = useState(10);
  const api = props.api ?? (typeof window === "undefined" ? undefined : window.pragmaDesktop);
  const items = attentionItems(props.activity);
  const executions = props.activity?.executions ?? [];
  const recallExecutions = executions.filter((execution) =>
    Object.values(execution.recall).some((count) => count > 0),
  );
  const selectedExecution = executions.find((execution) => execution.executionId === view);
  const totals = executions.reduce(
    (current, execution) => ({
      evidence: current.evidence + execution.capture.published,
      recall:
        current.recall + execution.recall.list + execution.recall.search + execution.recall.read,
      attention:
        current.attention +
        execution.capture.failed +
        execution.recall.denied +
        execution.recall.failed,
    }),
    { evidence: 0, recall: 0, attention: 0 },
  );
  totals.attention += (props.activity?.attention ?? []).filter(
    (context) => context.errorCode !== undefined,
  ).length;
  const openSource = (path: string) => {
    setSelectedAttention(undefined);
    if (path === "mission-attention.md") {
      setView("attention");
      return;
    }
    if (props.source === undefined) props.onBrowseSource?.(path);
    else setSourcePath(path);
  };
  const feedback = (
    <>
      {props.error !== undefined ? (
        <div className="mission-memory-message is-warning" role="alert">
          <p>
            {t("memoryActivityUnavailable")} · {props.error}
          </p>
          {props.onRefresh === undefined ? null : (
            <button className="text-button" type="button" onClick={props.onRefresh}>
              {t("actions.retry", { ns: "common" })}
            </button>
          )}
        </div>
      ) : null}
      {props.loading ? (
        <p className="mission-memory-message" role="status">
          <SpinnerGap size={16} className="spin" aria-hidden="true" />
          {t("memoryActivityLoading")}
        </p>
      ) : null}
    </>
  );
  const content =
    view === "attention" ? (
      <>
        <MemoryPageHeader
          title="Attention Memory"
          description={t("memoryAttentionContentDescription")}
          onBack={() => setView("overview")}
        />
        {feedback}
        {items.length === 0 && !props.loading && props.error === undefined ? (
          <p className="mission-memory-message">{t("memoryAttentionEmpty")}</p>
        ) : (
          <div className="mission-memory-content-list">
            {items.map((entry) => (
              <button
                type="button"
                className="mission-memory-content-row"
                key={`${entry.module}:${entry.memoryId}:${entry.revision}`}
                disabled={props.loading || props.error !== undefined}
                onClick={() => setSelectedAttention(entry)}
              >
                <span className="mission-memory-row-copy">
                  <span className="mission-memory-row-title">
                    {entry.title ?? t("memorySourceUnavailable")}
                  </span>
                  <span className="mission-memory-row-meta">
                    {t(entry.module === "semantic" ? "memorySemanticType" : "memoryEpisodicType")} ·{" "}
                    {t("memorySelectedByContexts", { count: entry.contexts.length })}
                  </span>
                </span>
                <CaretRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {(props.activity?.attention ?? [])
          .filter((context) => context.errorCode !== undefined)
          .map((context) => (
            <p key={context.contextId} className="mission-memory-message is-warning" role="status">
              <WarningCircle size={16} aria-hidden="true" />
              {t("memoryAttentionIssue")} <code>{context.errorCode}</code>
            </p>
          ))}
      </>
    ) : selectedExecution !== undefined && props.activity !== undefined ? (
      <MissionRecallContent
        key={selectedExecution.executionId}
        missionId={props.activity.missionId}
        executionId={selectedExecution.executionId}
        label={selectedExecution.label}
        number={executions.indexOf(selectedExecution) + 1}
        api={api}
        onBack={() => setView("overview")}
        onOpenSource={openSource}
      />
    ) : (
      <>
        <div className="mission-memory-page-heading">
          <h2>{t("memoryContentTitle")}</h2>
          <p>{t("memoryContentDescription")}</p>
        </div>
        {feedback}
        <dl className="mission-memory-summary" aria-label={t("memoryActivitySummary")}>
          <div>
            <dt>{t("memoryCapturedShort")}</dt>
            <dd>{props.activity === undefined ? "—" : totals.evidence}</dd>
            <small>{t("memoryCapturedClarification")}</small>
          </div>
          <div>
            <dt>{t("memoryRecallOperations")}</dt>
            <dd>{props.activity === undefined ? "—" : totals.recall}</dd>
          </div>
          <div className={totals.attention > 0 ? "is-warning" : ""}>
            <dt>{t("memoryNeedsAttention")}</dt>
            <dd>{props.activity === undefined ? "—" : totals.attention}</dd>
          </div>
          <div>
            <dt>{t("memoryRoundTotal")}</dt>
            <dd>{props.activity === undefined ? "—" : executions.length}</dd>
          </div>
        </dl>
        <section className="mission-memory-content-section" aria-label={t("memoryContentEntries")}>
          <h3>{t("memoryContentEntries")}</h3>
          <button
            type="button"
            className="mission-memory-content-row"
            disabled={props.loading || props.error !== undefined}
            onClick={() => setView("attention")}
          >
            <Brain size={20} aria-hidden="true" />
            <span className="mission-memory-row-copy">
              <span className="mission-memory-row-title">Attention Memory</span>
              <span className="mission-memory-row-meta">
                {t("memoryAttentionEntryDescription")}
              </span>
            </span>
            <span className="mission-memory-row-meta">
              {t("memorySelectedCount", { count: items.length })}
            </span>
            <CaretRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mission-memory-content-row"
            onClick={props.onBrowseStore}
          >
            <Database size={20} aria-hidden="true" />
            <span className="mission-memory-row-copy">
              <span className="mission-memory-row-title">Memory Store</span>
              <span className="mission-memory-row-meta">{t("memoryStoreEntryDescription")}</span>
            </span>
            <span className="mission-memory-row-action">{t("browseMemoryStore")}</span>
            <CaretRight size={16} aria-hidden="true" />
          </button>
        </section>
        <section className="mission-memory-content-section" aria-label={t("memoryRecallHistory")}>
          <header>
            <h3>{t("memoryRecallHistory")}</h3>
            <p>{t("memoryRecallHistoryDescription")}</p>
          </header>
          {recallExecutions.length === 0 &&
          !props.loading &&
          props.error === undefined &&
          props.activity !== undefined ? (
            <p className="mission-memory-message">{t("memoryRecallHistoryEmpty")}</p>
          ) : null}
          {recallExecutions
            .slice()
            .reverse()
            .slice(0, visibleRounds)
            .map((execution) => (
              <button
                type="button"
                className="mission-memory-content-row"
                key={execution.executionId}
                onClick={() => setView(execution.executionId)}
              >
                <span className="mission-memory-round">
                  {t("memoryRecallRound", { number: executions.indexOf(execution) + 1 })}
                </span>
                <span className="mission-memory-row-copy">
                  <span className="mission-memory-row-title">
                    {execution.label || t("memoryRecallRoundFallback")}
                  </span>
                  <span className="mission-memory-row-meta">
                    {execution.occurredAt === undefined
                      ? t("memoryRecallRoundDescription")
                      : formatMemoryTime(execution.occurredAt)}
                  </span>
                </span>
                <span className="mission-memory-row-action">{t("memoryViewRecallContent")}</span>
                <CaretRight size={16} aria-hidden="true" />
              </button>
            ))}
          {recallExecutions.length > visibleRounds ? (
            <button
              type="button"
              className="mission-memory-back"
              onClick={() => setVisibleRounds((count) => count + 10)}
            >
              {t("memoryMoreRounds")}
            </button>
          ) : null}
        </section>
      </>
    );
  return (
    <div className="mission-memory-activity">
      {content}
      {selectedAttention !== undefined && props.activity !== undefined ? (
        <AttentionMemoryDrawer
          missionId={props.activity.missionId}
          item={selectedAttention}
          api={api}
          onClose={() => setSelectedAttention(undefined)}
          onRefresh={
            props.onRefresh === undefined
              ? undefined
              : () => {
                  setSelectedAttention(undefined);
                  props.onRefresh?.();
                }
          }
          onOpenSource={openSource}
        />
      ) : null}
      {sourcePath !== undefined && props.source !== undefined ? (
        <Dialog
          title={t("memorySourceContent")}
          description={t("memoryRecallCurrentContent")}
          className="mission-memory-drawer mission-memory-source-drawer"
          backdropClassName="mission-memory-drawer-backdrop"
          onCancel={() => setSourcePath(undefined)}
          headerAction={<MemoryDrawerClose onClose={() => setSourcePath(undefined)} />}
        >
          <SourceMemoryBrowser
            source={props.source}
            initialEntryId={sourcePath}
            className="mission-memory-drawer-browser"
          />
        </Dialog>
      ) : null}
    </div>
  );
}

function MemoryPageHeader(props: {
  title: string;
  description?: string | undefined;
  onBack: () => void;
}) {
  const { t } = useTranslation("missions");
  return (
    <div className="mission-memory-page-heading">
      <button className="mission-memory-back" type="button" onClick={props.onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        {t("backToMemoryActivity")}
      </button>
      <h2>{props.title}</h2>
      {props.description ? <p>{props.description}</p> : null}
    </div>
  );
}
function MemoryDrawerClose(props: { onClose: () => void }) {
  const { t } = useTranslation("common");
  return (
    <button
      type="button"
      className="mission-memory-drawer-close"
      aria-label={t("actions.close")}
      onClick={props.onClose}
    >
      <X size={20} aria-hidden="true" />
    </button>
  );
}
function AttentionMemoryDrawer(props: {
  missionId: string;
  item: AttentionItem;
  api: MemoryContentApi | undefined;
  onClose: () => void;
  onRefresh: (() => void) | undefined;
  onOpenSource: (path: string) => void;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const [contextId, setContextId] = useState(props.item.contexts[0]!.id);
  const [entry, setEntry] = useState<DesktopMissionMemoryAttentionContent["entries"][number]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [selectionChanged, setSelectionChanged] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setEntry(undefined);
    setSelectionChanged(false);
    const load = async () => {
      if (props.api === undefined) throw new Error(t("memoryActivityUnavailable"));
      const content = await props.api.getMissionMemoryAttention({
        missionId: props.missionId,
        contextId,
      });
      const selected = content.entries.find(
        (item) =>
          item.module === props.item.module &&
          item.memoryId === props.item.memoryId &&
          item.revision === props.item.revision,
      );
      if (selected === undefined) {
        if (!cancelled) setSelectionChanged(true);
        throw new Error(t("memoryAttentionSelectionChanged"));
      }
      if (!cancelled) setEntry(selected);
    };
    void load()
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.api, props.missionId, props.item, contextId, retry, t]);
  return (
    <Dialog
      title={props.item.title ?? t("memorySourceUnavailable")}
      description={t("memoryAttentionContentDescription")}
      className="mission-memory-drawer"
      backdropClassName="mission-memory-drawer-backdrop"
      onCancel={props.onClose}
      headerAction={<MemoryDrawerClose onClose={props.onClose} />}
    >
      {props.item.contexts.length > 1 ? (
        <SelectMenu
          ariaLabel={t("memoryAttentionContextChoice")}
          value={contextId}
          onChange={setContextId}
          portal={false}
          options={props.item.contexts.map((context) => ({
            value: context.id,
            label: t("memoryAttentionContext", { number: context.number }),
          }))}
        />
      ) : null}
      {loading ? (
        <p className="mission-memory-message" role="status">
          {t("memoryContentLoading")}
        </p>
      ) : null}
      {error !== undefined ? (
        <div className="mission-memory-message is-warning" role="alert">
          <p>{error}</p>
          <button
            className="text-button"
            type="button"
            onClick={() =>
              selectionChanged && props.onRefresh !== undefined
                ? props.onRefresh()
                : setRetry((value) => value + 1)
            }
          >
            {t("actions.retry", { ns: "common" })}
          </button>
        </div>
      ) : null}
      {entry !== undefined ? (
        <>
          <p className="mission-memory-row-meta">
            {t(
              entry.decisionMode === "provider"
                ? "memoryAttentionAssessed"
                : "memoryAttentionUnassessed",
            )}
          </p>
          <div className="mission-memory-fragment mission-markdown">
            <MarkdownContent source={entry.content} />
          </div>
          <button
            type="button"
            className="mission-memory-back"
            onClick={() => props.onOpenSource(`${entry.module}/items/${entry.memoryId}.md`)}
          >
            {t("memoryAttentionBrowse")}
          </button>
        </>
      ) : null}
    </Dialog>
  );
}
function MissionRecallContent(props: {
  missionId: string;
  executionId: string;
  label?: string | undefined;
  number: number;
  api: MemoryContentApi | undefined;
  onBack: () => void;
  onOpenSource: (path: string) => void;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const [page, setPage] = useState<DesktopMissionMemoryRecallPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const requestRevision = useRef(0);
  useEffect(() => {
    requestRevision.current += 1;
    let cancelled = false;
    setLoading(true);
    setPage(undefined);
    setError(undefined);
    const load = async () => {
      if (props.api === undefined) throw new Error(t("memoryActivityUnavailable"));
      const next = await props.api.listMissionMemoryRecall({
        missionId: props.missionId,
        executionId: props.executionId,
        limit: 30,
      });
      if (!cancelled) setPage(next);
    };
    void load()
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      requestRevision.current += 1;
    };
  }, [props.api, props.missionId, props.executionId, retry, t]);
  const loadMore = async () => {
    if (page?.nextBefore === undefined || props.api === undefined || loading) return;
    const revision = ++requestRevision.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await props.api.listMissionMemoryRecall({
        missionId: props.missionId,
        executionId: props.executionId,
        before: page.nextBefore,
        limit: 30,
      });
      if (revision !== requestRevision.current) return;
      setPage({ ...next, records: [...page.records, ...next.records] });
    } catch (cause) {
      if (revision === requestRevision.current) setError(errorMessage(cause));
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  };
  const sourceName = (
    source: DesktopMissionMemoryRecallPage["records"][number]["sources"][number],
  ) =>
    source.title ??
    memoryContextTitle(source.id, t) ??
    t(source.available ? "memoryRecordedSource" : "memorySourceUnavailable");
  return (
    <>
      <MemoryPageHeader
        title={t("memoryRecallRoundTitle", { number: props.number })}
        description={props.label}
        onBack={props.onBack}
      />
      <p className="mission-memory-message">{t("memoryRecallCurrentContent")}</p>
      {error !== undefined ? (
        <div className="mission-memory-message is-warning" role="alert">
          <p>{error}</p>
          <button
            className="text-button"
            type="button"
            onClick={() => (page === undefined ? setRetry((value) => value + 1) : void loadMore())}
          >
            {t("actions.retry", { ns: "common" })}
          </button>
        </div>
      ) : null}
      {page?.records.map((record) => (
        <section className="mission-memory-recall-record" key={record.id}>
          <header>
            <h3>
              {t(
                record.operation === "read"
                  ? "memoryRecallReadContent"
                  : record.operation === "search"
                    ? "memoryRecallSearchContent"
                    : "memoryRecallListContent",
              )}
            </h3>
            <time dateTime={record.occurredAt}>{formatMemoryTime(record.occurredAt)}</time>
          </header>
          {record.outcome !== "allowed" ? (
            <p className="mission-memory-message is-warning" role="status">
              {t(record.outcome === "denied" ? "memoryRecallDenied" : "memoryRecallFailed")} ·{" "}
              <code>{record.reason}</code>
            </p>
          ) : null}
          {record.sources.length === 0 && record.outcome === "allowed" ? (
            <p className="mission-memory-message">{t("memoryRecallNoResults")}</p>
          ) : null}
          {record.sources.map((source, index) => (
            <button
              type="button"
              className="mission-memory-content-row"
              key={`${source.id}:${index}`}
              disabled={!source.available}
              onClick={() => props.onOpenSource(source.id)}
            >
              <span className="mission-memory-row-copy">
                <span className="mission-memory-row-title">{sourceName(source)}</span>
                <span className="mission-memory-row-meta">
                  {!source.available
                    ? t("memorySourceUnavailable")
                    : source.revision !== undefined &&
                        source.currentRevision !== undefined &&
                        source.revision !== source.currentRevision
                      ? t("memoryRecallSourceUpdated")
                      : t("memoryViewSourceContent")}
                </span>
              </span>
              <CaretRight size={16} aria-hidden="true" />
            </button>
          ))}
        </section>
      ))}
      {loading ? (
        <p className="mission-memory-message" role="status">
          {t("memoryContentLoading")}
        </p>
      ) : null}
      {!loading && page?.records.length === 0 ? (
        <p className="mission-memory-message">{t("memoryRecallEmpty")}</p>
      ) : null}
      {page?.nextBefore !== undefined ? (
        <button
          type="button"
          className="mission-memory-back"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {t("memoryMoreRecall")}
        </button>
      ) : null}
    </>
  );
}
function formatMemoryTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function SourceMemoryBrowser(props: {
  source: ContextStoreBrowserSource;
  initialEntryId: string;
  className: string;
}) {
  const source = useMemo<ContextStoreBrowserSource>(() => {
    const lists = new Map<string, ReturnType<ContextStoreBrowserSource["list"]>>();
    const initialReads = new Map<string, ReturnType<ContextStoreBrowserSource["read"]>>();
    const list = (scopeId: string) => {
      let result = lists.get(scopeId);
      if (result === undefined) {
        result = props.source.list(scopeId);
        lists.set(scopeId, result);
      }
      return result;
    };
    return {
      ...props.source,
      list,
      read: (scopeId, id, start) =>
        (start === 0 ? initialReads.get(`${scopeId}:${id}`) : undefined) ??
        props.source.read(scopeId, id, start),
      getDescriptor: async () => {
        lists.clear();
        initialReads.clear();
        const descriptor = await props.source.getDescriptor();
        const scopes = descriptor.scopes
          .filter((scope) => scope.availability === "available")
          .toSorted(
            (left, right) =>
              Number(right.id === descriptor.defaultScopeId) -
              Number(left.id === descriptor.defaultScopeId),
          );
        for (const scope of scopes) {
          const entries = await list(scope.id).catch(() => []);
          if (entries.some((entry) => entry.id === props.initialEntryId))
            return { ...descriptor, defaultScopeId: scope.id };
        }
        // Memory indexes do not list every item. Probe the allowed scopes only
        // after the user opens a source, and reuse the successful first chunk.
        for (const scope of scopes) {
          try {
            const content = await props.source.read(scope.id, props.initialEntryId, 0);
            if (content.id !== props.initialEntryId) continue;
            initialReads.set(`${scope.id}:${props.initialEntryId}`, Promise.resolve(content));
            return { ...descriptor, defaultScopeId: scope.id };
          } catch {
            // The browser reports the default scope's read error if no scope can read it.
          }
        }
        return descriptor;
      },
    };
  }, [props.source, props.initialEntryId]);
  return (
    <MemoryStoreBrowser
      source={source}
      initialEntryId={props.initialEntryId}
      className={props.className}
    />
  );
}
