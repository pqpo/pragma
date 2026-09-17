import {
  CheckCircle,
  GitBranch,
  Package,
  SlidersHorizontal,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  BundleSourcePublicationPreparation,
  BundleSourcePublicationResult,
  PragmaBundleModuleOptions,
  PublishBundleSource,
} from "../../../../shared/contracts/index.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";

export function BundleSourcePublishDialog(props: {
  readonly rootRef: string;
  readonly projectRevision: number;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("studio");
  const [preparation, setPreparation] = useState<BundleSourcePublicationPreparation | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [version, setVersion] = useState("1.0.0");
  const [versionEdited, setVersionEdited] = useState(false);
  const [metadata, setMetadata] = useState<PublishBundleSource["metadata"] | null>(null);
  const [modules, setModules] = useState<PragmaBundleModuleOptions | null>(null);
  const [results, setResults] = useState<BundleSourcePublicationResult["results"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.pragmaDesktop
      .prepareBundleSourcePublication({
        rootRef: props.rootRef,
        projectRevision: props.projectRevision,
      })
      .then((prepared) => {
        if (cancelled) return;
        setPreparation(prepared);
        setMetadata(prepared.metadata);
        setModules(prepared.modules);
        const initialSelection = initialPublicationSourceSelection(prepared.sources);
        setSelected(initialSelection);
        setCategories(
          Object.fromEntries(
            prepared.sources.map((source) => [
              source.source.id,
              source.existingItem?.categoryId ?? source.categories[0]?.id ?? "",
            ]),
          ),
        );
        setVersion(
          nextPatchVersion(publicationVersionsForSelection(prepared.sources, initialSelection)),
        );
        setVersionEdited(false);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.projectRevision, props.rootRef]);

  const targets = useMemo(
    () =>
      preparation?.sources.flatMap((source) =>
        selected.has(source.source.id) && categories[source.source.id]
          ? [
              {
                sourceId: source.source.id,
                categoryId: categories[source.source.id]!,
                version,
              },
            ]
          : [],
      ) ?? [],
    [categories, preparation, selected, version],
  );

  const publish = async (retryFailed = false) => {
    if (preparation === null || metadata === null || modules === null) return;
    const requestedTargets = retryFailed
      ? targets.filter((target) =>
          results?.some(
            (result) => result.sourceId === target.sourceId && result.status === "failed",
          ),
        )
      : targets;
    if (requestedTargets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const published = await window.pragmaDesktop.publishBundleSource({
        rootRef: props.rootRef,
        projectRevision: props.projectRevision,
        modules,
        metadata,
        targets: requestedTargets,
      });
      setResults((current) => {
        if (current === null || !retryFailed) return published.results;
        const replacements = new Map(published.results.map((result) => [result.sourceId, result]));
        return current.map((result) => replacements.get(result.sourceId) ?? result);
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const updateSourceSelection = (sourceId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(sourceId);
      else next.delete(sourceId);
      if (!versionEdited && preparation !== null) {
        setVersion(nextPatchVersion(publicationVersionsForSelection(preparation.sources, next)));
      }
      return next;
    });
  };

  const failed = results?.filter((result) => result.status === "failed") ?? [];
  const itemIdentityLocked =
    preparation?.sources.some(
      (source) => selected.has(source.source.id) && source.existingItem !== undefined,
    ) ?? false;
  const invalid =
    metadata === null ||
    metadata.itemId.trim() === "" ||
    metadata.name.trim() === "" ||
    metadata.summary.trim() === "" ||
    metadata.description.trim() === "" ||
    metadata.authorName.trim() === "" ||
    metadata.license.trim() === "" ||
    targets.length === 0;

  return (
    <Dialog
      className="bundle-publish-dialog"
      title={t("bundlePublish.title")}
      description={
        preparation === null
          ? t("bundlePublish.loading")
          : t("bundlePublish.description", { name: preparation.root.name })
      }
      busy={busy}
      onCancel={props.onClose}
      footer={
        <>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            {results === null ? t("cancel") : t("close")}
          </button>
          {results === null ? (
            <button
              className="primary-button"
              type="submit"
              form="bundle-publish-form"
              disabled={busy || invalid}
            >
              {busy ? <SpinnerGap className="spin" size={17} /> : <GitBranch size={17} />}
              {busy ? t("bundlePublish.publishing") : t("bundlePublish.publish")}
            </button>
          ) : failed.length > 0 ? (
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void publish(true)}
            >
              {busy ? <SpinnerGap className="spin" size={17} /> : null}
              {t("bundlePublish.retryFailed", { count: failed.length })}
            </button>
          ) : null}
        </>
      }
    >
      {results === null ? (
        <form
          id="bundle-publish-form"
          className="bundle-publish-form"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          {preparation === null || metadata === null || modules === null ? (
            <div className="bundle-publish-loading" role="status">
              <SpinnerGap className="spin" size={22} aria-hidden="true" />
              <span>{t("bundlePublish.loading")}</span>
            </div>
          ) : (
            <>
              <div className="bundle-publish-summary">
                <span className="bundle-publish-summary-icon">
                  <Package size={24} aria-hidden="true" />
                </span>
                <div>
                  <small>{t("bundlePublish.publishObject")}</small>
                  <strong>{preparation.root.name}</strong>
                  <code>{preparation.root.ref}</code>
                </div>
                <span className="bundle-publish-version-chip">v{version}</span>
              </div>

              <section className="bundle-publish-section" aria-labelledby="publish-sources-title">
                <header className="bundle-publish-section-header">
                  <span>
                    <GitBranch size={18} aria-hidden="true" />
                  </span>
                  <div>
                    <h3 id="publish-sources-title">{t("bundlePublish.sources")}</h3>
                    <p>{t("bundlePublish.sourcesHint")}</p>
                  </div>
                  <em>{t("bundlePublish.selectedCount", { count: selected.size })}</em>
                </header>
                <div className="bundle-publish-source-list">
                  {preparation.sources.length === 0 ? (
                    <p className="bundle-publish-empty">{t("bundlePublish.noSources")}</p>
                  ) : null}
                  {preparation.sources.map((source) => (
                    <div
                      className={`bundle-publish-source${selected.has(source.source.id) ? " is-selected" : ""}`}
                      key={source.source.id}
                    >
                      <label className="bundle-publish-source-choice">
                        <input
                          type="checkbox"
                          disabled={!source.selectable || busy}
                          checked={selected.has(source.source.id)}
                          onChange={(event) =>
                            updateSourceSelection(source.source.id, event.target.checked)
                          }
                        />
                        <span>
                          <span className="bundle-publish-source-title">
                            <strong>{source.source.name}</strong>
                            {source.source.official ? <em>{t("bundlePublish.official")}</em> : null}
                            <em>
                              {t(
                                source.existingItem === undefined
                                  ? "bundlePublish.newItem"
                                  : "bundlePublish.existingItem",
                              )}
                            </em>
                          </span>
                          <small>{source.unavailableReason ?? source.source.remote}</small>
                        </span>
                      </label>
                      <div className="bundle-publish-category-field">
                        <span>{t("bundlePublish.category")}</span>
                        <SelectMenu
                          className="bundle-publish-category"
                          ariaLabel={t("bundlePublish.categoryFor", { name: source.source.name })}
                          disabled={
                            !selected.has(source.source.id) ||
                            source.existingItem !== undefined ||
                            busy
                          }
                          value={categories[source.source.id] ?? ""}
                          onChange={(categoryId) =>
                            setCategories((current) => ({
                              ...current,
                              [source.source.id]: categoryId,
                            }))
                          }
                          options={source.categories.map((category) => ({
                            value: category.id,
                            label: category.name.default,
                          }))}
                        />
                      </div>
                    </div>
                  ))}
                  {preparation.sources.length > 0 &&
                  !preparation.sources.some((source) => source.selectable) ? (
                    <p className="bundle-publish-empty">{t("bundlePublish.noEligibleSources")}</p>
                  ) : null}
                </div>
              </section>

              <section className="bundle-publish-section" aria-labelledby="publish-details-title">
                <header className="bundle-publish-section-header">
                  <span>
                    <SlidersHorizontal size={18} aria-hidden="true" />
                  </span>
                  <div>
                    <h3 id="publish-details-title">{t("bundlePublish.details")}</h3>
                    <p>{t("bundlePublish.detailsHint")}</p>
                  </div>
                </header>
                <div className="bundle-publish-grid">
                  <PublishField
                    label={t("bundlePublish.itemId")}
                    value={metadata.itemId}
                    disabled={busy || itemIdentityLocked}
                    onChange={(itemId) => setMetadata({ ...metadata, itemId })}
                  />
                  <PublishField
                    label={t("bundlePublish.version")}
                    value={version}
                    disabled={busy}
                    onChange={(value) => {
                      setVersion(value);
                      setVersionEdited(true);
                    }}
                  />
                  <PublishField
                    label={t("bundlePublish.name")}
                    value={metadata.name}
                    disabled={busy}
                    onChange={(name) => setMetadata({ ...metadata, name })}
                  />
                  <PublishField
                    label={t("bundlePublish.summary")}
                    value={metadata.summary}
                    disabled={busy}
                    onChange={(summary) => setMetadata({ ...metadata, summary })}
                  />
                  <PublishField
                    label={t("bundlePublish.author")}
                    value={metadata.authorName}
                    disabled={busy}
                    onChange={(authorName) => setMetadata({ ...metadata, authorName })}
                  />
                  <PublishField
                    label={t("bundlePublish.license")}
                    value={metadata.license}
                    disabled={busy}
                    onChange={(license) => setMetadata({ ...metadata, license })}
                  />
                  <label className="bundle-publish-wide">
                    <span>{t("bundlePublish.descriptionLabel")}</span>
                    <textarea
                      value={metadata.description}
                      disabled={busy}
                      onChange={(event) =>
                        setMetadata({ ...metadata, description: event.target.value })
                      }
                    />
                  </label>
                  <PublishField
                    label={t("bundlePublish.tags")}
                    value={metadata.tags.join(", ")}
                    disabled={busy}
                    onChange={(tags) =>
                      setMetadata({
                        ...metadata,
                        tags: tags
                          .split(",")
                          .map((tag) => tag.trim())
                          .filter(Boolean),
                      })
                    }
                    wide
                  />
                </div>
              </section>

              <section className="bundle-publish-section" aria-labelledby="publish-modules-title">
                <header className="bundle-publish-section-header">
                  <span>
                    <Package size={18} aria-hidden="true" />
                  </span>
                  <div>
                    <h3 id="publish-modules-title">{t("bundlePublish.modules")}</h3>
                    <p>{t("bundlePublish.modulesHint")}</p>
                  </div>
                </header>
                <div className="bundle-publish-modules">
                  {(["capabilities", "plugins", "knowledgeBases", "flowLayouts"] as const).map(
                    (key) => (
                      <label key={key}>
                        <span>
                          <strong>{t(`bundlePublish.module.${key}`)}</strong>
                          <small>{t(`bundlePublish.moduleHint.${key}`)}</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={modules[key]}
                          disabled={busy}
                          onChange={(event) =>
                            setModules({ ...modules, [key]: event.target.checked })
                          }
                        />
                      </label>
                    ),
                  )}
                </div>
              </section>
            </>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="bundle-publish-results">
          {results.map((result) => (
            <article key={result.sourceId} className={`is-${result.status}`}>
              {result.status === "failed" ? <WarningCircle size={20} /> : <CheckCircle size={20} />}
              <div>
                <strong>{result.sourceName}</strong>
                <p>
                  {result.status === "failed"
                    ? result.errorMessage
                    : t(`bundlePublish.result.${result.status}`, { version: result.version })}
                </p>
                {result.commit ? <code>{result.commit.slice(0, 12)}</code> : null}
              </div>
            </article>
          ))}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function PublishField(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly wide?: boolean | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={props.wide ? "bundle-publish-wide" : undefined}>
      <span>{props.label}</span>
      <input
        value={props.value}
        disabled={props.disabled}
        required
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function nextPatchVersion(versions: readonly string[]): string {
  const parsed = versions
    .map((version) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(version))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const)
    .toSorted((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
  const latest = parsed.at(-1);
  return latest === undefined ? "1.0.0" : `${latest[0]}.${latest[1]}.${latest[2] + 1}`;
}

export function initialPublicationSourceSelection(
  sources: readonly { readonly selectable: boolean; readonly source: { readonly id: string } }[],
): Set<string> {
  const eligible = sources.filter((source) => source.selectable);
  return new Set(eligible.length === 1 ? [eligible[0]!.source.id] : []);
}

export function publicationVersionsForSelection(
  sources: readonly {
    readonly source: { readonly id: string };
    readonly existingItem?: { readonly versions: readonly string[] } | undefined;
  }[],
  selected: ReadonlySet<string>,
): string[] {
  return sources.flatMap((source) =>
    selected.has(source.source.id) ? [...(source.existingItem?.versions ?? [])] : [],
  );
}

export { nextPatchVersion };
