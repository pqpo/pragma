import {
  ArrowLeft,
  ArrowsClockwise,
  DownloadSimple,
  MagnifyingGlass,
  SealCheck,
  Storefront,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopSquareCatalog,
  DesktopSquareItemDetail,
} from "../../../../shared/contracts/index.ts";
import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type SquareKind = DesktopSquareCatalog["items"][number]["kind"];
type SquareSort = "latest" | "name";

const KINDS: readonly SquareKind[] = ["expert", "expert-team", "flow"];

export function SquareDirectoryFragment(props: {
  readonly onInstall: (sourcePath: string) => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [catalog, setCatalog] = useState<DesktopSquareCatalog>({
    items: [],
    categories: [],
    sources: [],
  });
  const [selected, setSelected] = useState<DesktopSquareItemDetail | null>(null);
  const [kind, setKind] = useState<SquareKind>("expert");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<SquareSort>("latest");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setCatalog(await api.getSquareCatalog());
  };

  useEffect(() => {
    void loadCatalog().catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const categories = useMemo(
    () =>
      catalog.categories
        .filter((item) => item.kind === kind)
        .toSorted((left, right) => left.order - right.order),
    [catalog.categories, kind],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = catalog.items
    .filter((item) => {
      const searchable = [
        localized(item.name, i18n.language),
        localized(item.summary, i18n.language),
        item.author.name,
        ...item.tags,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return (
        item.kind === kind &&
        (category === "all" || item.categoryId === category) &&
        searchable.includes(normalizedQuery)
      );
    })
    .toSorted((left, right) =>
      sort === "latest"
        ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        : localized(left.name, i18n.language).localeCompare(
            localized(right.name, i18n.language),
            i18n.language,
          ),
    );

  const refresh = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api.refreshBundleRegistrySources();
      await loadCatalog();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const open = async (item: DesktopSquareCatalog["items"][number]) => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.getSquareItem({
        sourceId: item.sourceId,
        kind: item.kind,
        itemId: item.id,
      });
      setSelected(detail);
      setVersion(detail.item.latestVersion);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const api = desktopApi();
    if (api === undefined || selected === null || version === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.downloadSquareBundle({
        sourceId: selected.sourceId,
        kind: selected.item.kind,
        itemId: selected.item.id,
        version,
      });
      props.onInstall(result.path);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (selected !== null) {
    const selectedCategory = catalog.categories.find(
      (item) => item.kind === selected.item.kind && item.id === selected.item.categoryId,
    );
    return (
      <StudioScreenFrame
        className="square-detail"
        labelledBy="square-detail-heading"
        header={
          <header className="square-detail-header">
            <button className="back-button" type="button" onClick={() => setSelected(null)}>
              <ArrowLeft size={17} /> {t("square.back")}
            </button>
            <div>
              <h1 id="square-detail-heading">{localized(selected.item.name, i18n.language)}</h1>
              <p>{localized(selected.item.summary, i18n.language)}</p>
            </div>
            <div className="square-install-controls">
              <SelectMenu
                ariaLabel={t("square.version")}
                className="square-version-select"
                value={version}
                options={selected.item.versions.map((item) => ({ value: item, label: item }))}
                onChange={setVersion}
              />
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void install()}
              >
                <DownloadSimple size={17} /> {busy ? t("square.downloading") : t("square.install")}
              </button>
            </div>
          </header>
        }
      >
        <div className="square-detail-body">
          <aside>
            <dl>
              <dt>{t("square.source")}</dt>
              <dd>
                {selected.sourceOfficial ? <SealCheck size={16} /> : null}
                {selected.sourceName}
              </dd>
              <dt>{t("square.author")}</dt>
              <dd>{selected.item.author.name}</dd>
              <dt>{t("square.license")}</dt>
              <dd>{selected.item.license}</dd>
              <dt>{t("square.type")}</dt>
              <dd>{t(`square.kinds.${selected.item.kind}`)}</dd>
              <dt>{t("square.category")}</dt>
              <dd>
                {selectedCategory === undefined
                  ? selected.item.categoryId
                  : localized(selectedCategory.name, i18n.language)}
              </dd>
              <dt>{t("square.commit")}</dt>
              <dd>
                <code>{selected.commit.slice(0, 12)}</code>
              </dd>
            </dl>
          </aside>
          <article className="square-readme">
            <MarkdownContent
              source={localized(selected.item.description, i18n.language)}
              codeBlockControls
            />
          </article>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
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
            disabled={busy}
            onClick={() => void refresh()}
          >
            <ArrowsClockwise size={17} /> {busy ? t("square.refreshing") : t("square.refresh")}
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
      <div className="square-category-strip">
        <button
          type="button"
          className={category === "all" ? "is-active" : undefined}
          onClick={() => setCategory("all")}
        >
          {t("square.allCategories")}
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
      {error ? <p className="form-error">{error}</p> : null}
      {catalog.sources.length === 0 ? (
        <SquareEmpty title={t("square.noSources")} description={t("square.noSourcesDescription")} />
      ) : items.length === 0 ? (
        <SquareEmpty title={t("square.empty")} description={t("square.emptyDescription")} />
      ) : (
        <div className="square-grid">
          {items.map((item) => (
            <button
              className="square-card"
              type="button"
              key={`${item.sourceId}:${item.kind}:${item.id}`}
              onClick={() => void open(item)}
            >
              {item.kind === "flow" ? (
                <span className="square-card-icon">
                  <Storefront size={22} />
                </span>
              ) : (
                <ExpertAvatar
                  avatarId={item.avatarId}
                  team={item.kind === "expert-team"}
                  size="md"
                />
              )}
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
            </button>
          ))}
        </div>
      )}
    </StudioScreenFrame>
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
