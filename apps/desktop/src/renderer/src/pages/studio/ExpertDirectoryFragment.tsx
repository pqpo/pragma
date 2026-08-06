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
import { useState, type ReactNode } from "react";
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
import { isBuiltInExpert, type ExpertRecord } from "./studio-model.ts";
import { errorMessage } from "../../lib/errors.ts";
import { runtimeDisplayName } from "../../lib/runtime-display.ts";
import { localizeSystemExpertCopy } from "../../lib/system-expert-copy.ts";

const DESCRIPTION_PREVIEW_LENGTH = 200;
const INSTRUCTIONS_PREVIEW_LENGTH = 420;

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
          const ExpertIcon = expert.icon;
          return (
            <article
              className="expert-card-shell"
              key={expert.ref ?? `expert:${expert.id}`}
              role="listitem"
            >
              <button className="expert-card" type="button" onClick={() => props.onOpen(expert)}>
                <span className="expert-card-header">
                  <span className="expert-card-icon" aria-hidden="true">
                    <ExpertIcon size={25} weight="regular" />
                  </span>
                  <span className="expert-card-identity">
                    <span className="expert-card-title-row">
                      <strong>{copy.name}</strong>
                      <em className="expert-source-chip">
                        {t(isBuiltInExpert(expert) ? "builtIn" : "custom")}
                      </em>
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

function resourceKindLabel(
  resource: PragmaResource,
  translate: (key: string) => string,
): string {
  switch (resource.kind) {
    case "Expert":
      return translate("expert");
    case "ExpertTeam":
      return translate("expertTeam");
    case "Flow":
      return translate("flow");
  }
  return resource.kind;
}

function ExpertCapabilityDetailRow(props: {
  readonly icon: Icon;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly selected: ReactNode;
  readonly count: string;
}) {
  const CapabilityIcon = props.icon;
  return (
    <article className="expert-capability-detail-row">
      <span className="expert-capability-detail-icon" aria-hidden="true">
        <CapabilityIcon size={19} />
      </span>
      <div className="expert-capability-detail-copy">
        <small>{props.eyebrow}</small>
        <h3>{props.title}</h3>
        <p>{props.description}</p>
        <div className="expert-capability-detail-selection">{props.selected}</div>
      </div>
      <span className="expert-capability-detail-count">{props.count}</span>
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
  const ExpertIcon = props.expert.icon;
  const copy = localizeSystemExpertCopy(props.expert, {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  });
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const hasLongInstructions = props.expert.instructions.trim().length > INSTRUCTIONS_PREVIEW_LENGTH;
  const displayedInstructions =
    hasLongInstructions && !instructionsExpanded
      ? truncateText(props.expert.instructions, INSTRUCTIONS_PREVIEW_LENGTH)
      : props.expert.instructions.trim();
  const runtime = props.runtimes.find((item) => item.id === props.expert.model?.runtimeId);
  const runtimeName =
    runtime === undefined
      ? t(isBuiltInExpert(props.expert) ? "systemDefault" : "notConfigured")
      : runtimeDisplayName(tCommon, runtime);
  const modelName =
    props.expert.model?.modelId ??
    t(isBuiltInExpert(props.expert) ? "systemDefault" : "notConfigured");
  const selectedResources = props.expert.resourceTools.map((binding) => {
    const resource = props.resources.find(
      (candidate) => canonicalPragmaResourceRef(candidate) === binding.target?.ref,
    );
    return {
      label: resource?.metadata.name ?? binding.target?.ref ?? t("notConfigured"),
      description: resource === undefined ? undefined : resourceKindLabel(resource, t),
    };
  });
  const selectedStores = props.expert.contextStoreMounts.flatMap((mount) => {
    const store = props.contextStores.find((candidate) => candidate.id === mount.storeId);
    return [
      {
        label: store?.name ?? mount.storeId,
        description: store?.description || t("knowledgeBase"),
      },
    ];
  });
  const selectedSkills = props.expert.capabilities
    .filter((reference) => reference.kind === "skill")
    .map((reference) => {
      const capability = props.capabilities.find(
        (candidate) => candidate.manifest.id === reference.capabilityId,
      );
      return {
        label: capability?.manifest.name ?? reference.capabilityId,
        description:
          capability?.definition.kind === "skill"
            ? capability.definition.description
            : t("skill"),
      };
    });
  const selectedToolReferences = props.expert.capabilities.filter(
    (reference): reference is Extract<ExpertRecord["capabilities"][number], { kind: "tools" }> =>
      reference.kind === "tools",
  );
  const selectedTools = selectedToolReferences.flatMap((reference) => {
    const capability = props.capabilities.find(
      (candidate) => candidate.manifest.id === reference.capabilityId,
    );
    const serviceName = capability?.manifest.name ?? reference.capabilityId;
    return reference.toolNames.map((toolName) => ({
      label: toolName,
      description: serviceName,
    }));
  });
  const selectedPlugins = props.expert.plugins.map((reference) => ({
    label:
      props.plugins.find((plugin) => plugin.ref === reference.ref)?.manifest.name ?? reference.ref,
    description: t("plugins"),
  }));
  const selectionList = (
    items: readonly { readonly label: string; readonly description: string | undefined }[],
  ): ReactNode =>
    items.length === 0 ? (
      <span className="expert-capability-detail-empty">{t("noneSelected")}</span>
    ) : (
      <ul className="expert-capability-detail-list">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <strong>{item.label}</strong>
            {item.description ? <small>{item.description}</small> : null}
          </li>
        ))}
      </ul>
    );
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
        <span className="expert-avatar" aria-hidden="true">
          <ExpertIcon size={42} weight="regular" />
        </span>
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
      </section>
      <div className="expert-detail-content">
        <div className="expert-detail-reading-column">
          <section className="expert-scope" aria-labelledby="expert-scope-heading">
            <h2 id="expert-scope-heading">{t("scope")}</h2>
            <p>{copy.scope}</p>
          </section>
          <section className="instructions-preview" aria-labelledby="expert-instructions-heading">
            <header className="expert-detail-section-heading">
              <h2 id="expert-instructions-heading">
                {isBuiltInExpert(props.expert)
                  ? t("builtInFoundationInstructions")
                  : t("instructions")}
              </h2>
              {hasLongInstructions ? (
                <button
                  className="text-button instructions-toggle"
                  type="button"
                  aria-expanded={instructionsExpanded}
                  aria-controls="expert-instructions-content"
                  onClick={() => setInstructionsExpanded((expanded) => !expanded)}
                >
                  {instructionsExpanded ? t("showLess") : t("showMore")}
                </button>
              ) : null}
            </header>
            <p id="expert-instructions-content">
              {displayedInstructions || t("noInstructions")}
            </p>
          </section>
          {isBuiltInExpert(props.expert) ? (
            <section className="instructions-preview" aria-labelledby="expert-additional-heading">
              <h2 id="expert-additional-heading">{t("additionalInstructions")}</h2>
              <p>{props.expert.additionalInstructions.trim() || t("noAdditionalInstructions")}</p>
            </section>
          ) : null}
        </div>
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
              eyebrow={t("asTools")}
              title={t("expertsTeamsFlows")}
              description={t("resourcesDetailDescription")}
              selected={selectionList(selectedResources)}
              count={t("selectedCount", { count: selectedResources.length })}
            />
            <ExpertCapabilityDetailRow
              icon={Database}
              eyebrow={t("knowledge")}
              title={t("contextStores")}
              description={t("contextStoresDetailDescription")}
              selected={selectionList(selectedStores)}
              count={t("selectedCount", { count: selectedStores.length })}
            />
            <ExpertCapabilityDetailRow
              icon={BookOpenText}
              eyebrow={t("guidance")}
              title={t("skills")}
              description={t("skillsDetailDescription")}
              selected={selectionList(selectedSkills)}
              count={t("selectedCount", { count: selectedSkills.length })}
            />
            <ExpertCapabilityDetailRow
              icon={Wrench}
              eyebrow={t("actions")}
              title={t("tools")}
              description={t("toolsDetailDescription")}
              selected={selectionList(selectedTools)}
              count={t("selectedCount", { count: selectedTools.length })}
            />
            <ExpertCapabilityDetailRow
              icon={PuzzlePiece}
              eyebrow={t("plugins")}
              title={t("plugins")}
              description={t("pluginsDetailDescription")}
              selected={selectionList(selectedPlugins)}
              count={t("selectedCount", { count: selectedPlugins.length })}
            />
          </div>
        </section>
      </div>
      <section className="expert-context-section" aria-labelledby="expert-context-heading">
        <header>
          <div>
            <h2 id="expert-context-heading">{t("context")}</h2>
            <p>{t("contextDescription")}</p>
          </div>
        </header>
        {props.expert.contextStoreMounts.length === 0 ? (
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
          </div>
        )}
      </section>
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
