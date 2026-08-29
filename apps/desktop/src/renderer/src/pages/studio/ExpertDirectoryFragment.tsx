import {
  ArrowLeft,
  ArrowCounterClockwise,
  BookOpenText,
  CaretRight,
  Database,
  Info,
  Folder,
  MagnifyingGlass,
  Network,
  PencilSimple,
  PuzzlePiece,
  Play,
  Plus,
  Trash,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";

import type {
  Capability,
  ContextStore,
  DesktopPlugin,
  DesktopRuntimeAvailability,
} from "../../../../shared/contracts/index.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import {
  MemoryStoreBrowser,
  type ContextStoreBrowserSource,
} from "../../components/MemoryStoreBrowser.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { ProfiledExpertAvatar } from "../../components/ProfiledExpertAvatar.tsx";
import { isBuiltInExpert, type ExpertRecord } from "./studio-model.ts";
import { errorMessage } from "../../lib/errors.ts";
import { runtimeDisplayName } from "../../lib/runtime-display.ts";
import {
  BUILT_IN_PRAGMA_EXPERT_REF,
  BUILT_IN_STORE_REVISION_EXPERT_REF,
  localizeSystemExpertCopy,
} from "../../lib/system-expert-copy.ts";

const DESCRIPTION_PREVIEW_LENGTH = 200;
const PINNED_EXPERT_REFS = [
  BUILT_IN_PRAGMA_EXPERT_REF,
  BUILT_IN_STORE_REVISION_EXPERT_REF,
] as const;

function expertDirectoryRank(ref: string | undefined): number {
  const rank = PINNED_EXPERT_REFS.findIndex((candidate) => candidate === ref);
  return rank === -1 ? PINNED_EXPERT_REFS.length : rank;
}

function truncateText(value: string, maximumLength: number): string {
  const normalized = value.trim();
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength).trimEnd()}…`
    : normalized;
}

export function ExpertDirectoryFragment(props: {
  readonly experts: readonly ExpertRecord[];
  readonly onCreate: () => void;
  readonly onOpen: (expert: ExpertRecord) => void;
}) {
  const { t } = useTranslation("studio");
  const { t: tCommon } = useTranslation("common");
  const [query, setQuery] = useState("");
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const matchingExperts = props.experts
    .map((expert) => ({ expert, copy: localizeSystemExpertCopy(expert, pragmaCopy) }))
    .filter(({ expert, copy }) =>
      `${copy.name} ${copy.description} ${expert.tags.join(" ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .toSorted(
      (left, right) => expertDirectoryRank(left.expert.ref) - expertDirectoryRank(right.expert.ref),
    );

  return (
    <StudioScreenFrame
      className="expert-directory"
      labelledBy="experts-heading"
      header={
        <header className="studio-heading expert-directory-heading">
          <div>
            <h1 id="experts-heading">{t("experts")}</h1>
            <p>{t("expertsDescription")}</p>
          </div>
          <button className="primary-button" type="button" onClick={props.onCreate}>
            <Plus size={17} aria-hidden="true" />
            {t("createExpert")}
          </button>
        </header>
      }
    >
      <div className="directory-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">{t("searchExperts")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchExperts")}
          />
        </label>
      </div>

      <div className="expert-grid" role="list" aria-label={t("availableExperts")}>
        {matchingExperts.map(({ expert, copy }) => {
          return (
            <article
              className="expert-card-shell"
              key={expert.ref ?? `expert:${expert.id}`}
              role="listitem"
            >
              <button className="expert-card" type="button" onClick={() => props.onOpen(expert)}>
                <span className="expert-card-header">
                  <span className="expert-card-icon" aria-hidden="true">
                    <ProfiledExpertAvatar avatarId={expert.avatarId} size="md" />
                  </span>
                  <span className="expert-card-identity">
                    <span className="expert-card-title-row">
                      <strong>{copy.name}</strong>
                      {isBuiltInExpert(expert) ? (
                        <em className="expert-source-chip">{t("builtIn")}</em>
                      ) : null}
                    </span>
                    <code>{expert.ref ?? `expert:${expert.id}`}</code>
                  </span>
                  <CaretRight className="expert-card-action" size={18} aria-hidden="true" />
                </span>
                <span className="expert-card-description">{copy.description}</span>
                <span className="expert-card-scope">
                  <small>{t("scope")}</small>
                  <span>{copy.scope}</span>
                </span>
                {expert.tags.length > 0 ? (
                  <span className="expert-card-tags" aria-label={t("tags")}>
                    {expert.tags.slice(0, 3).map((tag) => (
                      <em key={tag}>{tag}</em>
                    ))}
                    {expert.tags.length > 3 ? <em>+{expert.tags.length - 3}</em> : null}
                  </span>
                ) : null}
              </button>
            </article>
          );
        })}
        {matchingExperts.length === 0 ? (
          <p className="studio-empty-copy">
            {query.trim() ? t("noMatchesFound") : t("noExpertsAvailable")}
          </p>
        ) : null}
      </div>
      <p className="directory-count">{t("expertCount", { count: matchingExperts.length })}</p>
    </StudioScreenFrame>
  );
}

function ExpertCapabilityDetailRow(props: {
  readonly icon: Icon;
  readonly title: string;
  readonly selected: ReactNode;
}) {
  const CapabilityIcon = props.icon;
  return (
    <article className="expert-capability-detail-row">
      <span className="expert-capability-detail-icon" aria-hidden="true">
        <CapabilityIcon size={19} />
      </span>
      <div className="expert-capability-detail-copy">
        <h3>{props.title}</h3>
        <div className="expert-capability-detail-selection">{props.selected}</div>
      </div>
    </article>
  );
}

export function ExpertDetailFragment(props: {
  readonly expert: ExpertRecord;
  readonly contextStores: readonly ContextStore[];
  readonly capabilities: readonly Capability[];
  readonly plugins: readonly DesktopPlugin[];
  readonly resources: readonly PragmaResource[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly backLabel?: string | undefined;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onOpenContextStore: (store: ContextStore) => void;
  readonly onTryInSession: () => void;
  readonly onDelete: () => Promise<void>;
  readonly onReset: () => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const { t: tCommon } = useTranslation("common");
  const copy = localizeSystemExpertCopy(props.expert, {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [memoryStoreOpen, setMemoryStoreOpen] = useState(false);
  const [memoryStoreHasContent, setMemoryStoreHasContent] = useState(false);
  const instructions = props.expert.instructions.trim();
  const additionalInstructions = props.expert.additionalInstructions.trim();
  const runtime = props.runtimes.find((item) => item.id === props.expert.model?.runtimeId);
  const runtimeName =
    runtime === undefined
      ? t(isBuiltInExpert(props.expert) ? "systemDefault" : "notConfigured")
      : runtimeDisplayName(tCommon, runtime);
  const modelName =
    props.expert.model?.modelId ??
    t(isBuiltInExpert(props.expert) ? "systemDefault" : "notConfigured");
  const selectedModel = runtime?.models?.find(
    (model) =>
      model.id === props.expert.model?.modelId &&
      model.provider.id === props.expert.model?.providerId,
  );
  const thinkingDepthName = (() => {
    if (props.expert.model === null) return t("systemDefault");
    const configuredLevel = props.expert.model.thinkingLevel;
    const thinking = selectedModel?.thinking;
    if (configuredLevel !== undefined) {
      return (
        thinking?.supportedLevels.find((level) => level.value === configuredLevel)?.label ??
        configuredLevel
      );
    }
    if (thinking?.defaultLevel !== undefined) {
      const defaultLevel =
        thinking.supportedLevels.find((level) => level.value === thinking.defaultLevel)?.label ??
        thinking.defaultLevel;
      return t("defaultThinkingDepth", { value: defaultLevel });
    }
    return t("runtimeDefault");
  })();
  const selectedResources = props.expert.resourceTools.map((binding) => {
    const resource = props.resources.find(
      (candidate) => canonicalPragmaResourceRef(candidate) === binding.target?.ref,
    );
    return resource?.metadata.name ?? binding.target?.ref ?? t("notConfigured");
  });
  const selectedSkills = props.expert.capabilities
    .filter((reference) => reference.kind === "skill")
    .map((reference) => {
      const capability = props.capabilities.find(
        (candidate) => candidate.manifest.id === reference.capabilityId,
      );
      return capability?.manifest.name ?? reference.capabilityId;
    });
  const selectedToolReferences = props.expert.capabilities.filter(
    (reference): reference is Extract<ExpertRecord["capabilities"][number], { kind: "tools" }> =>
      reference.kind === "tools",
  );
  const selectedTools = [
    ...(props.expert.persisted?.opaqueCapabilities ?? []).flatMap((capability) =>
      capability.kind === "tools"
        ? (capability.tools ?? []).map((name) => `${name} · ${t("fixedSystemTool")}`)
        : [],
    ),
    ...selectedToolReferences.flatMap((reference) => reference.toolNames),
  ];
  const selectedPlugins = props.expert.plugins.map(
    (reference) =>
      props.plugins.find((plugin) => plugin.ref === reference.ref)?.manifest.name ?? reference.ref,
  );
  const selectionList = (items: readonly string[]): ReactNode =>
    items.length === 0 ? (
      <span className="expert-capability-detail-empty">{t("noneSelected")}</span>
    ) : (
      <span className="expert-capability-detail-selection-text">{items.join("、")}</span>
    );
  const memoryStoreSource = useMemo<ContextStoreBrowserSource | undefined>(() => {
    if (props.expert.ref === undefined) return undefined;
    const target = { expertRef: props.expert.ref } as const;
    return {
      getDescriptor: async () => await window.pragmaDesktop.getExpertMemoryContextStore(target),
      list: async (scopeId) =>
        await window.pragmaDesktop.listExpertMemoryContextStoreEntries({ ...target, scopeId }),
      read: async (scopeId, id, start) =>
        await window.pragmaDesktop.readExpertMemoryContextStoreEntry({
          ...target,
          scopeId,
          id,
          start,
          maxBytes: 64_000,
        }),
      search: async (scopeId, query) =>
        await window.pragmaDesktop.searchExpertMemoryContextStore({
          ...target,
          scopeId,
          query,
          maxResults: 50,
          contextLines: 2,
        }),
    };
  }, [props.expert.ref]);
  useEffect(() => {
    let cancelled = false;
    setMemoryStoreHasContent(false);
    setMemoryStoreOpen(false);
    if (memoryStoreSource === undefined) return;
    void memoryStoreSource
      .getDescriptor()
      .then((descriptor) => {
        if (!cancelled) setMemoryStoreHasContent(descriptor.hasMemory === true);
      })
      .catch(() => {
        if (!cancelled) setMemoryStoreHasContent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [memoryStoreSource]);
  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDelete();
    } catch (cause) {
      setDeleteError(errorMessage(cause));
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };
  const reset = async () => {
    setResetting(true);
    setDeleteError(null);
    try {
      await props.onReset();
      setResetConfirmOpen(false);
    } catch (cause) {
      setDeleteError(errorMessage(cause));
      setResetConfirmOpen(false);
    } finally {
      setResetting(false);
    }
  };
  if (memoryStoreOpen && memoryStoreSource !== undefined) {
    return (
      <StudioScreenFrame
        className="expert-detail expert-memory-store-detail"
        header={
          <button className="back-link" type="button" onClick={() => setMemoryStoreOpen(false)}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backToContext")}
          </button>
        }
      >
        <MemoryStoreBrowser className="expert-memory-store-page" source={memoryStoreSource} />
      </StudioScreenFrame>
    );
  }
  return (
    <StudioScreenFrame
      className="expert-detail"
      labelledBy="expert-name"
      header={
        <button className="back-link" type="button" onClick={props.onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          {props.backLabel ?? t("backExperts")}
        </button>
      }
    >
      <header className="expert-detail-header">
        <ProfiledExpertAvatar avatarId={props.expert.avatarId} size="lg" />
        <div className="expert-detail-title">
          <div>
            <h1 id="expert-name">{copy.name}</h1>
          </div>
          <p>{truncateText(copy.description, DESCRIPTION_PREVIEW_LENGTH)}</p>
          <div className="expert-tag-list">
            {props.expert.tags.map((tag) => (
              <em key={tag}>{tag}</em>
            ))}
          </div>
        </div>
        <div className="detail-actions">
          {!props.expert.readOnly || isBuiltInExpert(props.expert) ? (
            <button className="primary-button" type="button" onClick={props.onEdit}>
              <PencilSimple size={17} aria-hidden="true" />
              {t(isBuiltInExpert(props.expert) ? "customizeBuiltInExpert" : "editExpert")}
            </button>
          ) : null}
          {isBuiltInExpert(props.expert) ? (
            <button
              className="secondary-button"
              type="button"
              disabled={!props.expert.customized}
              onClick={() => setResetConfirmOpen(true)}
            >
              <ArrowCounterClockwise size={17} aria-hidden="true" />
              {t("resetBuiltInExpert")}
            </button>
          ) : null}
          <button className="secondary-button" type="button" onClick={props.onTryInSession}>
            <Play size={17} aria-hidden="true" />
            {t("trySession")}
          </button>
          {!isBuiltInExpert(props.expert) ? (
            <button
              className="danger-button"
              type="button"
              onClick={() => {
                setDeleteError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash size={17} aria-hidden="true" />
              {t("deleteExpertAction")}
            </button>
          ) : null}
        </div>
      </header>
      {deleteError ? (
        <p className="form-error" role="alert">
          {deleteError}
        </p>
      ) : null}
      <section className="expert-runtime-summary" aria-label={t("runtime")}>
        <div>
          <small>{t("runtime")}</small>
          <strong>{runtimeName}</strong>
        </div>
        <div>
          <small>{t("model")}</small>
          <strong>{modelName}</strong>
        </div>
        <div>
          <small>{t("thinkingDepth")}</small>
          <strong>{thinkingDepthName}</strong>
        </div>
      </section>
      <div className="expert-detail-content">
        <section className="expert-scope" aria-labelledby="expert-scope-heading">
          <h2 id="expert-scope-heading">{t("scope")}</h2>
          <p>{copy.scope}</p>
        </section>
        <section className="expert-capabilities" aria-labelledby="expert-capabilities-heading">
          <header className="expert-detail-section-heading">
            <div>
              <h2 id="expert-capabilities-heading">{t("capabilities")}</h2>
              <p>{t("capabilityDetailsDescription")}</p>
            </div>
          </header>
          <div className="expert-capability-detail-grid">
            <ExpertCapabilityDetailRow
              icon={Network}
              title={t("expertsTeamsFlows")}
              selected={selectionList(selectedResources)}
            />
            <ExpertCapabilityDetailRow
              icon={BookOpenText}
              title={t("skills")}
              selected={selectionList(selectedSkills)}
            />
            <ExpertCapabilityDetailRow
              icon={Wrench}
              title={t("tools")}
              selected={selectionList(selectedTools)}
            />
            <ExpertCapabilityDetailRow
              icon={PuzzlePiece}
              title={t("plugins")}
              selected={selectionList(selectedPlugins)}
            />
          </div>
        </section>
        <section className="expert-context-section" aria-labelledby="expert-context-heading">
          <header>
            <div>
              <h2 id="expert-context-heading">{t("knowledgeBase")}</h2>
              <p>{t("contextDescription")}</p>
            </div>
          </header>
          {props.expert.contextStoreMounts.length === 0 && !memoryStoreHasContent ? (
            <p className="expert-context-empty">{t("noContext")}</p>
          ) : (
            <div className="expert-context-list">
              {props.expert.contextStoreMounts.map((mount) => {
                const store = props.contextStores.find((item) => item.id === mount.storeId);
                if (!store) return null;
                const StoreIcon = Folder;
                const loadingBehavior = "From Markdown metadata";
                return (
                  <button
                    className="expert-context-link"
                    key={mount.storeId}
                    type="button"
                    onClick={() => props.onOpenContextStore(store)}
                  >
                    <span className="store-icon">
                      <StoreIcon size={20} />
                    </span>
                    <span>
                      <strong>{store.name}</strong>
                      <small>{t("knowledgeBase")}</small>
                    </span>
                    <em>{loadingBehavior}</em>
                    <span className="store-status">
                      <i className="is-ready" />
                      {mount.enabled ? t("enabled") : t("disabled")}
                    </span>
                    <CaretRight size={17} aria-hidden="true" />
                  </button>
                );
              })}
              {memoryStoreSource !== undefined && memoryStoreHasContent ? (
                <button
                  className="expert-context-link"
                  type="button"
                  onClick={() => setMemoryStoreOpen(true)}
                >
                  <span className="store-icon">
                    <Database size={20} />
                  </span>
                  <span>
                    <strong>{t("memoryStore")}</strong>
                    <small>{t("readOnly")}</small>
                  </span>
                  <em>{t("browseMemoryStore")}</em>
                  <CaretRight size={17} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )}
        </section>
        <section className="instructions-preview" aria-labelledby="expert-instructions-heading">
          <h2 id="expert-instructions-heading">
            {isBuiltInExpert(props.expert) ? t("builtInFoundationInstructions") : t("instructions")}
          </h2>
          {instructions ? (
            <div className="expert-instructions-markdown markdown-preview">
              <MarkdownContent source={instructions} />
            </div>
          ) : (
            <p className="expert-instructions-empty">{t("noInstructions")}</p>
          )}
        </section>
        {isBuiltInExpert(props.expert) ? (
          <section className="instructions-preview" aria-labelledby="expert-additional-heading">
            <h2 id="expert-additional-heading">{t("additionalInstructions")}</h2>
            {additionalInstructions ? (
              <div className="expert-instructions-markdown markdown-preview">
                <MarkdownContent source={additionalInstructions} />
              </div>
            ) : (
              <p className="expert-instructions-empty">{t("noAdditionalInstructions")}</p>
            )}
          </section>
        ) : null}
      </div>
      {props.expert.usesApproval ? (
        <p className="approval-note">
          <Info size={19} aria-hidden="true" /> {t("approvalNote")}
        </p>
      ) : null}
      {confirmOpen ? (
        <StudioConfirmationDialog
          title={t("deleteExpert")}
          description={t("deleteExpertDescription", { name: copy.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteExpertAction")}
          busyLabel={t("deleting")}
          busy={deleting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
      {resetConfirmOpen ? (
        <StudioConfirmationDialog
          title={t("resetBuiltInExpertConfirm")}
          description={t("resetBuiltInExpertDescription", { name: copy.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("resetBuiltInExpert")}
          busyLabel={t("resettingBuiltInExpert")}
          busy={resetting}
          action="reset"
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => void reset()}
        />
      ) : null}
    </StudioScreenFrame>
  );
}
