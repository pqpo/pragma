import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import {
  ArrowLeft,
  CaretRight,
  CaretDown,
  GitBranch,
  Folder,
  Database,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  UserCircle,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import {
  PragmaExpertTeamResourceSchema,
  PragmaRuntimeProfileConfigSchema,
  PragmaResourceKindSchema,
  canonicalPragmaResourceRef,
  parsePragmaReference,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaExpertTeamContextVisibility,
  type PragmaFlowResource,
} from "@pragma/interpreter/ast";
import {
  PRAGMA_TEXT_LIMITS,
  pragmaUnicodeLength,
  truncatePragmaTrimmedUnicode,
} from "@pragma/shared";
import {
  DesktopMutationErrorSchema,
  type DesktopRuntimeAvailability,
  type PragmaProjectSnapshot,
  type ContextStore,
  type DesktopPragmaContextStoreBinding,
} from "../../../../shared/contracts/index.ts";

import { CharacterCount } from "../../components/CharacterCount.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { AssetMemoryPolicySection } from "../settings/AssetMemoryPolicySection.tsx";
import { ContextStorePickerDialog } from "./ContextStorePickerDialog.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import type { ExpertRecord } from "./studio-model.ts";
import { runtimeDisplayName } from "../../lib/runtime-display.ts";
import {
  MemoryStoreBrowser,
  type ContextStoreBrowserSource,
} from "../../components/MemoryStoreBrowser.tsx";

export type ResourceKind = "team" | "flow";
type TeamExpertPickerKind = "coordinator" | "members";
export type ResourceEditorMode = "create" | "edit";
export interface TeamKnowledgeSelection {
  readonly storeId: string;
  readonly visibility: PragmaExpertTeamContextVisibility;
}

const TEAM_EXPERT_RESULT_LIMIT = 8;
const DELETE_REFERENCE_LIMIT = 2;
const DELETE_REFERENCE_KIND_KEYS = {
  expert: "deleteResourceKind.expert",
  team: "deleteResourceKind.team",
  flow: "deleteResourceKind.flow",
  automation: "deleteResourceKind.automation",
  capability: "deleteResourceKind.capability",
  "context-store": "deleteResourceKind.contextStore",
  "runtime-profile": "deleteResourceKind.runtimeProfile",
  evaluation: "deleteResourceKind.evaluation",
} as const;
type FlowHumanPrompt = NonNullable<
  PragmaFlowResource["spec"]["graph"]["steps"][string]["human"]
>["prompt"];

function expertRef(expert: PragmaExpertResource): string {
  return `expert:${expert.metadata.id}`;
}

function expertRecordRef(expert: ExpertRecord): string {
  return expert.ref ?? `expert:${expert.id}`;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function deletePragmaResourceErrorMessage(error: unknown, t: TFunction<"studio">): string {
  const parsed = DesktopMutationErrorSchema.safeParse(error);
  if (!parsed.success || parsed.data.code !== "resource_referenced") {
    return errorMessage(error);
  }

  const referencedBy = parsed.data.referencedBy ?? [];
  if (referencedBy.length === 0) return t("deleteResourceReferencedUnknown");

  const visibleReferences = referencedBy.slice(0, DELETE_REFERENCE_LIMIT);
  const references = visibleReferences
    .map(({ ref, name }) =>
      t("deleteResourceReference", {
        kind: t(
          DELETE_REFERENCE_KIND_KEYS[
            PragmaResourceKindSchema.parse(parsePragmaReference(ref).kind)
          ],
        ),
        name,
      }),
    )
    .join(t("deleteResourceReferenceSeparator"));
  const remaining = referencedBy.length - visibleReferences.length;
  return remaining > 0
    ? t("deleteResourceReferencedMore", { references, count: remaining })
    : t("deleteResourceReferenced", { references });
}

export function matchingTeamExperts(
  experts: readonly PragmaExpertResource[],
  query: string,
  selectedRefs: ReadonlySet<string>,
  excludedRef?: string | undefined,
  limit = TEAM_EXPERT_RESULT_LIMIT,
): readonly PragmaExpertResource[] {
  const term = normalized(query);
  return experts
    .filter((expert) => {
      const ref = expertRef(expert);
      if (ref === excludedRef) return false;
      return (
        term.length === 0 ||
        [
          expert.metadata.name,
          expert.metadata.id,
          expert.metadata.description,
          ...expert.metadata.tags,
          ref,
        ].some((value) => normalized(value).includes(term))
      );
    })
    .toSorted((left, right) => {
      const selectedOrder =
        Number(selectedRefs.has(expertRef(right))) - Number(selectedRefs.has(expertRef(left)));
      return selectedOrder || left.metadata.name.localeCompare(right.metadata.name);
    })
    .slice(0, limit);
}

export function matchesResourceDirectoryQuery(
  resource: PragmaExpertTeamResource | PragmaFlowResource,
  query: string,
): boolean {
  const term = normalized(query);
  return (
    term.length === 0 ||
    [
      resource.metadata.name,
      resource.metadata.id,
      resource.metadata.description,
      ...resource.metadata.tags,
      canonicalPragmaResourceRef(resource),
    ].some((value) => normalized(value).includes(term))
  );
}

function uniqueTeamMemberRefs(resource: PragmaExpertTeamResource): readonly string[] {
  return [
    resource.spec.coordinator.ref,
    ...resource.spec.members.map((member) => member.ref),
  ].filter((ref, index, refs) => refs.indexOf(ref) === index);
}

function teamExpertName(project: PragmaProjectSnapshot, ref: string): string {
  return (
    project.resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && expertRef(resource) === ref,
    )?.metadata.name ?? ref
  );
}

export function PragmaResourceDirectoryFragment(props: {
  readonly kind: ResourceKind;
  readonly project: PragmaProjectSnapshot;
  readonly onOpen: (resource: PragmaExpertTeamResource | PragmaFlowResource) => void;
  readonly onCreate: (kind: ResourceKind, resourceId: string) => void;
}) {
  const { t } = useTranslation("studio");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const resources = props.project.resources.filter(
    (resource): resource is PragmaExpertTeamResource | PragmaFlowResource =>
      props.kind === "team" ? resource.kind === "ExpertTeam" : resource.kind === "Flow",
  );
  const matchingResources = resources.filter((resource) =>
    matchesResourceDirectoryQuery(resource, query),
  );

  const Icon = props.kind === "team" ? UsersThree : GitBranch;
  const headingId = props.kind === "team" ? "expert-teams-heading" : "flows-heading";
  const searchLabel = props.kind === "team" ? t("searchExpertTeams") : t("searchFlows");
  return (
    <StudioScreenFrame
      className="studio-collection pragma-resource-directory"
      labelledBy={headingId}
      header={
        <header className="studio-heading">
          <div>
            <h1 id={headingId}>{props.kind === "team" ? t("teams") : t("flows")}</h1>
            <p>{props.kind === "team" ? t("teamsDescription") : t("flowsDescription")}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              const api = desktopApi();
              if (api === undefined) return;
              void api
                .allocatePragmaResourceId()
                .then(({ id }) => {
                  setError(null);
                  props.onCreate(props.kind, id);
                })
                .catch((cause: unknown) => setError(errorMessage(cause)));
            }}
          >
            <Plus size={17} aria-hidden="true" />{" "}
            {t("newResource", { kind: props.kind === "team" ? t("expertTeam") : t("flow") })}
          </button>
        </header>
      }
    >
      <div className="directory-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">{searchLabel}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
          />
        </label>
      </div>

      {props.kind === "team" ? (
        <div className="expert-team-grid" role="list" aria-label={t("teams")}>
          {matchingResources.map((resource) => {
            if (resource.kind !== "ExpertTeam") return null;
            const memberRefs = uniqueTeamMemberRefs(resource);
            const visibleMemberNames = memberRefs
              .slice(0, 3)
              .map((ref) => teamExpertName(props.project, ref));
            return (
              <article
                className="expert-team-card-shell"
                key={canonicalPragmaResourceRef(resource)}
                role="listitem"
              >
                <button
                  className="expert-team-card"
                  type="button"
                  onClick={() => props.onOpen(resource)}
                >
                  <span className="expert-team-card-header">
                    <span className="expert-team-card-icon" aria-hidden="true">
                      <UsersThree size={25} />
                    </span>
                    <span className="expert-team-card-identity">
                      <span className="expert-team-card-title-row">
                        <strong>{resource.metadata.name}</strong>
                      </span>
                      <code>{canonicalPragmaResourceRef(resource)}</code>
                    </span>
                    <CaretRight className="expert-team-card-action" size={18} aria-hidden="true" />
                  </span>
                  <span className="expert-team-card-description">
                    {resource.metadata.description}
                  </span>
                  <span className="expert-team-card-members">
                    <small>{t("teamMembersLabel")}</small>
                    <span>
                      {visibleMemberNames.map((name, index) => (
                        <em key={`${memberRefs[index] ?? name}-${name}`}>{name}</em>
                      ))}
                      {memberRefs.length > visibleMemberNames.length ? (
                        <em>+{memberRefs.length - visibleMemberNames.length}</em>
                      ) : null}
                    </span>
                  </span>
                  {resource.metadata.tags.length > 0 ? (
                    <span className="expert-team-card-tags" aria-label={t("tags")}>
                      {resource.metadata.tags.slice(0, 3).map((tag) => (
                        <em key={tag}>{tag}</em>
                      ))}
                    </span>
                  ) : null}
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="studio-asset-rows">
          {matchingResources.map((resource) => (
            <button
              className="studio-asset-row pragma-resource-row"
              type="button"
              key={canonicalPragmaResourceRef(resource)}
              onClick={() => props.onOpen(resource)}
            >
              <span className="studio-asset-icon" aria-hidden="true">
                <Icon size={24} />
              </span>
              <span className="studio-asset-copy">
                <strong>{resource.metadata.name}</strong>
                <span>{resource.metadata.description}</span>
              </span>
              <CaretRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {matchingResources.length === 0 ? (
        <p className="studio-empty-copy">
          {query.trim()
            ? t("noMatchesFound")
            : t("noResourcesYet", {
                kind: props.kind === "team" ? t("expertTeam") : t("flow"),
              })}
        </p>
      ) : null}
      <p className="directory-count">
        {props.kind === "team"
          ? t("expertTeamCount", { count: matchingResources.length })
          : t("flowCount", { count: matchingResources.length })}
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </StudioScreenFrame>
  );
}

export function PragmaResourceDetailFragment(props: {
  readonly resource: PragmaExpertTeamResource | PragmaFlowResource;
  readonly project: PragmaProjectSnapshot;
  readonly experts?: readonly ExpertRecord[] | undefined;
  readonly runtimes?: readonly DesktopRuntimeAvailability[] | undefined;
  readonly contextStores?: readonly ContextStore[] | undefined;
  readonly contextStoreBindings?: readonly DesktopPragmaContextStoreBinding[] | undefined;
  readonly onOpenContextStore?: ((store: ContextStore) => void) | undefined;
  readonly onOpenExpert?: ((expert: ExpertRecord) => void) | undefined;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [memoryStoreOpen, setMemoryStoreOpen] = useState(false);
  const [memoryStoreHasContent, setMemoryStoreHasContent] = useState(false);
  const isTeam = props.resource.kind === "ExpertTeam";
  const headingId = isTeam ? "team-detail-name" : "flow-detail-name";
  const Icon = isTeam ? UsersThree : GitBranch;
  const teamMemorySource = useMemo<ContextStoreBrowserSource | undefined>(() => {
    if (!isTeam) return undefined;
    const target = { teamRef: canonicalPragmaResourceRef(props.resource) as `team:${string}` };
    return {
      getDescriptor: async () => await window.pragmaDesktop.getTeamMemoryContextStore(target),
      list: async (scopeId) =>
        await window.pragmaDesktop.listTeamMemoryContextStoreEntries({ ...target, scopeId }),
      read: async (scopeId, id, start) =>
        await window.pragmaDesktop.readTeamMemoryContextStoreEntry({
          ...target,
          scopeId,
          id,
          start,
          maxBytes: 64_000,
        }),
      search: async (scopeId, query) =>
        await window.pragmaDesktop.searchTeamMemoryContextStore({
          ...target,
          scopeId,
          query,
          maxResults: 50,
          contextLines: 2,
        }),
    };
  }, [isTeam, props.resource]);
  useEffect(() => {
    let cancelled = false;
    setMemoryStoreHasContent(false);
    setMemoryStoreOpen(false);
    if (teamMemorySource === undefined) return;
    void teamMemorySource
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
  }, [teamMemorySource]);
  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDelete();
    } catch (cause) {
      setDeleteError(deletePragmaResourceErrorMessage(cause, t));
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  if (memoryStoreOpen && teamMemorySource !== undefined) {
    return (
      <StudioScreenFrame
        className="pragma-resource-detail expert-memory-store-detail"
        header={
          <button className="back-link" type="button" onClick={() => setMemoryStoreOpen(false)}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backToContext")}
          </button>
        }
      >
        <MemoryStoreBrowser className="expert-memory-store-page" source={teamMemorySource} />
      </StudioScreenFrame>
    );
  }
  return (
    <StudioScreenFrame
      className="pragma-resource-detail"
      labelledBy={headingId}
      header={
        <button className="back-link" type="button" onClick={props.onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          {isTeam ? t("backTeams") : t("backFlows")}
        </button>
      }
    >
      <header className="expert-detail-header pragma-resource-detail-header">
        <span className="expert-avatar" aria-hidden="true">
          <Icon size={42} />
        </span>
        <div className="expert-detail-title">
          <div>
            <h1 id={headingId}>{props.resource.metadata.name}</h1>
          </div>
          <p>{props.resource.metadata.description}</p>
          <div className="expert-tag-list">
            {props.resource.metadata.tags.map((tag) => (
              <em key={tag}>{tag}</em>
            ))}
          </div>
        </div>
        <div className="detail-actions">
          <button className="primary-button" type="button" onClick={props.onEdit}>
            <PencilSimple size={17} aria-hidden="true" />
            {isTeam ? t("editExpertTeam") : t("editFlow")}
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={() => {
              setDeleteError(null);
              setConfirmOpen(true);
            }}
          >
            <Trash size={17} aria-hidden="true" />
            {t("deleteResourceAction")}
          </button>
        </div>
      </header>
      {deleteError ? (
        <p className="form-error pragma-resource-delete-error" role="alert">
          {deleteError}
        </p>
      ) : null}
      {isTeam ? (
        <TeamDetail
          resource={props.resource}
          project={props.project}
          experts={props.experts ?? []}
          runtimes={props.runtimes ?? []}
          contextStores={props.contextStores ?? []}
          contextStoreBindings={props.contextStoreBindings ?? []}
          memoryStoreHasContent={memoryStoreHasContent}
          onOpenMemoryStore={() => setMemoryStoreOpen(true)}
          onOpenContextStore={props.onOpenContextStore}
          onOpenExpert={props.onOpenExpert}
        />
      ) : (
        <FlowDetail resource={props.resource} project={props.project} />
      )}
      {confirmOpen ? (
        <StudioConfirmationDialog
          title={t("deleteResource", {
            kind: isTeam ? t("expertTeam") : t("flow"),
          })}
          description={t("deleteResourceDescription", { name: props.resource.metadata.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteResourceAction")}
          busyLabel={t("deleting")}
          busy={deleting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

function TeamDetail(props: {
  readonly resource: PragmaExpertTeamResource;
  readonly project: PragmaProjectSnapshot;
  readonly experts: readonly ExpertRecord[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly contextStores: readonly ContextStore[];
  readonly contextStoreBindings: readonly DesktopPragmaContextStoreBinding[];
  readonly memoryStoreHasContent: boolean;
  readonly onOpenMemoryStore: () => void;
  readonly onOpenContextStore?: ((store: ContextStore) => void) | undefined;
  readonly onOpenExpert?: ((expert: ExpertRecord) => void) | undefined;
}) {
  const { t } = useTranslation("studio");
  const expertResources = props.project.resources.filter(
    (resource): resource is PragmaExpertResource => resource.kind === "Expert",
  );
  const uniqueMemberRefs = [
    props.resource.spec.coordinator.ref,
    ...props.resource.spec.members.map((member) => member.ref),
  ].filter((ref, index, refs) => refs.indexOf(ref) === index);
  const coordinatorRef = props.resource.spec.coordinator.ref;
  const buildExpert = (ref: string): TeamExpertDisplay => {
    const resourceExpert = expertResources.find((expert) => expertRef(expert) === ref);
    const record = props.experts.find((expert) => expertRecordRef(expert) === ref);
    const runtimeRef = resourceExpert?.spec.runtime?.ref;
    const runtimeResource = runtimeRef
      ? props.project.resources.find(
          (resource) =>
            resource.kind === "RuntimeProfile" &&
            canonicalPragmaResourceRef(resource) === runtimeRef,
        )
      : undefined;
    const runtimeConfig =
      runtimeResource?.kind === "RuntimeProfile"
        ? PragmaRuntimeProfileConfigSchema.safeParse(runtimeResource.spec.config).data
        : undefined;
    const runtimeId = record?.model?.runtimeId ?? runtimeConfig?.runtimeId;
    const runtime = props.runtimes.find((candidate) => candidate.id === runtimeId);
    const modelId = record?.model?.modelId ?? runtimeConfig?.model;
    const providerId = record?.model?.providerId ?? runtimeConfig?.providerId;
    const runtimeModel =
      modelId === undefined
        ? undefined
        : (runtime?.models?.find(
            (model) =>
              model.id === modelId &&
              (providerId === undefined || model.provider.id === providerId),
          ) ?? runtime?.models?.find((model) => model.id === modelId));

    return {
      ref,
      record,
      name: record?.name ?? resourceExpert?.metadata.name ?? ref,
      description:
        record?.description ?? resourceExpert?.metadata.description ?? t("noDescription"),
      scope: record?.scope ?? resourceExpert?.spec.scope ?? "",
      runtimeName:
        runtime === undefined ? (runtimeId ?? t("notConfigured")) : runtimeDisplayName(t, runtime),
      modelName:
        modelId === undefined ? t("runtimeDefault") : (runtimeModel?.displayName ?? modelId),
      capabilitySummary:
        record === undefined
          ? undefined
          : `${record.skills} ${t("skills")} · ${record.tools} ${t("tools")}`,
    };
  };
  const coordinator = buildExpert(coordinatorRef);
  const members = uniqueMemberRefs
    .filter((ref) => ref !== coordinatorRef)
    .map((ref) => buildExpert(ref));
  const instructions = props.resource.spec.instructions?.trim();
  const teamContextStores = props.resource.spec.contextStores.flatMap((binding) => {
    const desktopBinding = props.contextStoreBindings.find(
      (candidate) => candidate.resourceRef === binding.ref,
    );
    const store = props.contextStores.find((candidate) => candidate.id === desktopBinding?.storeId);
    return store === undefined ? [] : [{ binding, store }];
  });

  return (
    <div className="team-detail-content">
      <div className="team-summary-bar" aria-label={t("teamDetails")}>
        <div>
          <UsersThree size={20} aria-hidden="true" />
          <span>{t("members")}</span>
          <strong>{t("membersCount", { count: uniqueMemberRefs.length })}</strong>
        </div>
        <div>
          <span>{t("maxConcurrency")}</span>
          <strong>{props.resource.spec.delegation.maxConcurrency}</strong>
        </div>
        <div>
          <span>{t("maxDelegationDepth")}</span>
          <strong>{props.resource.spec.delegation.maxDepth}</strong>
        </div>
      </div>

      <section className="team-roster-section" aria-labelledby="team-members-heading">
        <header className="team-roster-heading">
          <div>
            <h2 id="team-members-heading">{t("teamExperts")}</h2>
            <p>{t("teamMembersDescription")}</p>
          </div>
          <div className="team-roster-legend" aria-label={t("teamDetails")}>
            <span className="is-coordinator">
              <UserCircle size={17} aria-hidden="true" /> {t("coordinator")}
            </span>
            <span>
              <UserCircle size={17} aria-hidden="true" /> {t("members")}
            </span>
          </div>
        </header>
        <TeamExpertCard expert={coordinator} role="coordinator" onOpenExpert={props.onOpenExpert} />
        {members.length > 0 ? (
          <div className="team-member-grid">
            {members.map((member) => (
              <TeamExpertCard
                key={member.ref}
                expert={member}
                role="member"
                onOpenExpert={props.onOpenExpert}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section
        className="expert-context-section team-context-section"
        aria-labelledby="team-context-heading"
      >
        <header>
          <div>
            <h2 id="team-context-heading">{t("context")}</h2>
            <p>{t("teamContextDescription")}</p>
          </div>
        </header>
        {teamContextStores.length === 0 && !props.memoryStoreHasContent ? (
          <p className="expert-context-empty">{t("noContext")}</p>
        ) : (
          <div className="expert-context-list">
            {teamContextStores.map(({ binding, store }) => (
              <button
                className="expert-context-link"
                key={binding.ref}
                type="button"
                onClick={() => props.onOpenContextStore?.(store)}
              >
                <span className="store-icon">
                  <Folder size={20} />
                </span>
                <span>
                  <strong>{store.name}</strong>
                  <small>{t("knowledgeBase")}</small>
                </span>
                <em>
                  {teamVisibilitySummary(binding.visibility, props.resource, props.project, t)}
                </em>
                <CaretRight size={17} aria-hidden="true" />
              </button>
            ))}
            {props.memoryStoreHasContent ? (
              <button
                className="expert-context-link"
                type="button"
                onClick={props.onOpenMemoryStore}
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

      <details className="team-instructions-disclosure" open>
        <summary>
          <span>
            <strong>{t("teamInstructions")}</strong>
            <small>{t("teamInstructionsHint")}</small>
          </span>
          <span className="team-instructions-toggle">
            <span className="team-instructions-toggle-open">{t("showLess")}</span>
            <span className="team-instructions-toggle-closed">{t("showMore")}</span>
            <CaretDown size={18} aria-hidden="true" />
          </span>
        </summary>
        {instructions ? (
          <div className="team-instructions-markdown markdown-preview">
            <MarkdownContent source={instructions} />
          </div>
        ) : (
          <p className="team-instructions-empty">{t("noInstructions")}</p>
        )}
      </details>
    </div>
  );
}

type TeamExpertDisplay = {
  readonly ref: string;
  readonly record: ExpertRecord | undefined;
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly runtimeName: string;
  readonly modelName: string;
  readonly capabilitySummary: string | undefined;
};

function TeamExpertCard(props: {
  readonly expert: TeamExpertDisplay;
  readonly role: "coordinator" | "member";
  readonly onOpenExpert?: ((expert: ExpertRecord) => void) | undefined;
}) {
  const { t } = useTranslation("studio");
  const openExpert = () => {
    if (props.expert.record !== undefined && props.onOpenExpert !== undefined) {
      props.onOpenExpert(props.expert.record);
    }
  };
  const canOpen = props.expert.record !== undefined && props.onOpenExpert !== undefined;
  return (
    <article
      className={
        props.role === "coordinator" ? "team-expert-card is-coordinator" : "team-expert-card"
      }
    >
      <div className="team-expert-card-main">
        <div className="team-expert-card-heading">
          {props.role === "coordinator" ? (
            <span className="team-role-mark">
              <UserCircle size={18} aria-hidden="true" />
              {t("coordinator")}
            </span>
          ) : null}
          {canOpen ? (
            <button className="team-expert-link" type="button" onClick={openExpert}>
              {props.expert.name}
              <CaretRight size={18} aria-hidden="true" />
            </button>
          ) : (
            <strong className="team-expert-name">{props.expert.name}</strong>
          )}
        </div>
        <p className="team-expert-description">{props.expert.description}</p>
        {props.expert.scope ? (
          <p className="team-expert-scope">
            <span>{t("scope")}</span>
            {props.expert.scope}
          </p>
        ) : null}
      </div>
      <div className="team-expert-card-side">
        <dl className="team-expert-meta">
          <div>
            <dt>{t("runtime")}</dt>
            <dd>{props.expert.runtimeName}</dd>
          </div>
          <div>
            <dt>{t("model")}</dt>
            <dd>{props.expert.modelName}</dd>
          </div>
        </dl>
        {props.expert.capabilitySummary ? (
          <p className="team-expert-capabilities">
            <span>{t("capabilities")}</span>
            {props.expert.capabilitySummary}
          </p>
        ) : null}
        {canOpen ? (
          <button className="team-expert-open" type="button" onClick={openExpert}>
            {t("viewExpertDetails")}
            <CaretRight size={17} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

function teamVisibilitySummary(
  visibility: PragmaExpertTeamContextVisibility,
  team: PragmaExpertTeamResource,
  project: PragmaProjectSnapshot,
  t: TFunction<"studio">,
): string {
  if (visibility.mode === "all") return t("teamKnowledgeVisibilityAll");
  const names = visibility.expertIds.map((id) => teamExpertName(project, `expert:${id}`));
  return visibility.mode === "blacklist"
    ? t("teamKnowledgeVisibilityExcept", { names: names.join("、") })
    : t("teamKnowledgeVisibilityOnly", { names: names.join("、") });
}

function FlowDetail(props: {
  readonly resource: PragmaFlowResource;
  readonly project: PragmaProjectSnapshot;
}) {
  const { t } = useTranslation("studio");
  const steps = Object.entries(props.resource.spec.graph.steps);
  const loops = Object.keys(props.resource.spec.graph.loops);
  const transitionCount = Object.keys(props.resource.spec.graph.transitions).length;
  const startStep = props.resource.spec.graph.start;

  return (
    <>
      <section className="expert-scope" aria-labelledby="flow-overview-heading">
        <h2 id="flow-overview-heading">{t("overview")}</h2>
        <dl className="pragma-resource-detail-list">
          <div>
            <dt>{t("resourceId")}</dt>
            <dd>{canonicalPragmaResourceRef(props.resource)}</dd>
          </div>
          <div>
            <dt>{t("startStep")}</dt>
            <dd>{startStep}</dd>
          </div>
          <div>
            <dt>{t("limits")}</dt>
            <dd>{t("maxNodeVisits", { count: props.resource.spec.limits.maxNodeVisits })}</dd>
          </div>
        </dl>
      </section>
      <section className="expert-capabilities" aria-label={t("flowDetails")}>
        <div>
          <h2>{t("steps")}</h2>
          <p>{t("stepsCount", { count: steps.length })}</p>
        </div>
        <div>
          <h2>{t("transitions")}</h2>
          <p>
            {t("transitionCount", { count: transitionCount })} <span>•</span>{" "}
            {t("loopCount", { count: loops.length })}
          </p>
        </div>
      </section>
      <section className="expert-capabilities" aria-label={t("flowContracts")}>
        <div>
          <h2>{t("flowInputContract")}</h2>
          <p>{props.resource.spec.input === undefined ? t("notConfigured") : t("configured")}</p>
        </div>
        <div>
          <h2>{t("flowOutputContract")}</h2>
          <p>{props.resource.spec.output === undefined ? t("notConfigured") : t("configured")}</p>
        </div>
      </section>
      <section className="expert-context-section" aria-labelledby="flow-steps-heading">
        <header>
          <div>
            <h2 id="flow-steps-heading">{t("steps")}</h2>
            <p>{t("flowStepsDescription")}</p>
          </div>
        </header>
        <div className="expert-context-list">
          {steps.map(([stepId, step]) => (
            <article key={stepId}>
              <GitBranch size={20} aria-hidden="true" />
              <div>
                <strong>{stepId}</strong>
                <span>{flowStepSummary(step)}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function flowStepSummary(step: PragmaFlowResource["spec"]["graph"]["steps"][string]): string {
  if (step.expert !== undefined) return step.expert.ref;
  if (step.team !== undefined) return step.team.ref;
  if (step.flow !== undefined) return step.flow.ref;
  if (step.action !== undefined) return step.action.ref;
  if (step.human !== undefined) return promptSummary(step.human.prompt);
  return "step";
}

function promptSummary(prompt: FlowHumanPrompt): string {
  return prompt.segments
    .map((segment) => ("text" in segment ? segment.text : `{{${segment.variable.source}}}`))
    .join("")
    .trim();
}

export function TeamEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly contextStores?: readonly ContextStore[] | undefined;
  readonly contextStoreBindings?: readonly DesktopPragmaContextStoreBinding[] | undefined;
  readonly baseRevision?: number | undefined;
  readonly mode?: ResourceEditorMode | undefined;
  readonly newResourceId?: string | undefined;
  readonly initial?: PragmaExpertTeamResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (
    resource: PragmaExpertTeamResource,
    contextStores: readonly TeamKnowledgeSelection[],
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ) => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const experts = props.project.resources.filter(
    (resource): resource is PragmaExpertResource => resource.kind === "Expert",
  );
  const id = props.initial?.metadata.id ?? props.newResourceId ?? "";
  const [name, setName] = useState(props.initial?.metadata.name ?? "");
  const [description, setDescription] = useState(props.initial?.metadata.description ?? "");
  const [instructions, setInstructions] = useState(props.initial?.spec.instructions ?? "");
  const initialCoordinator = props.initial?.spec.coordinator.ref ?? "";
  const [coordinator, setCoordinator] = useState(initialCoordinator);
  const [members, setMembers] = useState<readonly string[]>(
    props.initial?.spec.members
      .map((member) => member.ref)
      .filter((ref) => ref !== initialCoordinator) ?? [],
  );
  const [maxConcurrency, setMaxConcurrency] = useState(
    props.initial?.spec.delegation.maxConcurrency ?? 4,
  );
  const [maxDepth, setMaxDepth] = useState(props.initial?.spec.delegation.maxDepth ?? 3);
  const initialTeamContextStores = useMemo(
    () =>
      props.initial?.spec.contextStores.flatMap((binding) => {
        const desktopBinding = props.contextStoreBindings?.find(
          (candidate) => candidate.resourceRef === binding.ref,
        );
        return desktopBinding === undefined
          ? []
          : [{ storeId: desktopBinding.storeId, visibility: binding.visibility }];
      }) ?? [],
    [props.contextStoreBindings, props.initial],
  );
  const [teamContextStores, setTeamContextStores] =
    useState<readonly TeamKnowledgeSelection[]>(initialTeamContextStores);
  const hydratedInitialStoreIds = useRef(
    new Set(initialTeamContextStores.map((selection) => selection.storeId)),
  );
  useEffect(() => {
    const additions = initialTeamContextStores.filter(
      (selection) => !hydratedInitialStoreIds.current.has(selection.storeId),
    );
    if (additions.length === 0) return;
    for (const selection of additions) hydratedInitialStoreIds.current.add(selection.storeId);
    setTeamContextStores((current) => {
      const selected = new Set(current.map((selection) => selection.storeId));
      return [...current, ...additions.filter((selection) => !selected.has(selection.storeId))];
    });
  }, [initialTeamContextStores]);
  const preservedContextStores =
    props.initial?.spec.contextStores.filter(
      (binding) =>
        !props.contextStoreBindings?.some((candidate) => candidate.resourceRef === binding.ref),
    ) ?? [];
  const [validationError, setValidationError] = useState<string | null>(null);
  const [expectedRevision] = useState(props.baseRevision ?? props.project.revision);

  const submit = () => {
    try {
      const participantIds = [coordinator, ...members]
        .filter(Boolean)
        .map((ref) => ref.slice("expert:".length));
      for (const selection of teamContextStores) {
        const selectedIds =
          selection.visibility.mode === "all" ? [] : selection.visibility.expertIds;
        const visible = participantIds.filter((id) =>
          selection.visibility.mode === "all"
            ? true
            : selection.visibility.mode === "whitelist"
              ? selectedIds.includes(id)
              : !selectedIds.includes(id),
        );
        if (visible.length === 0) throw new Error(t("teamKnowledgeVisibleRequired"));
      }
      const resource = PragmaExpertTeamResourceSchema.parse({
        apiVersion: "pragma/v4",
        kind: "ExpertTeam",
        metadata: {
          id,
          avatarId: props.initial?.metadata.avatarId,
          name,
          description,
          tags: props.initial?.metadata.tags ?? [],
        },
        spec: {
          coordinator: { ref: coordinator },
          members: members.map((ref) => ({ ref })),
          ...(instructions.trim() === "" ? {} : { instructions }),
          contextStores: preservedContextStores,
          delegation: {
            maxConcurrency,
            maxDepth,
            context: props.initial?.spec.delegation.context ?? "context:pragma.context.fresh@v1",
            runtimes: props.initial?.spec.delegation.runtimes ?? {},
            allow: props.initial?.spec.delegation.allow,
          },
        },
      });
      setValidationError(null);
      void props.onSave(resource, teamContextStores, expectedRevision, []);
    } catch (validationFailure) {
      setValidationError(errorMessage(validationFailure));
    }
  };

  return (
    <ResourceEditor
      title={props.mode === "create" ? t("newExpertTeam") : t("editExpertTeam")}
      backLabel={props.mode === "create" ? t("backTeams") : t("backTeamDetail")}
      error={validationError ?? props.error}
      onCancel={props.onCancel}
      onSave={submit}
    >
      <MetadataFields
        name={name}
        description={description}
        onName={setName}
        onDescription={setDescription}
      />
      <TeamExpertSelectors
        experts={experts}
        coordinator={coordinator}
        members={members}
        onCoordinatorChange={(ref) => {
          setCoordinator(ref);
          setMembers((current) => current.filter((memberRef) => memberRef !== ref));
        }}
        onMembersChange={setMembers}
      />
      <TeamContextStoreEditor
        stores={props.contextStores ?? []}
        experts={experts}
        participantRefs={[coordinator, ...members].filter(Boolean)}
        selections={teamContextStores}
        onChange={setTeamContextStores}
      />
      <label>
        {t("teamInstructions")}
        <textarea
          className="team-instructions-input"
          rows={8}
          value={instructions}
          onChange={(event) =>
            setInstructions(
              truncatePragmaTrimmedUnicode(
                event.target.value,
                PRAGMA_TEXT_LIMITS.expertTeam.instructions,
              ),
            )
          }
          maxLength={PRAGMA_TEXT_LIMITS.expertTeam.instructions * 2}
          placeholder={t("teamInstructionsPlaceholder")}
        />
        <span className="team-instructions-hint">
          <span>{t("teamInstructionsHint")}</span>
          <span>
            {pragmaUnicodeLength(instructions.trim())}/{PRAGMA_TEXT_LIMITS.expertTeam.instructions}
          </span>
        </span>
      </label>
      <div className="pragma-two-columns">
        <label>
          {t("maxConcurrency")}
          <input
            type="number"
            min={1}
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(Number(event.target.value))}
          />
        </label>
        <label>
          {t("maxDelegationDepth")}
          <input
            type="number"
            min={1}
            value={maxDepth}
            onChange={(event) => setMaxDepth(Number(event.target.value))}
          />
        </label>
      </div>
      {props.mode === "edit" && props.initial !== undefined ? (
        <AssetMemoryPolicySection
          targetRef={{ type: "pragma.expert-team", id: props.initial.metadata.id }}
        />
      ) : null}
    </ResourceEditor>
  );
}

function TeamContextStoreEditor(props: {
  readonly stores: readonly ContextStore[];
  readonly experts: readonly PragmaExpertResource[];
  readonly participantRefs: readonly string[];
  readonly selections: readonly TeamKnowledgeSelection[];
  readonly onChange: (selections: readonly TeamKnowledgeSelection[]) => void;
}) {
  const { t } = useTranslation("studio");
  const [pickerOpen, setPickerOpen] = useState(false);
  const participantIds = props.participantRefs.map((ref) => ref.slice("expert:".length));
  const participantSet = useMemo(() => new Set(participantIds), [participantIds.join("\0")]);
  useEffect(() => {
    const next = props.selections.map((selection) =>
      selection.visibility.mode === "all"
        ? selection
        : {
            ...selection,
            visibility: {
              ...selection.visibility,
              expertIds: selection.visibility.expertIds.filter((id) => participantSet.has(id)),
            },
          },
    );
    if (JSON.stringify(next) !== JSON.stringify(props.selections)) props.onChange(next);
  }, [participantSet, props.onChange, props.selections]);

  const updateVisibility = (storeId: string, visibility: PragmaExpertTeamContextVisibility) => {
    props.onChange(
      props.selections.map((selection) =>
        selection.storeId === storeId ? { ...selection, visibility } : selection,
      ),
    );
  };

  return (
    <section className="team-context-editor" aria-labelledby="team-context-editor-heading">
      <header>
        <div>
          <h3 id="team-context-editor-heading">{t("teamKnowledgeBases")}</h3>
          <p>{t("teamKnowledgeBasesDescription")}</p>
        </div>
        <div className="team-context-editor-actions">
          <span>{t("selectedCount", { count: props.selections.length })}</span>
          <button
            className="secondary-button"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setPickerOpen(true)}
          >
            {props.selections.length > 0 ? t("editSelection") : t("choose")}
          </button>
        </div>
      </header>
      {props.selections.length === 0 ? (
        <p className="team-context-empty">{t("noneSelected")}</p>
      ) : null}
      {props.selections.map((selection) => {
        const store = props.stores.find((candidate) => candidate.id === selection.storeId);
        if (store === undefined) return null;
        const selectedIds =
          selection.visibility.mode === "all" ? [] : selection.visibility.expertIds;
        return (
          <article className="team-context-selection" key={selection.storeId}>
            <div>
              <strong>{store.name}</strong>
              <small>{t("teamKnowledgeVisibility")}</small>
            </div>
            <SelectMenu<"all" | "blacklist" | "whitelist">
              ariaLabel={t("teamKnowledgeVisibility")}
              className="form-select team-context-visibility-select"
              value={selection.visibility.mode}
              options={[
                { value: "all", label: t("teamKnowledgeVisibilityAll") },
                { value: "blacklist", label: t("teamKnowledgeVisibilityBlacklist") },
                { value: "whitelist", label: t("teamKnowledgeVisibilityWhitelist") },
              ]}
              onChange={(mode) => {
                updateVisibility(
                  selection.storeId,
                  mode === "all"
                    ? { mode }
                    : {
                        mode,
                        expertIds:
                          mode === "whitelist" && participantIds[0] !== undefined
                            ? [participantIds[0]]
                            : [],
                      },
                );
              }}
            />
            {selection.visibility.mode === "all" ? null : (
              <div className="team-context-expert-list">
                {props.participantRefs.map((ref) => {
                  const id = ref.slice("expert:".length);
                  const expert = props.experts.find((candidate) => candidate.metadata.id === id);
                  const checked = selectedIds.includes(id);
                  return (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          updateVisibility(selection.storeId, {
                            mode: selection.visibility.mode,
                            expertIds: event.target.checked
                              ? [...selectedIds, id]
                              : selectedIds.filter((candidate) => candidate !== id),
                          })
                        }
                      />
                      <span>{expert?.metadata.name ?? id}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </article>
        );
      })}
      {pickerOpen ? (
        <ContextStorePickerDialog
          stores={props.stores}
          selectedStoreIds={props.selections.map((selection) => selection.storeId)}
          description={t("teamKnowledgeBasesDescription")}
          footerHint={t("teamKnowledgeSelectionImmediate")}
          onSelectedStoreIdsChange={(storeIds) => {
            const currentSelections = new Map(
              props.selections.map((selection) => [selection.storeId, selection]),
            );
            props.onChange(
              storeIds.map(
                (storeId) =>
                  currentSelections.get(storeId) ?? {
                    storeId,
                    visibility: { mode: "all" },
                  },
              ),
            );
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </section>
  );
}

function TeamExpertSelectors(props: {
  readonly experts: readonly PragmaExpertResource[];
  readonly coordinator: string;
  readonly members: readonly string[];
  readonly onCoordinatorChange: (ref: string) => void;
  readonly onMembersChange: (refs: readonly string[]) => void;
}) {
  const { t } = useTranslation("studio");
  const [activePicker, setActivePicker] = useState<TeamExpertPickerKind | null>(null);
  const [search, setSearch] = useState("");
  const coordinatorExpert = props.experts.find((expert) => expertRef(expert) === props.coordinator);
  const selectedMemberRefs = useMemo(() => new Set(props.members), [props.members]);
  const selectedMemberExperts = props.members.flatMap((ref) => {
    const expert = props.experts.find((candidate) => expertRef(candidate) === ref);
    return expert === undefined ? [] : [expert];
  });

  const closePicker = () => {
    setActivePicker(null);
    setSearch("");
  };

  useEffect(() => {
    if (activePicker === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activePicker]);

  const selectedRefs =
    activePicker === "coordinator"
      ? new Set(props.coordinator ? [props.coordinator] : [])
      : selectedMemberRefs;
  const excludedRef = activePicker === "members" ? props.coordinator : undefined;
  const visibleExperts =
    activePicker === null
      ? []
      : matchingTeamExperts(props.experts, search, selectedRefs, excludedRef);
  const matchingCount =
    activePicker === null
      ? 0
      : matchingTeamExperts(
          props.experts,
          search,
          selectedRefs,
          excludedRef,
          Number.MAX_SAFE_INTEGER,
        ).length;
  const activeSelectedCount =
    activePicker === "coordinator" ? Number(Boolean(props.coordinator)) : props.members.length;

  const openPicker = (picker: TeamExpertPickerKind) => {
    setSearch("");
    setActivePicker(picker);
  };

  return (
    <>
      <div className="team-expert-selectors">
        <section className="team-expert-selector" aria-labelledby="team-coordinator-label">
          <div className="team-expert-selector-heading">
            <div>
              <h3 id="team-coordinator-label">{t("coordinator")}</h3>
              <p>{t("coordinatorFieldDescription")}</p>
            </div>
          </div>
          <button
            className="team-expert-selector-trigger"
            type="button"
            aria-haspopup="dialog"
            onClick={() => openPicker("coordinator")}
          >
            <span className="team-expert-selector-icon" aria-hidden="true">
              <UserCircle size={21} />
            </span>
            <span className="team-expert-selector-value">
              <strong>{coordinatorExpert?.metadata.name ?? t("selectExpert")}</strong>
              <small>
                {coordinatorExpert === undefined
                  ? t("coordinatorEmptyDescription")
                  : `expert:${coordinatorExpert.metadata.id}`}
              </small>
            </span>
            <span className="team-expert-selector-action">
              {coordinatorExpert === undefined ? t("choose") : t("changeSelection")}
              <CaretRight size={16} aria-hidden="true" />
            </span>
          </button>
        </section>

        <section className="team-expert-selector" aria-labelledby="team-members-label">
          <div className="team-expert-selector-heading">
            <div>
              <h3 id="team-members-label">{t("members")}</h3>
              <p>{t("membersFieldDescription")}</p>
            </div>
            <span>{t("selectedCount", { count: props.members.length })}</span>
          </div>
          <button
            className="team-expert-selector-trigger"
            type="button"
            aria-haspopup="dialog"
            onClick={() => openPicker("members")}
          >
            <span className="team-expert-selector-icon" aria-hidden="true">
              <UsersThree size={21} />
            </span>
            <span className="team-expert-selector-value">
              <strong>
                {props.members.length === 0
                  ? t("selectTeamMembers")
                  : t("teamMembersSelected", { count: props.members.length })}
              </strong>
              <small>
                {selectedMemberExperts.length === 0
                  ? t("membersEmptyDescription")
                  : selectedMemberExperts
                      .slice(0, 3)
                      .map((expert) => expert.metadata.name)
                      .join(" · ")}
                {selectedMemberExperts.length > 3
                  ? ` · ${t("moreCount", { count: selectedMemberExperts.length - 3 })}`
                  : ""}
              </small>
            </span>
            <span className="team-expert-selector-action">
              {props.members.length === 0 ? t("choose") : t("editSelection")}
              <CaretRight size={16} aria-hidden="true" />
            </span>
          </button>
        </section>
      </div>

      {activePicker !== null ? (
        <div
          className="expert-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePicker();
          }}
        >
          <aside
            className="expert-picker-dialog team-expert-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-expert-picker-heading"
          >
            <header className="expert-picker-heading">
              <div>
                <small>{t("expertTeam")}</small>
                <h2 id="team-expert-picker-heading">
                  {activePicker === "coordinator" ? t("chooseCoordinator") : t("chooseTeamMembers")}
                </h2>
                <p>
                  {activePicker === "coordinator"
                    ? t("coordinatorPickerDescription")
                    : t("membersPickerDescription")}
                </p>
              </div>
              <button type="button" aria-label={t("closeExpertPicker")} onClick={closePicker}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <label className="expert-picker-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <span className="sr-only">{t("searchExperts")}</span>
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchTeamExpertsDescription")}
              />
              {search ? (
                <button type="button" aria-label={t("clearSearch")} onClick={() => setSearch("")}>
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className="expert-picker-toolbar team-expert-picker-toolbar">
              <span>{t("selectedCount", { count: activeSelectedCount })}</span>
              <div>
                <span>
                  {t("showingMatching", {
                    visible: visibleExperts.length,
                    total: matchingCount,
                  })}
                </span>
                {activeSelectedCount > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      activePicker === "coordinator"
                        ? props.onCoordinatorChange("")
                        : props.onMembersChange([])
                    }
                  >
                    {t("clearSelection")}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="expert-picker-results">
              {visibleExperts.length > 0 ? (
                <div className="expert-picker-list">
                  {visibleExperts.map((expert) => {
                    const ref = expertRef(expert);
                    const selected = selectedRefs.has(ref);
                    return (
                      <label
                        className={`expert-picker-row${selected ? " is-selected" : ""}`}
                        key={ref}
                      >
                        <input
                          type={activePicker === "coordinator" ? "radio" : "checkbox"}
                          name={activePicker === "coordinator" ? "team-coordinator" : undefined}
                          checked={selected}
                          onChange={(event) => {
                            if (activePicker === "coordinator") {
                              props.onCoordinatorChange(ref);
                              return;
                            }
                            props.onMembersChange(
                              event.target.checked
                                ? [...props.members, ref]
                                : props.members.filter((memberRef) => memberRef !== ref),
                            );
                          }}
                        />
                        <span>
                          <strong>{expert.metadata.name}</strong>
                          <small>
                            {expert.metadata.description || `expert:${expert.metadata.id}`}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="expert-picker-empty">
                  <strong>{search.trim() ? t("noMatchesFound") : t("noExpertsAvailable")}</strong>
                  <p>{search.trim() ? t("tryExpertSearch") : t("addExpertsFirst")}</p>
                </div>
              )}
              {matchingCount > visibleExperts.length ? (
                <p className="expert-plugin-result-hint">
                  {t("moreExpertsHidden", { count: matchingCount - visibleExperts.length })}
                </p>
              ) : null}
            </div>
            <footer className="expert-picker-actions">
              <span>
                {activePicker === "members"
                  ? t("coordinatorIncluded")
                  : t("selectionAppliedToTeam")}
              </span>
              <button className="primary-button" type="button" onClick={closePicker}>
                {t("common:actions.done")}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function ResourceEditor(props: {
  readonly title: string;
  readonly backLabel: string;
  readonly error: string | null;
  readonly children: ReactNode;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly saveDisabled?: boolean | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <StudioScreenFrame
      className="pragma-resource-editor"
      labelledBy="resource-editor-heading"
      header={
        <header className="pragma-resource-editor-header">
          <button className="back-link" type="button" onClick={props.onCancel}>
            <ArrowLeft size={18} aria-hidden="true" />
            {props.backLabel}
          </button>
          <h2 id="resource-editor-heading">{props.title}</h2>
        </header>
      }
    >
      <div className="pragma-resource-form">{props.children}</div>
      {props.error ? (
        <p className="form-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <footer>
        <button className="secondary-button" type="button" onClick={props.onCancel}>
          {t("cancel")}
        </button>
        <button
          className="studio-primary-action"
          type="button"
          onClick={props.onSave}
          disabled={props.saveDisabled}
        >
          {t("validatePublish")}
        </button>
      </footer>
    </StudioScreenFrame>
  );
}

function MetadataFields(props: {
  readonly name: string;
  readonly description: string;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <>
      <label>
        {t("name")}
        <input
          value={props.name}
          maxLength={PRAGMA_TEXT_LIMITS.expertTeam.name * 2}
          onChange={(event) =>
            props.onName(
              truncatePragmaTrimmedUnicode(event.target.value, PRAGMA_TEXT_LIMITS.expertTeam.name),
            )
          }
        />
        <CharacterCount value={props.name} max={PRAGMA_TEXT_LIMITS.expertTeam.name} />
      </label>
      <label>
        {t("description")}
        <textarea
          rows={3}
          value={props.description}
          maxLength={PRAGMA_TEXT_LIMITS.expertTeam.description * 2}
          onChange={(event) =>
            props.onDescription(
              truncatePragmaTrimmedUnicode(
                event.target.value,
                PRAGMA_TEXT_LIMITS.expertTeam.description,
              ),
            )
          }
        />
        <CharacterCount value={props.description} max={PRAGMA_TEXT_LIMITS.expertTeam.description} />
      </label>
    </>
  );
}
