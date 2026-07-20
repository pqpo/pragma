import {
  ArrowLeft,
  ArrowCounterClockwise,
  BookOpenText,
  CaretDown,
  CaretRight,
  Copy,
  Info,
  Folder,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextStore } from "../../../../shared/desktop-api.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog.tsx";
import { isBuiltInExpert, type ExpertRecord } from "./studio-model.ts";
import { errorMessage } from "../../lib/errors.ts";

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
  const [query, setQuery] = useState("");
  const matchingExperts = props.experts.filter((expert) =>
    `${expert.name} ${expert.description} ${expert.tags.join(" ")}`
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
        <button className="directory-filter" type="button">
          {t("allExperts")}
          <CaretDown size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="expert-table" role="list" aria-label={t("availableExperts")}>
        <div className="expert-table-heading" aria-hidden="true">
          <span className="expert-column-name">{t("expert")}</span>
          <span className="expert-column-tags">{t("tags")}</span>
          <span className="expert-column-scope">{t("scope")}</span>
          <span className="expert-column-action" />
        </div>
        {matchingExperts.map((expert) => {
          const ExpertIcon = expert.icon;
          return (
            <button
              className="expert-list-row"
              type="button"
              key={expert.id}
              onClick={() => props.onOpen(expert)}
            >
              <span className="expert-list-name expert-column-name">
                <span className="studio-asset-icon" aria-hidden="true">
                  <ExpertIcon size={24} weight="regular" />
                </span>
                <span>
                  <strong>{expert.name}</strong>
                  <small>{expert.description}</small>
                </span>
              </span>
              <span className="expert-tag-list expert-column-tags">
                {expert.tags.slice(0, 2).map((tag) => (
                  <em key={tag}>{tag}</em>
                ))}
              </span>
              <span className="expert-list-scope expert-column-scope">{expert.scope}</span>
              <CaretRight className="expert-column-action" size={19} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className="directory-count">{t("expertCount", { count: matchingExperts.length })}</p>
    </StudioScreenFrame>
  );
}

export function ExpertDetailFragment(props: {
  readonly expert: ExpertRecord;
  readonly contextStores: readonly ContextStore[];
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onUseAsTemplate: () => void;
  readonly onConfigureContext: () => void;
  readonly onTryInSession: () => void;
  readonly onDelete: () => Promise<void>;
  readonly onReset: () => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const ExpertIcon = props.expert.icon;
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
          {t("backExperts")}
        </button>
      }
    >
      <header className="expert-detail-header">
        <span className="expert-avatar" aria-hidden="true">
          <ExpertIcon size={42} weight="regular" />
        </span>
        <div className="expert-detail-title">
          <div>
            <h1 id="expert-name">{props.expert.name}</h1>
            <span className="version-label">v{props.expert.version}</span>
            <span className="expert-id-label">ID: {props.expert.id}</span>
          </div>
          <p>{truncateText(props.expert.description, DESCRIPTION_PREVIEW_LENGTH)}</p>
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
              title={t("templateExcludesSystemCapabilities")}
              onClick={props.onUseAsTemplate}
            >
              <Copy size={17} aria-hidden="true" />
              {t("useAsTemplate")}
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
      <section className="expert-scope" aria-labelledby="expert-scope-heading">
        <h2 id="expert-scope-heading">{t("scope")}</h2>
        <p>{props.expert.scope}</p>
      </section>
      <section className="instructions-preview">
        <h2>
          {isBuiltInExpert(props.expert) ? t("builtInFoundationInstructions") : t("instructions")}
        </h2>
        <p>{displayedInstructions || t("noInstructions")}</p>
        {hasLongInstructions ? (
          <button
            className="text-button instructions-toggle"
            type="button"
            aria-expanded={instructionsExpanded}
            onClick={() => setInstructionsExpanded((expanded) => !expanded)}
          >
            {instructionsExpanded ? t("showLess") : t("showMore")}
          </button>
        ) : null}
      </section>
      {isBuiltInExpert(props.expert) ? (
        <section className="instructions-preview">
          <h2>{t("additionalInstructions")}</h2>
          <p>{props.expert.additionalInstructions.trim() || t("noAdditionalInstructions")}</p>
        </section>
      ) : null}
      <section className="expert-capabilities" aria-label={t("expertCapabilities")}>
        <div>
          <h2>{t("model")}</h2>
          <p>
            {props.expert.model?.modelId ??
              t(isBuiltInExpert(props.expert) ? "systemDefault" : "notConfigured")}
          </p>
        </div>
        <div>
          <h2>{t("capabilities")}</h2>
          <p>
            {props.expert.skills} skills <span>•</span> {props.expert.tools} tools <span>•</span>{" "}
            {props.expert.mcpServers} MCP server{props.expert.mcpServers === 1 ? "" : "s"}{" "}
            <span>•</span> {props.expert.plugins.length} plugin
            {props.expert.plugins.length === 1 ? "" : "s"}
          </p>
        </div>
      </section>
      <section className="expert-context-section" aria-labelledby="expert-context-heading">
        <header>
          <div>
            <h2 id="expert-context-heading">{t("context")}</h2>
            <p>{t("contextDescription")}</p>
          </div>
          {!props.expert.readOnly || isBuiltInExpert(props.expert) ? (
            <button className="secondary-button" type="button" onClick={props.onConfigureContext}>
              <Plus size={16} /> {t("configureContext")}
            </button>
          ) : null}
        </header>
        {props.expert.contextStoreMounts.length === 0 ? (
          <p className="expert-context-empty">{t("noContext")}</p>
        ) : (
          <div className="expert-context-list">
            {props.expert.contextStoreMounts.map((mount) => {
              const store = props.contextStores.find((item) => item.id === mount.storeId);
              if (!store) return null;
              const StoreIcon = store.type === "file" ? Folder : BookOpenText;
              const loadingBehavior =
                store.type === "file"
                  ? "From file metadata"
                  : store.entries.length === 1
                    ? store.entries[0]!.trigger === "always_on"
                      ? "Load immediately"
                      : store.entries[0]!.trigger === "model_decision"
                        ? "Model decides"
                        : "On demand"
                    : "Per note entry";
              return (
                <div key={mount.storeId}>
                  <span className="store-icon">
                    <StoreIcon size={20} />
                  </span>
                  <span>
                    <strong>{store.name}</strong>
                    <small>{store.type === "file" ? t("fileStore") : t("contextNote")}</small>
                  </span>
                  <em>{loadingBehavior}</em>
                  <span className="store-status">
                    <i className="is-ready" />
                    {mount.enabled ? t("enabled") : t("disabled")}
                  </span>
                </div>
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
      {isBuiltInExpert(props.expert) ? (
        <p className="approval-note">
          <Info size={19} aria-hidden="true" /> {t("templateExcludesSystemCapabilities")}
        </p>
      ) : null}
      {confirmOpen ? (
        <DeleteConfirmationDialog
          title={t("deleteExpert")}
          description={t("deleteExpertDescription", { name: props.expert.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteExpertAction")}
          deletingLabel={t("deleting")}
          busy={deleting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
      {resetConfirmOpen ? (
        <DeleteConfirmationDialog
          title={t("resetBuiltInExpertConfirm")}
          description={t("resetBuiltInExpertDescription", { name: props.expert.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("resetBuiltInExpert")}
          deletingLabel={t("resettingBuiltInExpert")}
          busy={resetting}
          action="reset"
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => void reset()}
        />
      ) : null}
    </StudioScreenFrame>
  );
}
