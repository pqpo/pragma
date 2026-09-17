import {
  ArrowLeft,
  ArrowsClockwise,
  Database,
  DownloadSimple,
  MagnifyingGlass,
  Package,
  SealCheck,
  Storefront,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopSquareCatalog,
  DesktopSquareItemDetail,
  PragmaDesktopAPI,
  PragmaBundleImportInspection,
} from "../../../../shared/contracts/index.ts";
import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type SquareKind = DesktopSquareCatalog["items"][number]["kind"];
type SquareKindFilter = "all" | SquareKind;
type SquareSort = "latest" | "name";

const KINDS: readonly SquareKindFilter[] = [
  "all",
  "expert",
  "expert-team",
  "flow",
  "knowledge-base",
];

interface InspectedSquareVersion {
  readonly version: string;
  readonly path: string;
  readonly rootRef: string;
  readonly inspection: PragmaBundleImportInspection;
}

export function squareCategoriesForView(
  categories: DesktopSquareCatalog["categories"],
  kind: SquareKindFilter,
  locale: string,
): DesktopSquareCatalog["categories"] {
  const candidates = categories.filter((item) => kind === "all" || item.kind === kind);
  const byId = new Map<string, (typeof candidates)[number]>();
  for (const item of candidates) {
    const current = byId.get(item.id);
    if (current === undefined || item.order < current.order) byId.set(item.id, item);
  }
  return [...byId.values()].toSorted(
    (left, right) =>
      left.order - right.order ||
      localized(left.name, locale).localeCompare(localized(right.name, locale), locale),
  );
}

export function squareItemsForView(
  items: DesktopSquareCatalog["items"],
  options: {
    readonly kind: SquareKindFilter;
    readonly sourceId: string;
    readonly category: string;
    readonly query: string;
    readonly sort: SquareSort;
    readonly locale: string;
  },
): DesktopSquareCatalog["items"] {
  const normalizedQuery = options.query.trim().toLocaleLowerCase();
  return items
    .filter((item) => {
      const searchable = [
        localized(item.name, options.locale),
        localized(item.summary, options.locale),
        item.author.name,
        ...item.tags,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return (
        (options.kind === "all" || item.kind === options.kind) &&
        (options.sourceId === "all" || item.sourceId === options.sourceId) &&
        (options.category === "all" || item.categoryId === options.category) &&
        searchable.includes(normalizedQuery)
      );
    })
    .toSorted((left, right) =>
      options.sort === "latest"
        ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        : localized(left.name, options.locale).localeCompare(
            localized(right.name, options.locale),
            options.locale,
          ),
    );
}

export async function inspectSquareVersion(
  api: Pick<PragmaDesktopAPI, "downloadSquareBundle" | "inspectPragmaBundle">,
  detail: DesktopSquareItemDetail,
  version: string,
): Promise<InspectedSquareVersion> {
  const downloaded = await api.downloadSquareBundle({
    sourceId: detail.sourceId,
    kind: detail.item.kind,
    itemId: detail.item.id,
    version,
  });
  const inspection = await api.inspectPragmaBundle({
    sourcePath: downloaded.path,
    rootRef: downloaded.rootRef,
  });
  return { version, path: downloaded.path, rootRef: downloaded.rootRef, inspection };
}

export function SquareDirectoryFragment(props: {
  readonly onInstall: (sourcePath: string, rootRef: string) => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [catalog, setCatalog] = useState<DesktopSquareCatalog>({
    items: [],
    categories: [],
    sources: [],
  });
  const [selected, setSelected] = useState<DesktopSquareItemDetail | null>(null);
  const [kind, setKind] = useState<SquareKindFilter>("all");
  const [sourceId, setSourceId] = useState("all");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<SquareSort>("latest");
  const [version, setVersion] = useState("");
  const [inspectedVersion, setInspectedVersion] = useState<InspectedSquareVersion | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const inspectionRequest = useRef(0);

  const loadCatalog = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setCatalog(await api.getSquareCatalog());
  };

  useEffect(() => {
    void loadCatalog().catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const categories = useMemo(
    () => squareCategoriesForView(catalog.categories, kind, i18n.language),
    [catalog.categories, i18n.language, kind],
  );
  const items = useMemo(
    () =>
      squareItemsForView(catalog.items, {
        kind,
        sourceId,
        category,
        query,
        sort,
        locale: i18n.language,
      }),
    [catalog.items, category, i18n.language, kind, query, sort, sourceId],
  );

  const refresh = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setRefreshing(true);
    setError(null);
    try {
      await api.refreshBundleRegistrySources();
      await loadCatalog();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const loadVersion = async (detail: DesktopSquareItemDetail, nextVersion: string) => {
    const api = desktopApi();
    if (api === undefined) return;
    const request = ++inspectionRequest.current;
    setLoadingVersion(true);
    setVersionError(null);
    setInspectedVersion(null);
    try {
      const inspected = await inspectSquareVersion(api, detail, nextVersion);
      if (inspectionRequest.current !== request) return;
      setInspectedVersion(inspected);
    } catch (cause) {
      if (inspectionRequest.current === request) setVersionError(errorMessage(cause));
    } finally {
      if (inspectionRequest.current === request) setLoadingVersion(false);
    }
  };

  const open = async (item: DesktopSquareCatalog["items"][number]) => {
    const api = desktopApi();
    if (api === undefined) return;
    setOpening(true);
    setError(null);
    try {
      const detail = await api.getSquareItem({
        sourceId: item.sourceId,
        kind: item.kind,
        itemId: item.id,
      });
      setSelected(detail);
      setVersion(detail.item.latestVersion);
      void loadVersion(detail, detail.item.latestVersion);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpening(false);
    }
  };

  const install = async () => {
    if (selected === null || version === "") return;
    const cached = inspectedVersion?.version === version ? inspectedVersion : null;
    if (cached !== null) {
      props.onInstall(cached.path, cached.rootRef);
      return;
    }
    const api = desktopApi();
    if (api === undefined) return;
    setInstalling(true);
    setVersionError(null);
    try {
      const result = await api.downloadSquareBundle({
        sourceId: selected.sourceId,
        kind: selected.item.kind,
        itemId: selected.item.id,
        version,
      });
      props.onInstall(result.path, result.rootRef);
    } catch (cause) {
      setVersionError(errorMessage(cause));
    } finally {
      setInstalling(false);
    }
  };

  if (selected !== null) {
    const selectedCategory = catalog.categories.find(
      (item) => item.kind === selected.item.kind && item.id === selected.item.categoryId,
    );
    const inspection =
      inspectedVersion?.version === version ? inspectedVersion.inspection : undefined;
    return (
      <StudioScreenFrame
        className="square-detail"
        labelledBy="square-detail-heading"
        header={
          <header className="square-detail-navigation">
            <button
              className="back-link"
              type="button"
              onClick={() => {
                inspectionRequest.current += 1;
                setSelected(null);
                setInspectedVersion(null);
                setVersionError(null);
              }}
            >
              <ArrowLeft size={17} /> {t("square.back")}
            </button>
          </header>
        }
      >
        <div className="square-detail-overview">
          <SquareItemVisual item={selected.item} size="lg" />
          <div className="square-detail-copy">
            <div className="square-detail-badges">
              <span>{t(`square.kinds.${selected.item.kind}`)}</span>
              <span>
                {selectedCategory === undefined
                  ? selected.item.categoryId
                  : localized(selectedCategory.name, i18n.language)}
              </span>
            </div>
            <h1 id="square-detail-heading">{localized(selected.item.name, i18n.language)}</h1>
            <p>{localized(selected.item.summary, i18n.language)}</p>
            <div className="square-detail-tags">
              {selected.item.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <small>
              {selected.sourceOfficial ? <SealCheck size={14} /> : null}
              {selected.sourceName} · {selected.item.author.name}
            </small>
          </div>
          <div className="square-install-panel">
            <label>{t("square.version")}</label>
            <SelectMenu
              ariaLabel={t("square.version")}
              className="square-version-select"
              value={version}
              options={selected.item.versions.map((item) => ({ value: item, label: item }))}
              onChange={(nextVersion) => {
                setVersion(nextVersion);
                void loadVersion(selected, nextVersion);
              }}
            />
            <button
              className="primary-button"
              type="button"
              disabled={installing || loadingVersion}
              onClick={() => void install()}
            >
              <DownloadSimple size={17} />
              {installing ? t("square.downloading") : t("square.installVersion", { version })}
            </button>
          </div>
        </div>

        <div className="square-detail-body">
          <main className="square-detail-main">
            <section aria-labelledby="square-description-heading">
              <h2 id="square-description-heading">{t("square.fullDescription")}</h2>
              <article className="square-readme">
                <MarkdownContent
                  source={localized(selected.item.description, i18n.language)}
                  codeBlockControls
                />
              </article>
            </section>
          </main>
          <aside className="square-detail-sidebar">
            <section aria-labelledby="square-contents-heading">
              <h2 id="square-contents-heading">{t("square.contents")}</h2>
              {loadingVersion ? (
                <p className="square-detail-status">{t("square.loadingVersion")}</p>
              ) : versionError !== null ? (
                <div className="square-detail-version-error" role="alert">
                  <p>{versionError}</p>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void loadVersion(selected, version)}
                  >
                    {t("square.retryVersion")}
                  </button>
                </div>
              ) : inspection === undefined ? null : (
                <>
                  <p className="square-detail-count">
                    <Package size={18} />
                    {t("square.resourceCount", { count: inspection.resources })}
                  </p>
                  <ul className="square-detail-roots">
                    {inspection.roots.map((root) => (
                      <li key={root.ref}>{root.name}</li>
                    ))}
                  </ul>
                  <h3>{t("square.dependencies")}</h3>
                  {inspection.dependencies.length === 0 ? (
                    <p className="square-detail-status">{t("square.noDependencies")}</p>
                  ) : (
                    <ul className="square-detail-dependencies">
                      {inspection.dependencies.map((dependency) => (
                        <li key={`${dependency.kind}:${dependency.ref}`}>
                          <span>{dependency.name}</span>
                          <small>
                            {t(`square.dependencyKinds.${dependency.kind}`)} ·{" "}
                            {t(
                              dependency.included
                                ? "square.dependencyIncluded"
                                : "square.dependencyRequired",
                            )}
                          </small>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
            <section aria-labelledby="square-provenance-heading">
              <h2 id="square-provenance-heading">{t("square.provenance")}</h2>
              <dl>
                <dt>{t("square.source")}</dt>
                <dd>{selected.sourceName}</dd>
                <dt>{t("square.author")}</dt>
                <dd>{selected.item.author.name}</dd>
                <dt>{t("square.license")}</dt>
                <dd>{selected.item.license}</dd>
                <dt>{t("square.commit")}</dt>
                <dd>
                  <code>{selected.commit.slice(0, 12)}</code>
                </dd>
              </dl>
            </section>
          </aside>
        </div>
      </StudioScreenFrame>
    );
  }

  return (
    <StudioScreenFrame
      className="square-directory"
      labelledBy="square-heading"
      header={
        <header className="studio-heading square-heading">
          <div>
            <h1 id="square-heading">{t("square.title")}</h1>
            <p>{t("square.description")}</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <ArrowsClockwise size={17} />
            {refreshing ? t("square.refreshing") : t("square.refresh")}
          </button>
        </header>
      }
    >
      <div className="square-kind-tabs" role="tablist" aria-label={t("square.type")}>
        {KINDS.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={kind === item}
            className={kind === item ? "is-active" : undefined}
            key={item}
            onClick={() => {
              setKind(item);
              setCategory("all");
            }}
          >
            {t(`square.kinds.${item}`)}
          </button>
        ))}
      </div>
      <div className="square-category-strip" aria-label={t("square.businessCategories")}>
        <button
          type="button"
          className={category === "all" ? "is-active" : undefined}
          onClick={() => setCategory("all")}
        >
          {t("square.allBusinessCategories")}
        </button>
        {categories.map((item) => (
          <button
            type="button"
            className={category === item.id ? "is-active" : undefined}
            key={item.id}
            onClick={() => setCategory(item.id)}
          >
            {localized(item.name, i18n.language)}
          </button>
        ))}
      </div>
      <div className="square-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} />
          <span className="sr-only">{t("square.search")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("square.search")}
          />
        </label>
        <SelectMenu
          className="square-source-select"
          ariaLabel={t("square.sourceFilter")}
          value={sourceId}
          options={[
            { value: "all", label: t("square.allSources") },
            ...catalog.sources.map((source) => ({ value: source.id, label: source.name })),
          ]}
          onChange={setSourceId}
        />
        <SelectMenu
          className="square-sort-select"
          ariaLabel={t("square.sort")}
          value={sort}
          options={[
            { value: "latest", label: t("square.sortLatest") },
            { value: "name", label: t("square.sortName") },
          ]}
          onChange={(value) => setSort(value as SquareSort)}
        />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {catalog.sources.length === 0 ? (
        <SquareEmpty title={t("square.noSources")} description={t("square.noSourcesDescription")} />
      ) : items.length === 0 ? (
        <SquareEmpty title={t("square.empty")} description={t("square.emptyDescription")} />
      ) : (
        <div className="square-grid" aria-busy={opening}>
          {items.map((item) => (
            <button
              className="square-card"
              type="button"
              disabled={opening}
              key={`${item.sourceId}:${item.kind}:${item.id}`}
              onClick={() => void open(item)}
            >
              <SquareItemVisual item={item} size="md" />
              <span className="square-card-copy">
                <strong>{localized(item.name, i18n.language)}</strong>
                <p>{localized(item.summary, i18n.language)}</p>
                <small>
                  {item.sourceOfficial ? <SealCheck size={14} /> : null}
                  {item.sourceName} · {item.latestVersion}
                </small>
                <span className="square-tags">
                  {item.tags.slice(0, 3).map((tag) => (
                    <em key={tag}>{tag}</em>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </StudioScreenFrame>
  );
}

export function SquareItemVisual(props: {
  readonly item: Pick<DesktopSquareCatalog["items"][number], "kind" | "avatarId">;
  readonly size: "md" | "lg";
}) {
  return props.item.kind === "flow" || props.item.kind === "knowledge-base" ? (
    <span className={`square-card-icon is-${props.size}`}>
      {props.item.kind === "knowledge-base" ? (
        <Database size={props.size === "lg" ? 28 : 22} />
      ) : (
        <Storefront size={props.size === "lg" ? 28 : 22} />
      )}
    </span>
  ) : (
    <ExpertAvatar
      avatarId={props.item.avatarId}
      team={props.item.kind === "expert-team"}
      size={props.size}
    />
  );
}

function SquareEmpty(props: { readonly title: string; readonly description: string }) {
  return (
    <div className="square-empty">
      <Storefront size={36} />
      <strong>{props.title}</strong>
      <p>{props.description}</p>
    </div>
  );
}

function localized(
  value: {
    readonly default: string;
    readonly translations?: Readonly<Record<string, string | undefined>> | undefined;
  },
  locale: string,
): string {
  return value.translations?.[locale] ?? value.default;
}
