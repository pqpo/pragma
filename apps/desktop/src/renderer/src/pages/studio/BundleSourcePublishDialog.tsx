import {
  CheckCircle,
  GitBranch,
  Package,
  SlidersHorizontal,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { BundleSourceSemverSchema, BundleSourceSlugSchema } from "@pragma/shared";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import type {
  BundleSourcePublicationPreparation,
  BundleSourcePublicationResult,
  PragmaBundleModuleOptions,
  PublishBundleSource,
} from "../../../../shared/contracts/index.ts";
import {
  PublishBundleSourceSchema,
  bundleSourcePublicationSummary,
  normalizeBundleSourcePublicationTag,
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
  const [tagInput, setTagInput] = useState("");
  const [fieldErrors, setFieldErrors] = useState<PublicationFieldErrors>({});
  const [results, setResults] = useState<BundleSourcePublicationResult["results"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

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
        setTagInput("");
        setFieldErrors({});
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
    const identity = publicationItemIdForSelection(
      preparation.sources,
      new Set(requestedTargets.map((target) => target.sourceId)),
      metadata.itemId,
    );
    if (identity.conflict) {
      setError(t("bundlePublish.validation.itemIdConflict"));
      return;
    }
    const pendingTag = pendingPublicationTags(metadata.tags, tagInput);
    const nextMetadata = {
      ...metadata,
      itemId: identity.itemId,
      summary: bundleSourcePublicationSummary(metadata.description),
      tags: pendingTag.tags,
    };
    const nextFieldErrors = validatePublicationFields(version, nextMetadata, pendingTag.error);
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError(t("bundlePublish.validation.form"));
      focusFirstInvalidField(formRef.current, nextFieldErrors);
      return;
    }
    const request = PublishBundleSourceSchema.safeParse({
      rootRef: props.rootRef,
      projectRevision: props.projectRevision,
      modules,
      metadata: nextMetadata,
      targets: requestedTargets,
    });
    if (!request.success) {
      setError(t("bundlePublish.validation.form"));
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const published = await window.pragmaDesktop.publishBundleSource(request.data);
      setResults((current) => {
        if (current === null || !retryFailed) return published.results;
        const replacements = new Map(published.results.map((result) => [result.sourceId, result]));
        return current.map((result) => replacements.get(result.sourceId) ?? result);
      });
    } catch (cause) {
      setError(publicationErrorMessage(cause, t("bundlePublish.validation.form")));
    } finally {
      setBusy(false);
    }
  };

  const updateSourceSelection = (sourceId: string, checked: boolean) => {
    setError(null);
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
  const invalid = metadata === null || targets.length === 0;
  const moduleKeys = preparation === null ? [] : publicationModuleKeys();

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
          ref={formRef}
          id="bundle-publish-form"
          className="bundle-publish-form"
          noValidate
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
                          onChange={(categoryId) => {
                            setError(null);
                            setCategories((current) => ({
                              ...current,
                              [source.source.id]: categoryId,
                            }));
                          }}
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
                    field="name"
                    label={t("bundlePublish.name")}
                    value={metadata.name}
                    disabled={busy}
                    error={fieldErrors.name}
                    onChange={(name) => {
                      setMetadata({ ...metadata, name });
                      setError(null);
                      clearFieldError("name", setFieldErrors);
                    }}
                  />
                  <PublishField
                    field="version"
                    label={t("bundlePublish.version")}
                    value={version}
                    disabled={busy}
                    error={fieldErrors.version}
                    onChange={(value) => {
                      setVersion(value);
                      setVersionEdited(true);
                      setError(null);
                      clearFieldError("version", setFieldErrors);
                    }}
                  />
                  <PublishField
                    field="authorName"
                    label={t("bundlePublish.author")}
                    value={metadata.authorName}
                    disabled={busy}
                    error={fieldErrors.authorName}
                    onChange={(authorName) => {
                      setMetadata({ ...metadata, authorName });
                      setError(null);
                      clearFieldError("authorName", setFieldErrors);
                    }}
                  />
                  <PublishField
                    field="license"
                    label={t("bundlePublish.license")}
                    value={metadata.license}
                    disabled={busy}
                    error={fieldErrors.license}
                    onChange={(license) => {
                      setMetadata({ ...metadata, license });
                      setError(null);
                      clearFieldError("license", setFieldErrors);
                    }}
                  />
                  <label className="bundle-publish-wide" data-publish-label="description">
                    <span>{t("bundlePublish.descriptionLabel")}</span>
                    <textarea
                      data-publish-field="description"
                      value={metadata.description}
                      disabled={busy}
                      aria-invalid={fieldErrors.description === undefined ? undefined : true}
                      aria-describedby={
                        fieldErrors.description === undefined
                          ? undefined
                          : "bundle-publish-description-error"
                      }
                      onChange={(event) => {
                        setMetadata({ ...metadata, description: event.target.value });
                        setError(null);
                        clearFieldError("description", setFieldErrors);
                      }}
                    />
                    {fieldErrors.description === undefined ? null : (
                      <small
                        id="bundle-publish-description-error"
                        className="bundle-publish-field-error"
                        role="alert"
                      >
                        {publicationFieldError(fieldErrors.description, t)}
                      </small>
                    )}
                  </label>
                  <label className="bundle-publish-wide" data-publish-label="tags">
                    <span>{t("bundlePublish.tags")}</span>
                    <div
                      className="bundle-publish-tag-editor"
                      aria-invalid={fieldErrors.tags === undefined ? undefined : true}
                    >
                      {metadata.tags.map((tag, index) => (
                        <span className="bundle-publish-tag" key={`${tag}:${index}`}>
                          {tag}
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={t("bundlePublish.removeTag", { tag })}
                            onClick={() => {
                              setMetadata({
                                ...metadata,
                                tags: metadata.tags.filter((candidate) => candidate !== tag),
                              });
                              setError(null);
                              clearFieldError("tags", setFieldErrors);
                            }}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </span>
                      ))}
                      <input
                        data-publish-field="tags"
                        value={tagInput}
                        disabled={busy}
                        aria-label={t("bundlePublish.tags")}
                        aria-invalid={fieldErrors.tags === undefined ? undefined : true}
                        aria-describedby={
                          fieldErrors.tags === undefined ? undefined : "bundle-publish-tags-error"
                        }
                        onChange={(event) => {
                          setTagInput(event.target.value);
                          setError(null);
                          clearFieldError("tags", setFieldErrors);
                        }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                            return;
                          if (event.key === "Enter" || event.key === ",") {
                            event.preventDefault();
                            const pending = pendingPublicationTags(metadata.tags, tagInput);
                            if (pending.error === undefined) {
                              setMetadata({ ...metadata, tags: pending.tags });
                              setTagInput("");
                              clearFieldError("tags", setFieldErrors);
                            } else {
                              const tagError = pending.error;
                              setFieldErrors((current) => ({ ...current, tags: tagError }));
                            }
                          } else if (
                            event.key === "Backspace" &&
                            tagInput === "" &&
                            metadata.tags.length > 0
                          ) {
                            setMetadata({ ...metadata, tags: metadata.tags.slice(0, -1) });
                          }
                        }}
                      />
                    </div>
                    {fieldErrors.tags === undefined ? null : (
                      <small
                        id="bundle-publish-tags-error"
                        className="bundle-publish-field-error"
                        role="alert"
                      >
                        {publicationFieldError(fieldErrors.tags, t)}
                      </small>
                    )}
                  </label>
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
                  {moduleKeys.map((key) => {
                    const disabled = publicationModuleDisabled(preparation, key);
                    return (
                      <label className={disabled ? "is-disabled" : undefined} key={key}>
                        <span>
                          <strong>{t(`bundlePublish.module.${key}`)}</strong>
                          <small>
                            {disabled
                              ? t(
                                  key === "knowledgeBases" &&
                                    preparation.root.kind === "knowledge-base"
                                    ? "bundlePublish.moduleHint.rootKnowledgeBase"
                                    : "bundlePublish.moduleHint.unavailable",
                                )
                              : t(`bundlePublish.moduleHint.${key}`)}
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={modules[key]}
                          disabled={busy || disabled}
                          onChange={(event) =>
                            setModules({ ...modules, [key]: event.target.checked })
                          }
                        />
                      </label>
                    );
                  })}
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
  readonly field: PublicationField;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly error?: PublicationValidationIssue | undefined;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  const errorId = `bundle-publish-${props.field}-error`;
  return (
    <label data-publish-label={props.field}>
      <span>{props.label}</span>
      <input
        data-publish-field={props.field}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.error === undefined ? undefined : true}
        aria-describedby={props.error === undefined ? undefined : errorId}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.error === undefined ? null : (
        <small id={errorId} className="bundle-publish-field-error" role="alert">
          {publicationFieldError(props.error, t)}
        </small>
      )}
    </label>
  );
}

type PublicationField = "version" | "name" | "description" | "authorName" | "license" | "tags";
type PublicationValidationIssue =
  | {
      readonly code: "required";
      readonly field: "name" | "description" | "author" | "license" | "version";
    }
  | {
      readonly code: "tooLong";
      readonly field: "name" | "description" | "author" | "license" | "version" | "tag";
      readonly limit: number;
    }
  | { readonly code: "invalidVersion" }
  | { readonly code: "invalidTag" }
  | { readonly code: "duplicateTag" }
  | { readonly code: "tooManyTags"; readonly limit: number };
type PublicationFieldErrors = Partial<Record<PublicationField, PublicationValidationIssue>>;

const FIELD_LIMITS = {
  version: 100,
  name: 200,
  description: 8_000,
  authorName: 200,
  license: 100,
  tag: 80,
  tags: 30,
} as const;

export function validatePublicationFields(
  version: string,
  metadata: PublishBundleSource["metadata"],
  pendingTagError?: PublicationValidationIssue,
): PublicationFieldErrors {
  const errors: PublicationFieldErrors = {};
  validateRequiredText("name", metadata.name, FIELD_LIMITS.name, errors);
  validateRequiredText("description", metadata.description, FIELD_LIMITS.description, errors);
  validateRequiredText("authorName", metadata.authorName, FIELD_LIMITS.authorName, errors);
  validateRequiredText("license", metadata.license, FIELD_LIMITS.license, errors);
  if (version.trim() === "") errors.version = { code: "required", field: "version" };
  else if (version.length > FIELD_LIMITS.version)
    errors.version = { code: "tooLong", field: "version", limit: FIELD_LIMITS.version };
  else if (!BundleSourceSemverSchema.safeParse(version).success)
    errors.version = { code: "invalidVersion" };
  if (pendingTagError !== undefined) errors.tags = pendingTagError;
  else if (metadata.tags.length > FIELD_LIMITS.tags)
    errors.tags = { code: "tooManyTags", limit: FIELD_LIMITS.tags };
  else if (
    metadata.tags.some(
      (tag) => tag.length > FIELD_LIMITS.tag || !BundleSourceSlugSchema.safeParse(tag).success,
    )
  )
    errors.tags = { code: "invalidTag" };
  else if (new Set(metadata.tags).size !== metadata.tags.length)
    errors.tags = { code: "duplicateTag" };
  return errors;
}

function validateRequiredText(
  field: Exclude<PublicationField, "version" | "tags">,
  value: string,
  limit: number,
  errors: PublicationFieldErrors,
): void {
  const label = field === "authorName" ? "author" : field;
  if (value.trim() === "") errors[field] = { code: "required", field: label };
  else if (value.length > limit) errors[field] = { code: "tooLong", field: label, limit };
}

export function normalizePublicationTag(value: string): string {
  return normalizeBundleSourcePublicationTag(value);
}

export function pendingPublicationTags(
  tags: readonly string[],
  input: string,
): { readonly tags: string[]; readonly error?: PublicationValidationIssue | undefined } {
  if (input.trim() === "") return { tags: [...tags] };
  const normalized = normalizePublicationTag(input);
  if (normalized.length > FIELD_LIMITS.tag)
    return {
      tags: [...tags],
      error: { code: "tooLong", field: "tag", limit: FIELD_LIMITS.tag },
    };
  if (!BundleSourceSlugSchema.safeParse(normalized).success)
    return {
      tags: [...tags],
      error: { code: "invalidTag" },
    };
  if (tags.includes(normalized)) return { tags: [...tags], error: { code: "duplicateTag" } };
  if (tags.length >= FIELD_LIMITS.tags)
    return { tags: [...tags], error: { code: "tooManyTags", limit: FIELD_LIMITS.tags } };
  return { tags: [...tags, normalized] };
}

export function publicationItemIdForSelection(
  sources: readonly {
    readonly source: { readonly id: string };
    readonly existingItem?: { readonly id: string } | undefined;
  }[],
  selected: ReadonlySet<string>,
  fallback: string,
): { readonly itemId: string; readonly conflict: boolean } {
  const existingIds = new Set(
    sources.flatMap((source) =>
      selected.has(source.source.id) && source.existingItem !== undefined
        ? [source.existingItem.id]
        : [],
    ),
  );
  return {
    itemId: existingIds.values().next().value ?? fallback,
    conflict: existingIds.size > 1,
  };
}

export function publicationModuleKeys(): Array<keyof PragmaBundleModuleOptions> {
  return ["capabilities", "plugins", "knowledgeBases", "flowLayouts"];
}

export function publicationModuleDisabled(
  preparation: BundleSourcePublicationPreparation,
  key: keyof PragmaBundleModuleOptions,
): boolean {
  return (
    preparation.moduleCounts[key] === 0 ||
    (key === "knowledgeBases" && preparation.root.kind === "knowledge-base")
  );
}

function focusFirstInvalidField(
  form: HTMLFormElement | null,
  errors: PublicationFieldErrors,
): void {
  const first = (["name", "version", "authorName", "license", "description", "tags"] as const).find(
    (field) => errors[field] !== undefined,
  );
  if (first === undefined) return;
  queueMicrotask(() =>
    form?.querySelector<HTMLElement>(`[data-publish-field="${first}"]`)?.focus(),
  );
}

function clearFieldError(
  field: PublicationField,
  update: Dispatch<SetStateAction<PublicationFieldErrors>>,
): void {
  update((current) => {
    if (current[field] === undefined) return current;
    const next = { ...current };
    delete next[field];
    return next;
  });
}

function publicationFieldError(
  issue: PublicationValidationIssue | undefined,
  t: TFunction<"studio">,
): string | undefined {
  if (issue === undefined) return undefined;
  if (issue.code === "required")
    return t("bundlePublish.validation.required", {
      field: t(`bundlePublish.validation.field.${issue.field}`),
    });
  if (issue.code === "tooLong")
    return t("bundlePublish.validation.tooLong", {
      field: t(`bundlePublish.validation.field.${issue.field}`),
      count: issue.limit,
    });
  if (issue.code === "invalidVersion") return t("bundlePublish.validation.invalidVersion");
  if (issue.code === "invalidTag") return t("bundlePublish.validation.invalidTag");
  if (issue.code === "duplicateTag") return t("bundlePublish.validation.duplicateTag");
  return t("bundlePublish.validation.tooManyTags", { count: issue.limit });
}

function publicationErrorMessage(error: unknown, invalidFormMessage: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === "invalid_request") ||
      ("name" in error && error.name === "ZodError"))
  ) {
    return invalidFormMessage;
  }
  return errorMessage(error);
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
