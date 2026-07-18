import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { GitBranch, Plus, Trash, UsersThree } from "@phosphor-icons/react";
import {
  PragmaExpertTeamResourceSchema,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import type { PragmaProjectSnapshot } from "../../../../shared/desktop-api.ts";

import { errorMessage } from "../../lib/errors.ts";
import { FlowEditor } from "./flow-editor/FlowEditor.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type ResourceKind = "team" | "flow";

export function PragmaResourceDirectoryFragment(props: {
  readonly kind: ResourceKind;
  readonly project: PragmaProjectSnapshot;
  readonly onProjectChanged: (snapshot: PragmaProjectSnapshot) => void;
}) {
  const { t } = useTranslation("studio");
  const [editing, setEditing] = useState<PragmaResource | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resources = props.project.resources.filter((resource) =>
    props.kind === "team" ? resource.kind === "ExpertTeam" : resource.kind === "Flow",
  );

  const save = async (resource: PragmaResource): Promise<boolean> => {
    const api = desktopApi();
    if (api === undefined) return false;
    try {
      const snapshot = await api.upsertPragmaResource({
        expectedRevision: props.project.revision,
        resource,
      });
      props.onProjectChanged(snapshot);
      setError(null);
      return true;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return false;
    }
  };

  const remove = async (resource: PragmaResource) => {
    const api = desktopApi();
    if (api === undefined) return;
    try {
      const prefix = resource.kind === "ExpertTeam" ? "team" : "flow";
      const snapshot = await api.deletePragmaResource({
        expectedRevision: props.project.revision,
        ref: `${prefix}:${resource.metadata.id}@${resource.metadata.version}`,
      });
      props.onProjectChanged(snapshot);
      if (resource.kind === "Flow") {
        await api.deleteWorkflowLayout({
          projectId: props.project.projectId,
          flowId: resource.metadata.id,
        });
      }
      setError(null);
    } catch (removeError) {
      setError(errorMessage(removeError));
    }
  };

  if (editing !== null) {
    return props.kind === "team" ? (
      <TeamEditor
        project={props.project}
        initial={editing === "new" || editing.kind !== "ExpertTeam" ? undefined : editing}
        error={error}
        onCancel={() => setEditing(null)}
        onSave={async (resource) => {
          if (await save(resource)) setEditing(null);
        }}
      />
    ) : (
      <FlowEditor
        project={props.project}
        initial={editing === "new" || editing.kind !== "Flow" ? undefined : editing}
        error={error}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    );
  }

  const Icon = props.kind === "team" ? UsersThree : GitBranch;
  const headingId = props.kind === "team" ? "expert-teams-heading" : "flows-heading";
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
          <button className="primary-button" type="button" onClick={() => setEditing("new")}>
            <Plus size={17} aria-hidden="true" />{" "}
            {t("newResource", { kind: props.kind === "team" ? t("expertTeam") : t("flow") })}
          </button>
        </header>
      }
    >
      <div className="studio-asset-rows">
        {resources.map((resource) => (
          <div className="studio-asset-row pragma-resource-row" key={resource.metadata.id}>
            <span className="studio-asset-icon" aria-hidden="true">
              <Icon size={24} />
            </span>
            <button type="button" onClick={() => setEditing(resource)}>
              <strong>{resource.metadata.name}</strong>
              <span>{resource.metadata.description}</span>
            </button>
            <small>{resource.metadata.version}</small>
            <button
              type="button"
              aria-label={t("deleteNamed", { name: resource.metadata.name })}
              onClick={() => void remove(resource)}
            >
              <Trash size={17} />
            </button>
          </div>
        ))}
        {resources.length === 0 ? (
          <p className="studio-empty-copy">
            {t("noResourcesYet", { kind: props.kind === "team" ? t("expertTeam") : t("flow") })}
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </StudioScreenFrame>
  );
}

function TeamEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly initial?: PragmaExpertTeamResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (resource: PragmaExpertTeamResource) => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const experts = props.project.resources.filter(
    (resource): resource is PragmaExpertResource => resource.kind === "Expert",
  );
  const [id, setId] = useState(props.initial?.metadata.id ?? "");
  const [name, setName] = useState(props.initial?.metadata.name ?? "");
  const [description, setDescription] = useState(props.initial?.metadata.description ?? "");
  const [version, setVersion] = useState(props.initial?.metadata.version ?? "1.0.0");
  const [coordinator, setCoordinator] = useState(props.initial?.spec.coordinator.ref ?? "");
  const [members, setMembers] = useState<readonly string[]>(
    props.initial?.spec.members.map((member) => member.ref) ?? [],
  );
  const [maxConcurrency, setMaxConcurrency] = useState(
    props.initial?.spec.delegation.maxConcurrency ?? 4,
  );
  const [maxDepth, setMaxDepth] = useState(props.initial?.spec.delegation.maxDepth ?? 3);
  const [validationError, setValidationError] = useState<string | null>(null);

  const expertRefs = experts.map((expert) => ({
    ref: `expert:${expert.metadata.id}@${expert.metadata.version}`,
    label: expert.metadata.name,
  }));
  const submit = () => {
    try {
      const selected = members.includes(coordinator)
        ? members
        : [coordinator, ...members].filter(Boolean);
      const resource = PragmaExpertTeamResourceSchema.parse({
        apiVersion: "pragma/v2",
        kind: "ExpertTeam",
        metadata: { id, name, description, version, tags: props.initial?.metadata.tags ?? [] },
        spec: {
          coordinator: { ref: coordinator },
          members: selected.map((ref) => ({ ref })),
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
      void props.onSave(resource);
    } catch (validationFailure) {
      setValidationError(errorMessage(validationFailure));
    }
  };

  return (
    <ResourceEditor
      title={props.initial === undefined ? t("newExpertTeam") : t("editExpertTeam")}
      error={validationError ?? props.error}
      onCancel={props.onCancel}
      onSave={submit}
    >
      <MetadataFields
        id={id}
        name={name}
        description={description}
        version={version}
        lockId={props.initial !== undefined}
        onId={setId}
        onName={setName}
        onDescription={setDescription}
        onVersion={setVersion}
      />
      <label>
        {t("coordinator")}
        <select value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>
          <option value="">{t("selectExpert")}</option>
          {expertRefs.map((expert) => (
            <option key={expert.ref} value={expert.ref}>
              {expert.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>{t("members")}</legend>
        {expertRefs.map((expert) => (
          <label className="pragma-check" key={expert.ref}>
            <input
              type="checkbox"
              checked={members.includes(expert.ref)}
              onChange={(event) =>
                setMembers(
                  event.target.checked
                    ? [...members, expert.ref]
                    : members.filter((ref) => ref !== expert.ref),
                )
              }
            />
            {expert.label}
          </label>
        ))}
      </fieldset>
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
    </ResourceEditor>
  );
}

function ResourceEditor(props: {
  readonly title: string;
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
        <header>
          <div>
            <h2 id="resource-editor-heading">{props.title}</h2>
            <p>{t("canonicalYaml")}</p>
          </div>
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
        <button type="button" onClick={props.onCancel}>
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
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly lockId: boolean;
  readonly onId: (value: string) => void;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
  readonly onVersion: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <>
      <div className="pragma-two-columns">
        <label>
          {t("resourceId")}
          <input
            value={props.id}
            disabled={props.lockId}
            onChange={(event) => props.onId(event.target.value)}
          />
        </label>
        <label>
          {t("version")}
          <input value={props.version} onChange={(event) => props.onVersion(event.target.value)} />
        </label>
      </div>
      <label>
        {t("name")}
        <input value={props.name} onChange={(event) => props.onName(event.target.value)} />
      </label>
      <label>
        {t("description")}
        <textarea
          rows={3}
          value={props.description}
          onChange={(event) => props.onDescription(event.target.value)}
        />
      </label>
    </>
  );
}
