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
  Play,
  PencilSimple,
  Plus,
  Trash,
  UserCircle,
  UsersThree,
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
  expertTeamCoordinatorAvatarId,
  type DesktopRuntimeAvailability,
  type PragmaProjectSnapshot,
  type ContextStore,
  type DesktopPragmaContextStoreBinding,
} from "../../../../shared/contracts/index.ts";

import { CharacterCount } from "../../components/CharacterCount.tsx";
import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import {
  PragmaResourcePickerDialog,
  type PragmaResourcePickerItem,
} from "../../components/PragmaResourcePickerDialog.tsx";
import { ProfiledExpertAvatar } from "../../components/ProfiledExpertAvatar.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { AssetMemoryPolicySection } from "../settings/AssetMemoryPolicySection.tsx";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
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
                      <ExpertAvatar
                        avatarId={expertTeamCoordinatorAvatarId(resource, props.project.resources)}
                        team
                        size="md"
                      />
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
  readonly onOpenResource?:
    ((resource: PragmaExpertTeamResource | PragmaFlowResource) => void) | undefined;
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
        {isTeam ? (
          <ProfiledExpertAvatar
            avatarId={expertTeamCoordinatorAvatarId(props.resource, props.project.resources)}
            team
            size="lg"
          />
        ) : (
          <span className="expert-avatar" aria-hidden="true">
            <Icon size={42} />
          </span>
        )}
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
        <FlowDetail
          resource={props.resource}
          project={props.project}
          experts={props.experts ?? []}
          onOpenExpert={props.onOpenExpert}
          onOpenResource={props.onOpenResource}
        />
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
    const thinkingLevel = record?.model?.thinkingLevel ?? runtimeConfig?.thinkingLevel;
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
      avatarId: record?.avatarId ?? resourceExpert?.metadata.avatarId,
      name: record?.name ?? resourceExpert?.metadata.name ?? ref,
      description:
        record?.description ?? resourceExpert?.metadata.description ?? t("noDescription"),
      scope: record?.scope ?? resourceExpert?.spec.scope ?? "",
      runtimeName:
        runtime === undefined ? (runtimeId ?? t("notConfigured")) : runtimeDisplayName(t, runtime),
      modelName:
        modelId === undefined ? t("runtimeDefault") : (runtimeModel?.displayName ?? modelId),
      thinkingDepthName:
        modelId === undefined
          ? t("runtimeDefault")
          : thinkingLevel !== undefined
            ? (runtimeModel?.thinking?.supportedLevels.find(
                (level) => level.value === thinkingLevel,
              )?.label ?? thinkingLevel)
            : runtimeModel?.thinking?.defaultLevel !== undefined
              ? t("defaultThinkingDepth", {
                  value:
                    runtimeModel.thinking.supportedLevels.find(
                      (level) => level.value === runtimeModel.thinking?.defaultLevel,
                    )?.label ?? runtimeModel.thinking.defaultLevel,
                })
              : t("runtimeDefault"),
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
  readonly avatarId: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly runtimeName: string;
  readonly modelName: string;
  readonly thinkingDepthName: string;
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
          <ProfiledExpertAvatar avatarId={props.expert.avatarId} size="sm" />
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
          <div>
            <dt>{t("thinkingDepth")}</dt>
            <dd>{props.expert.thinkingDepthName}</dd>
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
  void visibility;
  void team;
  void project;
  return t("teamKnowledgeVisibilityAll");
}

function FlowDetail(props: {
  readonly resource: PragmaFlowResource;
  readonly project: PragmaProjectSnapshot;
  readonly experts: readonly ExpertRecord[];
  readonly onOpenExpert?: ((expert: ExpertRecord) => void) | undefined;
  readonly onOpenResource?:
    ((resource: PragmaExpertTeamResource | PragmaFlowResource) => void) | undefined;
}) {
  const { t } = useTranslation("studio");
  const steps = Object.entries(props.resource.spec.graph.steps);
  const loops = Object.keys(props.resource.spec.graph.loops);
  const transitionCount = Object.keys(props.resource.spec.graph.transitions).length;
  const startStep = props.resource.spec.graph.start;

  return (
    <div className="flow-detail-content">
      <section className="flow-detail-overview" aria-label={t("flowDetails")}>
        <dl className="flow-overview-facts">
          <div>
            <dt>{t("resourceId")}</dt>
            <dd>
              <code>{canonicalPragmaResourceRef(props.resource)}</code>
            </dd>
          </div>
          <div>
            <dt>{t("startStep")}</dt>
            <dd>
              <Play size={15} weight="fill" aria-hidden="true" />
              {startStep}
            </dd>
          </div>
          <div>
            <dt>{t("limits")}</dt>
            <dd>{t("maxNodeVisits", { count: props.resource.spec.limits.maxNodeVisits })}</dd>
          </div>
        </dl>
      </section>
      <section className="flow-detail-summary" aria-label={t("flowDetails")}>
        <div className="flow-detail-summary-item">
          <span>{t("steps")}</span>
          <strong>{t("stepsCount", { count: steps.length })}</strong>
        </div>
        <div className="flow-detail-summary-item">
          <span>{t("transitions")}</span>
          <strong>{t("transitionCount", { count: transitionCount })}</strong>
          <small>{t("loopCount", { count: loops.length })}</small>
        </div>
        <div className="flow-detail-summary-item">
          <span>{t("flowInputContract")}</span>
          <strong className={props.resource.spec.input === undefined ? "is-muted" : "is-ready"}>
            {props.resource.spec.input === undefined ? t("notConfigured") : t("configured")}
          </strong>
        </div>
        <div className="flow-detail-summary-item">
          <span>{t("flowOutputContract")}</span>
          <strong className={props.resource.spec.output === undefined ? "is-muted" : "is-ready"}>
            {props.resource.spec.output === undefined ? t("notConfigured") : t("configured")}
          </strong>
        </div>
      </section>
      <section className="flow-detail-steps" aria-labelledby="flow-steps-heading">
        <header className="flow-detail-section-heading">
          <div>
            <h2 id="flow-steps-heading">{t("steps")}</h2>
            <p>{t("flowStepsDescription")}</p>
          </div>
        </header>
        <div className="flow-detail-step-list">
          {steps.map(([stepId, step], index) => {
            const target = flowStepTarget(step, props.project, props.experts, t);
            const canOpen =
              (target.expert !== undefined && props.onOpenExpert !== undefined) ||
              (target.resource !== undefined && props.onOpenResource !== undefined);
            return (
              <button
                className={`flow-detail-step-row${stepId === startStep ? " is-start" : ""}`}
                disabled={!canOpen}
                key={stepId}
                onClick={() => {
                  if (target.expert !== undefined) props.onOpenExpert?.(target.expert);
                  else if (target.resource !== undefined) props.onOpenResource?.(target.resource);
                }}
                type="button"
              >
                <span className="flow-detail-step-order" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="flow-detail-step-icon" aria-hidden="true">
                  {target.avatarId === undefined ? (
                    target.kind === "human" ? (
                      <UserCircle size={20} />
                    ) : (
                      <GitBranch size={20} />
                    )
                  ) : (
                    <ExpertAvatar
                      avatarId={target.avatarId}
                      team={target.kind === "team"}
                      size="md"
                    />
                  )}
                </span>
                <div className="flow-detail-step-name">
                  <strong>
                    {stepId}
                    {stepId === startStep ? <span>{t("startStep")}</span> : null}
                    <em>{target.kindLabel}</em>
                  </strong>
                </div>
                <div className="flow-detail-step-target">
                  <strong>{target.name}</strong>
                  {target.description ? (
                    <p className="flow-detail-step-description">{target.description}</p>
                  ) : null}
                  {target.responsibility ? (
                    <p className="flow-detail-step-responsibility">
                      <span>{t("scope")}</span>
                      {target.responsibility}
                    </p>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

type FlowStepTarget = {
  readonly kind: "expert" | "team" | "flow" | "action" | "human";
  readonly kindLabel: string;
  readonly name: string;
  readonly avatarId?: string | undefined;
  readonly description?: string | undefined;
  readonly responsibility?: string | undefined;
  readonly expert?: ExpertRecord | undefined;
  readonly resource?: PragmaExpertTeamResource | PragmaFlowResource | undefined;
};

function flowStepTarget(
  step: PragmaFlowResource["spec"]["graph"]["steps"][string],
  project: PragmaProjectSnapshot,
  experts: readonly ExpertRecord[],
  t: TFunction<"studio">,
): FlowStepTarget {
  if (step.expert !== undefined) {
    const resource = project.resources.find(
      (candidate): candidate is PragmaExpertResource =>
        candidate.kind === "Expert" && expertRef(candidate) === step.expert?.ref,
    );
    const record = experts.find((candidate) => expertRecordRef(candidate) === step.expert?.ref);
    return {
      kind: "expert",
      kindLabel: t("expert"),
      name: record?.name ?? resource?.metadata.name ?? t("unavailable"),
      avatarId: record?.avatarId ?? resource?.metadata.avatarId,
      description: record?.description ?? resource?.metadata.description,
      responsibility: record?.scope ?? resource?.spec.scope,
      expert: record,
    };
  }
  if (step.team !== undefined) {
    const resource = project.resources.find(
      (candidate): candidate is PragmaExpertTeamResource =>
        candidate.kind === "ExpertTeam" && canonicalPragmaResourceRef(candidate) === step.team?.ref,
    );
    return {
      kind: "team",
      kindLabel: t("expertTeam"),
      name: resource?.metadata.name ?? t("unavailable"),
      avatarId:
        resource === undefined
          ? undefined
          : expertTeamCoordinatorAvatarId(resource, project.resources),
      description: resource?.metadata.description,
      responsibility: resource?.spec.instructions?.trim(),
      resource,
    };
  }
  if (step.flow !== undefined) {
    const resource = project.resources.find(
      (candidate): candidate is PragmaFlowResource =>
        candidate.kind === "Flow" && canonicalPragmaResourceRef(candidate) === step.flow?.ref,
    );
    return {
      kind: "flow",
      kindLabel: t("flow"),
      name: resource?.metadata.name ?? t("unavailable"),
      description: resource?.metadata.description,
    };
  }
  if (step.action !== undefined) {
    return { kind: "action", kindLabel: t("action"), name: step.action.ref };
  }
  if (step.human !== undefined) {
    return {
      kind: "human",
      kindLabel: t("human"),
      name: promptSummary(step.human.prompt) || t("human"),
    };
  }
  return {
    kind: "human",
    kindLabel: t("human"),
    name: t("unavailable"),
  };
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
          : [{ storeId: desktopBinding.storeId, visibility: { mode: "all" as const } }];
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
    props.initial?.spec.contextStores
      .filter(
        (binding) =>
          !props.contextStoreBindings?.some((candidate) => candidate.resourceRef === binding.ref),
      )
      .map((binding) => ({ ...binding, visibility: { mode: "all" as const } })) ?? [];
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expectedRevision] = useState(props.baseRevision ?? props.project.revision);

  const submit = async () => {
    if (saving) return;

    let resource: PragmaExpertTeamResource;
    try {
      resource = PragmaExpertTeamResourceSchema.parse({
        apiVersion: "pragma/v4",
        kind: "ExpertTeam",
        metadata: {
          id,
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
    } catch (validationFailure) {
      setValidationError(errorMessage(validationFailure));
      return;
    }

    setValidationError(null);
    setSaving(true);
    try {
      await props.onSave(resource, teamContextStores, expectedRevision, []);
    } catch (saveFailure) {
      setValidationError(errorMessage(saveFailure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ResourceEditor
      className="team-resource-editor"
      title={props.mode === "create" ? t("newExpertTeam") : t("editExpertTeam")}
      backLabel={props.mode === "create" ? t("backTeams") : t("backTeamDetail")}
      error={validationError ?? props.error}
      onCancel={props.onCancel}
      onSave={submit}
      saving={saving}
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
  readonly selections: readonly TeamKnowledgeSelection[];
  readonly onChange: (selections: readonly TeamKnowledgeSelection[]) => void;
}) {
  const { t } = useTranslation("studio");
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <section
      className="team-expert-selector team-knowledge-selector"
      aria-labelledby="team-knowledge-label"
    >
      <div className="team-expert-selector-heading">
        <div>
          <h3 id="team-knowledge-label">{t("teamKnowledgeBases")}</h3>
          <p>{t("teamKnowledgeBasesDescription")}</p>
        </div>
        <span>{t("selectedCount", { count: props.selections.length })}</span>
      </div>
      <button
        className="team-expert-selector-trigger"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setPickerOpen(true)}
      >
        <span className="team-expert-selector-icon" aria-hidden="true">
          <Folder size={21} />
        </span>
        <span className="team-expert-selector-value">
          <strong>
            {props.selections.length === 0
              ? t("teamKnowledgeSelect")
              : t("teamKnowledgeSelected", { count: props.selections.length })}
          </strong>
          <small>{teamKnowledgeStoreNames(props.selections, props.stores, t)}</small>
        </span>
        <span className="team-expert-selector-action">
          {props.selections.length === 0 ? t("choose") : t("editSelection")}
          <CaretRight size={16} aria-hidden="true" />
        </span>
      </button>
      {pickerOpen ? (
        <ContextStorePickerDialog
          stores={props.stores}
          selectedStoreIds={props.selections.map((selection) => selection.storeId)}
          description={t("teamKnowledgePickerDescription")}
          footerHint={t("changesImmediate")}
          onSelectedStoreIdsChange={(storeIds) => {
            const currentSelections = new Map(
              props.selections.map((selection) => [selection.storeId, selection]),
            );
            props.onChange(
              storeIds.map(
                (storeId) =>
                  currentSelections.get(storeId) ?? { storeId, visibility: { mode: "all" } },
              ),
            );
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </section>
  );
}

function teamKnowledgeStoreNames(
  selections: readonly TeamKnowledgeSelection[],
  stores: readonly ContextStore[],
  t: TFunction<"studio">,
): string {
  const names = selections.flatMap((selection) => {
    const store = stores.find((candidate) => candidate.id === selection.storeId);
    return store === undefined ? [] : [store.name];
  });
  if (names.length === 0) return t("noneSelected");
  return names.length > 3
    ? `${names.slice(0, 3).join(" · ")} · ${t("moreCount", { count: names.length - 3 })}`
    : names.join(" · ");
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
  const coordinatorExpert = props.experts.find((expert) => expertRef(expert) === props.coordinator);
  const selectedMemberExperts = props.members.flatMap((ref) => {
    const expert = props.experts.find((candidate) => expertRef(candidate) === ref);
    return expert === undefined ? [] : [expert];
  });
  const pickerItems: readonly PragmaResourcePickerItem[] = props.experts.map((expert) => ({
    ref: expertRef(expert),
    name: expert.metadata.name,
    description: expert.metadata.description,
    searchTerms: [expert.metadata.id, ...expert.metadata.tags],
    kind: "expert",
    avatarId: expert.metadata.avatarId,
  }));

  const closePicker = () => {
    setActivePicker(null);
  };

  const openPicker = (picker: TeamExpertPickerKind) => {
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
        <PragmaResourcePickerDialog
          title={activePicker === "coordinator" ? t("chooseCoordinator") : t("chooseTeamMembers")}
          description={
            activePicker === "coordinator"
              ? t("coordinatorPickerDescription")
              : t("membersPickerDescription")
          }
          items={pickerItems}
          selectedRefs={activePicker === "coordinator" ? [props.coordinator] : props.members}
          selectionMode={activePicker === "coordinator" ? "single" : "multiple"}
          excludedRefs={
            activePicker === "members" && props.coordinator
              ? new Set([props.coordinator])
              : undefined
          }
          searchPlaceholder={t("searchTeamExpertsDescription")}
          footerHint={
            activePicker === "members" ? t("coordinatorIncluded") : t("selectionAppliedToTeam")
          }
          onSelectedRefsChange={(refs) => {
            if (activePicker === "coordinator") props.onCoordinatorChange(refs[0] ?? "");
            else props.onMembersChange(refs);
          }}
          onClose={closePicker}
        />
      ) : null}
    </>
  );
}

function ResourceEditor(props: {
  readonly className?: string | undefined;
  readonly title: string;
  readonly backLabel: string;
  readonly error: string | null;
  readonly children: ReactNode;
  readonly onCancel: () => void;
  readonly onSave: () => void | Promise<void>;
  readonly saving?: boolean | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <StudioScreenFrame
      className={["pragma-resource-editor", props.className].filter(Boolean).join(" ")}
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
        <button
          className="secondary-button"
          type="button"
          onClick={props.onCancel}
          disabled={props.saving}
        >
          {t("cancel")}
        </button>
        <button
          className="primary-button studio-primary-action"
          type="button"
          onClick={props.onSave}
          disabled={props.saving}
          aria-busy={props.saving || undefined}
        >
          {props.saving ? t("actions.saving", { ns: "common" }) : t("validatePublish")}
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
