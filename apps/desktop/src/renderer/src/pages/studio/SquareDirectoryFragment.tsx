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
  DesktopSquarePackageDetail,
} from "../../../../shared/contracts/index.ts";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export function SquareDirectoryFragment(props: {
  readonly onInstall: (sourcePath: string) => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [catalog, setCatalog] = useState<DesktopSquareCatalog>({ packages: [], sources: [] });
  const [selected, setSelected] = useState<DesktopSquarePackageDetail | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
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
    () => [...new Set(catalog.packages.flatMap((item) => item.categories))].toSorted(),
    [catalog.packages],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const packages = catalog.packages.filter((item) => {
    const searchable = [
      localized(item.name, i18n.language),
      localized(item.summary, i18n.language),
      item.publisher.name,
      ...item.tags,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      (category === "all" || item.categories.includes(category)) &&
      searchable.includes(normalizedQuery)
    );
  });

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

  const open = async (item: DesktopSquareCatalog["packages"][number]) => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.getSquarePackage({ sourceId: item.sourceId, packageId: item.id });
      setSelected(detail);
      setVersion(detail.package.channels.stable);
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
        packageId: selected.package.id,
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
              <h1 id="square-detail-heading">{localized(selected.package.name, i18n.language)}</h1>
              <p>{localized(selected.package.summary, i18n.language)}</p>
            </div>
            <div className="square-install-controls">
              <SelectMenu
                ariaLabel={t("square.version")}
                className="square-version-select"
                value={version}
                options={selected.package.versions.map((item) => ({
                  value: item.version,
                  label: item.version,
                }))}
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
              <dt>{t("square.publisher")}</dt>
              <dd>{selected.package.publisher.name}</dd>
              <dt>{t("square.license")}</dt>
              <dd>{selected.package.license}</dd>
              <dt>{t("square.category")}</dt>
              <dd>{selected.package.primaryCategory}</dd>
              <dt>{t("square.commit")}</dt>
              <dd>
                <code>{selected.commit.slice(0, 12)}</code>
              </dd>
            </dl>
          </aside>
          <article className="square-readme">
            <MarkdownContent source={selected.readme} codeBlockControls />
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
          className="square-category-select"
          ariaLabel={t("square.category")}
          value={category}
          options={[
            { value: "all", label: t("square.allCategories") },
            ...categories.map((item) => ({ value: item, label: item })),
          ]}
          onChange={setCategory}
        />
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {catalog.sources.length === 0 ? (
        <div className="square-empty">
          <Storefront size={36} />
          <strong>{t("square.noSources")}</strong>
          <p>{t("square.noSourcesDescription")}</p>
        </div>
      ) : packages.length === 0 ? (
        <div className="square-empty">
          <Storefront size={36} />
          <strong>{t("square.empty")}</strong>
          <p>{t("square.emptyDescription")}</p>
        </div>
      ) : (
        <div className="square-grid">
          {packages.map((item) => (
            <button
              className="square-card"
              type="button"
              key={`${item.sourceId}:${item.id}`}
              onClick={() => void open(item)}
            >
              <span className="square-card-icon">
                <Storefront size={22} />
              </span>
              <strong>{localized(item.name, i18n.language)}</strong>
              <p>{localized(item.summary, i18n.language)}</p>
              <small>
                {item.sourceOfficial ? <SealCheck size={14} /> : null}
                {item.sourceName} · {item.stable.version}
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

function localized(
  value: DesktopSquareCatalog["packages"][number]["name"],
  locale: string,
): string {
  if (locale === "en" || locale === "zh-Hans" || locale === "zh-Hant") {
    return value.translations?.[locale] ?? value.default;
  }
  return value.default;
}
