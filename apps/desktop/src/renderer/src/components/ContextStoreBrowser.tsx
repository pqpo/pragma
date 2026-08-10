import {
  ArrowClockwise,
  CaretRight,
  File,
  FileText,
  Folder,
  ImageSquare,
  MagnifyingGlass,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  MissionContextStoreContent,
  MissionContextStoreDescriptor,
  MissionContextStoreEntry,
  MissionContextStoreSearchMatch,
} from "../../../shared/contracts/index.ts";
import { errorMessage } from "../lib/errors.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";

export type ContextStoreBrowserDescriptor = Pick<
  MissionContextStoreDescriptor,
  | "storeId"
  | "namespace"
  | "name"
  | "readOnly"
  | "searchable"
  | "root"
  | "defaultScopeId"
  | "scopes"
> & {
  readonly hasMemory?: boolean | undefined;
};

export interface ContextStoreBrowserSource {
  readonly getDescriptor: () => Promise<ContextStoreBrowserDescriptor>;
  readonly list: (scopeId: string) => Promise<readonly MissionContextStoreEntry[]>;
  readonly read: (
    scopeId: string,
    id: string,
    start: number,
  ) => Promise<MissionContextStoreContent>;
  readonly search: (
    scopeId: string,
    query: string,
  ) => Promise<readonly MissionContextStoreSearchMatch[]>;
}

export function ContextStoreBrowser(props: {
  readonly source: ContextStoreBrowserSource;
  readonly variant?: "memory" | "mission-board" | undefined;
}) {
  const { t } = useTranslation("missions");
  const variant = props.variant ?? "memory";
  const [descriptor, setDescriptor] = useState<ContextStoreBrowserDescriptor>();
  const [scopeId, setScopeId] = useState("");
  const [entries, setEntries] = useState<readonly MissionContextStoreEntry[]>([]);
  const [discovered, setDiscovered] = useState<readonly MissionContextStoreEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [chunks, setChunks] = useState<readonly MissionContextStoreContent[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<readonly MissionContextStoreSearchMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [error, setError] = useState<string>();
  const requestRevision = useRef(0);

  const readEntry = useCallback(
    async (id: string, start = 0) => {
      if (scopeId === "") return;
      const request = ++requestRevision.current;
      setContentLoading(true);
      if (start === 0) {
        setSelectedId(id);
        setChunks([]);
      }
      try {
        const content = await props.source.read(scopeId, id, start);
        if (request !== requestRevision.current) return;
        setChunks((current) => (start === 0 ? [content] : [...current, content]));
        setDiscovered((current) =>
          current.some((entry) => entry.id === content.id)
            ? current
            : [...current, summaryFromContent(content)],
        );
        setError(undefined);
      } catch (cause) {
        if (request === requestRevision.current) setError(errorMessage(cause));
      } finally {
        if (request === requestRevision.current) setContentLoading(false);
      }
    },
    [props.source, scopeId],
  );
  const followInternalLink = useCallback(
    (href: string) => {
      const id = normalizeInternalContextId(href);
      if (id === undefined) return;
      void readEntry(id);
    },
    [readEntry],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void props.source
      .getDescriptor()
      .then((next) => {
        if (cancelled) return;
        setDescriptor(next);
        setScopeId((current) =>
          next.scopes.some((scope) => scope.id === current) ? current : next.defaultScopeId,
        );
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.source, refreshRevision]);

  useEffect(() => {
    if (scopeId === "") return;
    const scope = descriptor?.scopes.find((candidate) => candidate.id === scopeId);
    requestRevision.current += 1;
    setEntries([]);
    setDiscovered([]);
    setSelectedId(undefined);
    setChunks([]);
    setMatches([]);
    setQuery("");
    if (scope !== undefined && !isMemoryScopeSelectable(scope)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void props.source
      .list(scopeId)
      .then((next) => {
        if (cancelled) return;
        setEntries(next);
        const initial =
          next.find((entry) => entry.id === "overview.md") ??
          next.find((entry) => entry.id === "guide.md") ??
          next[0];
        if (initial !== undefined) void readEntry(initial.id);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [descriptor, props.source, readEntry, scopeId]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized === "" || scopeId === "") {
      setMatches([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void props.source
        .search(scopeId, normalized)
        .then((next) => {
          if (!cancelled) {
            setMatches(next);
            setError(undefined);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.source, query, scopeId]);

  const selectedScope = descriptor?.scopes.find((scope) => scope.id === scopeId);
  const visibleEntries = useMemo(
    () => uniqueEntries([...entries, ...discovered]),
    [discovered, entries],
  );
  const treeRows = useMemo(() => buildTreeRows(visibleEntries), [visibleEntries]);
  const selected = chunks[0];
  const content = chunks.map((chunk) => chunk.content).join("");
  const lastChunk = chunks.at(-1);
  const previewKind = selected === undefined ? undefined : entryPreviewKind(selected);
  const scopeDescriptionKey = memoryScopeDescriptionKey(descriptor, selectedScope);

  if (loading && descriptor === undefined) {
    return (
      <div className="context-browser-state">
        <SpinnerGap className="spin" size={24} aria-hidden="true" />
        <span>{t("contextStoreLoading")}</span>
      </div>
    );
  }
  if (descriptor === undefined) {
    return <ContextBrowserError message={error ?? t("contextStoreUnavailable")} />;
  }

  return (
    <div className="context-browser">
      <div className="context-browser-scope-bar">
        <span>
          {variant === "mission-board"
            ? t("missionBoardRoot", { name: descriptor.root.name })
            : t("contextStoreRoot", { name: descriptor.root.name })}
        </span>
        {variant === "mission-board" ? (
          <small className="context-browser-board-scope">{t("missionBoardSharedScope")}</small>
        ) : (
          <>
            <label>
              {t("contextStoreViewingAs")}
              <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
                {descriptor.scopes.map((scope) => (
                  <option
                    key={scope.id}
                    value={scope.id}
                    disabled={!isMemoryScopeSelectable(scope)}
                  >
                    {scope.name} · {t(`contextStoreRole.${scope.role}`)} ·{" "}
                    {t(`contextStoreParticipation.${scope.participation}`)} ·{" "}
                    {t(`contextStoreAvailability.${scope.availability}`)}
                  </option>
                ))}
              </select>
            </label>
            <small>{t(scopeDescriptionKey, { expert: selectedScope?.name ?? "" })}</small>
          </>
        )}
        <button
          type="button"
          className="context-browser-refresh"
          aria-label={t("contextStoreRefresh")}
          title={t("contextStoreRefresh")}
          onClick={() => setRefreshRevision((current) => current + 1)}
        >
          <ArrowClockwise size={17} aria-hidden="true" />
        </button>
      </div>

      {selectedScope?.availability === "recall_disabled" ? (
        <div className="context-browser-state">
          <WarningCircle size={28} weight="thin" aria-hidden="true" />
          <strong>{t("contextStoreRecallDisabled")}</strong>
          <span>{t("contextStoreRecallDisabledDescription")}</span>
        </div>
      ) : selectedScope?.availability === "empty" ? (
        <div className="context-browser-state">
          <FileText size={28} weight="thin" aria-hidden="true" />
          <strong>{t("contextStoreEmpty")}</strong>
          <span>
            {descriptor.root.type === "pragma.expert-team" && selectedScope.role === "root"
              ? t("contextStoreTeamEmptyDescription")
              : t("contextStoreExpertEmptyDescription", {
                  expert: selectedScope.name,
                })}
          </span>
        </div>
      ) : (
        <div className="context-browser-workspace">
          <aside className="context-browser-tree-panel">
            <label className="context-browser-search">
              <MagnifyingGlass size={16} aria-hidden="true" />
              <span className="sr-only">
                {variant === "mission-board" ? t("missionBoardSearch") : t("contextStoreSearch")}
              </span>
              <input
                type="search"
                value={query}
                placeholder={
                  variant === "mission-board" ? t("missionBoardSearch") : t("contextStoreSearch")
                }
                onChange={(event) => setQuery(event.target.value)}
              />
              {searching ? <SpinnerGap className="spin" size={15} aria-hidden="true" /> : null}
            </label>
            {query.trim() === "" ? (
              <div className="context-browser-tree" role="tree">
                {treeRows.map((row) =>
                  row.kind === "directory" ? (
                    <div
                      className="context-browser-folder"
                      key={`directory:${row.id}`}
                      style={{ paddingInlineStart: 10 + row.depth * 16 }}
                    >
                      <CaretRight size={13} aria-hidden="true" />
                      <Folder size={16} aria-hidden="true" />
                      <span>{row.name}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      role="treeitem"
                      aria-selected={selectedId === row.entry.id}
                      className={
                        selectedId === row.entry.id
                          ? "context-browser-file is-selected"
                          : "context-browser-file"
                      }
                      key={`file:${row.entry.id}`}
                      style={{ paddingInlineStart: 26 + row.depth * 16 }}
                      onClick={() => void readEntry(row.entry.id)}
                    >
                      <ContextEntryIcon entry={row.entry} />
                      <span>{row.name}</span>
                      {row.entry.metadata.trigger === "always_on" ? (
                        <small>{t("contextStoreAlwaysOn")}</small>
                      ) : null}
                    </button>
                  ),
                )}
              </div>
            ) : (
              <div className="context-browser-results" role="list">
                {!searching && matches.length === 0 ? <p>{t("contextStoreNoMatches")}</p> : null}
                {matches.map((match, index) => (
                  <button
                    type="button"
                    role="listitem"
                    key={`${match.id}:${match.lineNumber ?? 0}:${index}`}
                    onClick={() => void readEntry(match.id)}
                  >
                    <strong>{match.id}</strong>
                    <span>{match.line}</span>
                    {match.lineNumber === undefined ? null : (
                      <small>{t("contextStoreLine", { line: match.lineNumber })}</small>
                    )}
                  </button>
                ))}
              </div>
            )}
          </aside>

          <main className="context-browser-preview">
            {error !== undefined ? <ContextBrowserError message={error} compact /> : null}
            {selected === undefined ? (
              <div className="context-browser-preview-empty">
                {contentLoading ? (
                  <SpinnerGap className="spin" size={24} />
                ) : (
                  <FileText size={30} />
                )}
                <p>
                  {contentLoading
                    ? t("contextStoreLoadingEntry")
                    : variant === "mission-board"
                      ? t("missionBoardSelectEntry")
                      : t("contextStoreSelectEntry")}
                </p>
              </div>
            ) : (
              <>
                <header className="context-browser-preview-header">
                  <div>
                    <strong>{selected.id}</strong>
                    {selected.metadata.description === undefined ? null : (
                      <span>{selected.metadata.description}</span>
                    )}
                  </div>
                  <div className="context-browser-metadata">
                    <span>{triggerLabel(selected.metadata.trigger, t)}</span>
                    <span>{t(`contextStorePriority.${selected.metadata.priority}`)}</span>
                    {selected.metadata.sensitivity === undefined ? null : (
                      <span>{selected.metadata.sensitivity}</span>
                    )}
                    {selected.sizeBytes === undefined ? null : (
                      <span>{formatBytes(selected.sizeBytes)}</span>
                    )}
                    {selected.mediaType === undefined ? null : <span>{selected.mediaType}</span>}
                  </div>
                </header>
                {previewKind === "image" && selected.contentEncoding === "base64" ? (
                  <div className="context-browser-image-preview">
                    <img
                      src={`data:${selected.mediaType ?? "application/octet-stream"};base64,${content}`}
                      alt={selected.id}
                    />
                  </div>
                ) : previewKind === "unsupported" ? (
                  <div className="context-browser-preview-empty">
                    <File size={30} aria-hidden="true" />
                    <strong>{t("missionBoardPreviewUnsupported")}</strong>
                    <p>{t("missionBoardPreviewUnsupportedDescription")}</p>
                  </div>
                ) : (
                  <div className="context-browser-markdown">
                    {isMarkdownEntry(selected) ? (
                      <MarkdownContent
                        source={content}
                        codeBlockControls
                        onInternalLink={followInternalLink}
                      />
                    ) : (
                      <pre className="context-browser-plain-text">{content}</pre>
                    )}
                    {lastChunk?.contentRange.truncated ? (
                      <button
                        type="button"
                        className="context-browser-load-more"
                        disabled={contentLoading}
                        onClick={() =>
                          void readEntry(selected.id, lastChunk.contentRange.nextStartOffset)
                        }
                      >
                        {contentLoading ? t("contextStoreLoadingEntry") : t("contextStoreLoadMore")}
                      </button>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

export function memoryScopeDescriptionKey(
  descriptor: ContextStoreBrowserDescriptor | undefined,
  scope: MissionContextStoreDescriptor["scopes"][number] | undefined,
):
  | "contextStoreTeamScopeDescription"
  | "contextStoreExpertScopeDescription"
  | "contextStoreFlowScopeDescription" {
  if (descriptor?.root.type === "pragma.expert-team" && scope?.role === "root") {
    return "contextStoreTeamScopeDescription";
  }
  if (descriptor?.root.type === "pragma.flow") return "contextStoreFlowScopeDescription";
  return "contextStoreExpertScopeDescription";
}

export function isMemoryScopeSelectable(
  scope: MissionContextStoreDescriptor["scopes"][number],
): boolean {
  return scope.availability === "available";
}

function ContextEntryIcon(props: { readonly entry: MissionContextStoreEntry }) {
  const kind = entryPreviewKind(props.entry);
  return kind === "image" ? (
    <ImageSquare size={16} aria-hidden="true" />
  ) : kind === "text" ? (
    <FileText size={16} aria-hidden="true" />
  ) : (
    <File size={16} aria-hidden="true" />
  );
}

export function entryPreviewKind(
  entry: Pick<MissionContextStoreEntry, "id" | "previewKind">,
): "text" | "image" | "unsupported" {
  return entry.previewKind ?? "text";
}

export function summaryFromContent(content: MissionContextStoreContent): MissionContextStoreEntry {
  return {
    id: content.id,
    metadata: content.metadata,
    ...(content.revision === undefined ? {} : { revision: content.revision }),
    ...(content.etag === undefined ? {} : { etag: content.etag }),
    ...(content.sizeBytes === undefined ? {} : { sizeBytes: content.sizeBytes }),
    ...(content.mediaType === undefined ? {} : { mediaType: content.mediaType }),
    ...(content.previewKind === undefined ? {} : { previewKind: content.previewKind }),
  };
}

function isMarkdownEntry(entry: Pick<MissionContextStoreContent, "id" | "mediaType">): boolean {
  return entry.mediaType === "text/markdown" || entry.id.toLowerCase().endsWith(".md");
}

function ContextBrowserError(props: { readonly message: string; readonly compact?: boolean }) {
  return (
    <div
      className={props.compact ? "context-browser-error is-compact" : "context-browser-error"}
      role="alert"
    >
      <WarningCircle size={20} aria-hidden="true" />
      <span>{props.message}</span>
    </div>
  );
}

type TreeRow =
  | {
      readonly kind: "directory";
      readonly id: string;
      readonly name: string;
      readonly depth: number;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly depth: number;
      readonly entry: MissionContextStoreEntry;
    };

export function buildTreeRows(entries: readonly MissionContextStoreEntry[]): readonly TreeRow[] {
  const rows: TreeRow[] = [];
  const directories = new Set<string>();
  for (const entry of entries.toSorted(compareEntries)) {
    const parts = entry.id.split("/");
    for (let index = 0; index < parts.length - 1; index += 1) {
      const id = parts.slice(0, index + 1).join("/");
      if (directories.has(id)) continue;
      directories.add(id);
      rows.push({ kind: "directory", id, name: parts[index]!, depth: index });
    }
    rows.push({
      kind: "file",
      name: parts.at(-1) ?? entry.id,
      depth: parts.length - 1,
      entry,
    });
  }
  return rows;
}

function compareEntries(left: MissionContextStoreEntry, right: MissionContextStoreEntry): number {
  const rootOrder = ["guide.md", "overview.md"];
  const leftRoot = rootOrder.indexOf(left.id.toLowerCase());
  const rightRoot = rootOrder.indexOf(right.id.toLowerCase());
  if (leftRoot >= 0 || rightRoot >= 0) {
    if (leftRoot < 0) return 1;
    if (rightRoot < 0) return -1;
    return leftRoot - rightRoot;
  }
  return left.id.localeCompare(right.id);
}

function uniqueEntries(entries: readonly MissionContextStoreEntry[]): MissionContextStoreEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

export function normalizeInternalContextId(href: string): string | undefined {
  const id = href.trim();
  if (
    id.length === 0 ||
    id.length > 2_000 ||
    id.startsWith("/") ||
    id.includes("\\") ||
    id.includes(":") ||
    id.includes("#") ||
    id.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return undefined;
  }
  return id;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
}

function triggerLabel(
  trigger: MissionContextStoreEntry["metadata"]["trigger"],
  t: (key: string) => string,
): string {
  return t(`contextStoreTrigger.${trigger}`);
}
