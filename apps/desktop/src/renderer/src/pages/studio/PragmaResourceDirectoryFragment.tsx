import { useMemo, useState, type ReactNode } from "react";

import { GitBranch, Plus, Trash, UsersThree } from "@phosphor-icons/react";
import {
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaFlowResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import type { PragmaProjectSnapshot } from "../../../../shared/desktop-api.ts";

import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";

type ResourceKind = "team" | "flow";

export function PragmaResourceDirectoryFragment(props: {
  readonly kind: ResourceKind;
  readonly project: PragmaProjectSnapshot;
  readonly onProjectChanged: (snapshot: PragmaProjectSnapshot) => void;
}) {
  const [editing, setEditing] = useState<PragmaResource | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resources = props.project.resources.filter((resource) =>
    props.kind === "team" ? resource.kind === "ExpertTeam" : resource.kind === "Flow",
  );

  const save = async (resource: PragmaResource) => {
    const api = desktopApi();
    if (api === undefined) return;
    try {
      const snapshot = await api.upsertPragmaResource({
        expectedRevision: props.project.revision,
        resource,
      });
      props.onProjectChanged(snapshot);
      setEditing(null);
      setError(null);
    } catch (saveError) {
      setError(errorMessage(saveError));
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
        onSave={save}
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
  return (
    <section className="studio-collection pragma-resource-directory">
      <header className="studio-collection-heading">
        <div>
          <h2>{props.kind === "team" ? "Expert teams" : "Flows"}</h2>
          <p>
            {props.kind === "team"
              ? "Governed expert groups with an explicit coordinator and delegation policy."
              : "Durable graphs with explicit transitions, human gates, and bounded loops."}
          </p>
        </div>
        <button className="studio-primary-action" type="button" onClick={() => setEditing("new")}>
          <Plus size={17} aria-hidden="true" /> New {props.kind}
        </button>
      </header>
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
              aria-label={`Delete ${resource.metadata.name}`}
              onClick={() => void remove(resource)}
            >
              <Trash size={17} />
            </button>
          </div>
        ))}
        {resources.length === 0 ? <p className="studio-empty-copy">No {props.kind}s yet.</p> : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function TeamEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly initial?: PragmaExpertTeamResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (resource: PragmaExpertTeamResource) => Promise<void>;
}) {
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
        apiVersion: "pragma/v1",
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
      title={props.initial === undefined ? "New expert team" : "Edit expert team"}
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
        Coordinator
        <select value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>
          <option value="">Select an expert</option>
          {expertRefs.map((expert) => (
            <option key={expert.ref} value={expert.ref}>
              {expert.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Members</legend>
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
          Max concurrency
          <input
            type="number"
            min={1}
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(Number(event.target.value))}
          />
        </label>
        <label>
          Max delegation depth
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

type NodeKind = "action" | "expert" | "team" | "flow" | "human";
type TransitionKind = "goto" | "end" | "repeat" | "route-repeat";
interface NodeDraft {
  readonly id: string;
  readonly version: string;
  readonly kind: NodeKind;
  readonly target: string;
  readonly transition: TransitionKind;
  readonly next: string;
  readonly loopId: string;
  readonly maxIterations: number;
  readonly routeField: string;
  readonly repeatWhen: string;
}

function FlowEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly initial?: PragmaFlowResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (resource: PragmaFlowResource) => Promise<void>;
}) {
  const unsupportedReason = visualFlowUnsupportedReason(props.initial);
  const [id, setId] = useState(props.initial?.metadata.id ?? "");
  const [name, setName] = useState(props.initial?.metadata.name ?? "");
  const [description, setDescription] = useState(props.initial?.metadata.description ?? "");
  const [version, setVersion] = useState(props.initial?.metadata.version ?? "1.0.0");
  const initialNodes = useMemo(() => toNodeDrafts(props.initial), [props.initial]);
  const [nodes, setNodes] = useState<readonly NodeDraft[]>(initialNodes);
  const [start, setStart] = useState(
    props.initial?.spec.graph.start ?? initialNodes[0]?.id ?? "start",
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const targets = resourceTargets(props.project.resources, id);

  if (unsupportedReason !== undefined) {
    return (
      <ResourceEditor
        title="Flow requires YAML editing"
        error={unsupportedReason}
        onCancel={props.onCancel}
        onSave={() => undefined}
        saveDisabled
      >
        <p>
          This Flow uses DSL features that the current visual editor cannot represent without
          changing their meaning. It has been left untouched.
        </p>
      </ResourceEditor>
    );
  }

  const patchNode = (index: number, patch: Partial<NodeDraft>) =>
    setNodes((current) =>
      current.map((node, nodeIndex) => (nodeIndex === index ? { ...node, ...patch } : node)),
    );
  const submit = () => {
    try {
      const steps = Object.fromEntries(nodes.map((node) => [node.id, nodeStep(node)]));
      const transitions = Object.fromEntries(nodes.map((node) => [node.id, nodeTransition(node)]));
      const loops = Object.fromEntries(
        nodes
          .filter((node) => node.transition === "repeat" || node.transition === "route-repeat")
          .map((node) => [node.loopId, { entry: node.next, maxIterations: node.maxIterations }]),
      );
      const resource = PragmaFlowResourceSchema.parse({
        apiVersion: "pragma/v1",
        kind: "Flow",
        metadata: { id, name, description, version, tags: props.initial?.metadata.tags ?? [] },
        spec: {
          input: props.initial?.spec.input,
          output: props.initial?.spec.output,
          limits: props.initial?.spec.limits ?? { maxNodeVisits: 1_000 },
          graph: { start, steps, transitions, loops },
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
      title={props.initial === undefined ? "New flow" : "Edit flow"}
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
        Start node
        <select value={start} onChange={(event) => setStart(event.target.value)}>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.id || "Unnamed node"}
            </option>
          ))}
        </select>
      </label>
      <section className="pragma-flow-nodes">
        <header>
          <h3>Graph nodes</h3>
          <button type="button" onClick={() => setNodes([...nodes, emptyNode(nodes.length + 1)])}>
            <Plus size={16} /> Add node
          </button>
        </header>
        {nodes.map((node, index) => (
          <div className="pragma-flow-node" key={`${index}-${node.id}`}>
            <div className="pragma-flow-node-heading">
              <strong>Node {index + 1}</strong>
              <button
                type="button"
                aria-label="Remove node"
                onClick={() => setNodes(nodes.filter((_, nodeIndex) => nodeIndex !== index))}
              >
                <Trash size={16} />
              </button>
            </div>
            <div className="pragma-three-columns">
              <label>
                ID
                <input
                  value={node.id}
                  onChange={(event) => patchNode(index, { id: event.target.value })}
                />
              </label>
              <label>
                Type
                <select
                  value={node.kind}
                  onChange={(event) =>
                    patchNode(index, { kind: event.target.value as NodeKind, target: "" })
                  }
                >
                  {(["expert", "team", "flow", "human"] as const).map((kind) => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              {node.kind === "human" ? (
                <label>
                  Prompt
                  <input
                    value={node.target}
                    onChange={(event) => patchNode(index, { target: event.target.value })}
                    placeholder="What should the reviewer decide?"
                  />
                </label>
              ) : node.kind === "action" ? (
                <label>
                  Registered action
                  <input
                    value={node.target}
                    onChange={(event) => patchNode(index, { target: event.target.value })}
                    placeholder="action:my_action@v1"
                  />
                </label>
              ) : (
                <label>
                  Target
                  <select
                    value={node.target}
                    onChange={(event) => patchNode(index, { target: event.target.value })}
                  >
                    <option value="">Select target</option>
                    {targets
                      .filter((target) => target.kind === node.kind)
                      .map((target) => (
                        <option key={target.ref} value={target.ref}>
                          {target.label}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            <div className="pragma-three-columns">
              <label>
                Transition
                <select
                  value={node.transition}
                  onChange={(event) =>
                    patchNode(index, { transition: event.target.value as TransitionKind })
                  }
                >
                  <option value="goto">Go to</option>
                  <option value="end">End</option>
                  <option value="repeat">Repeat loop</option>
                  <option value="route-repeat">Route: repeat or end</option>
                </select>
              </label>
              {node.transition !== "end" ? (
                <label>
                  Target node
                  <select
                    value={node.next}
                    onChange={(event) => patchNode(index, { next: event.target.value })}
                  >
                    <option value="">Select node</option>
                    {nodes.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span />
              )}
              {node.transition === "repeat" || node.transition === "route-repeat" ? (
                <label>
                  Loop ID / limit
                  <span className="pragma-inline-inputs">
                    <input
                      value={node.loopId}
                      onChange={(event) => patchNode(index, { loopId: event.target.value })}
                    />
                    <input
                      type="number"
                      min={1}
                      value={node.maxIterations}
                      onChange={(event) =>
                        patchNode(index, { maxIterations: Number(event.target.value) })
                      }
                    />
                  </span>
                </label>
              ) : null}
            </div>
            {node.transition === "route-repeat" ? (
              <div className="pragma-two-columns">
                <label>
                  Route output field
                  <input
                    value={node.routeField}
                    onChange={(event) => patchNode(index, { routeField: event.target.value })}
                    placeholder="approved"
                  />
                </label>
                <label>
                  Repeat when value is
                  <input
                    value={node.repeatWhen}
                    onChange={(event) => patchNode(index, { repeatWhen: event.target.value })}
                    placeholder="false"
                  />
                </label>
              </div>
            ) : null}
          </div>
        ))}
      </section>
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
  return (
    <section className="pragma-resource-editor">
      <header>
        <div>
          <h2>{props.title}</h2>
          <p>Saved as canonical Pragma YAML when published.</p>
        </div>
      </header>
      <div className="pragma-resource-form">{props.children}</div>
      {props.error ? (
        <p className="form-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <footer>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          className="studio-primary-action"
          type="button"
          onClick={props.onSave}
          disabled={props.saveDisabled}
        >
          Validate & publish
        </button>
      </footer>
    </section>
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
  return (
    <>
      <div className="pragma-two-columns">
        <label>
          Resource ID
          <input
            value={props.id}
            disabled={props.lockId}
            onChange={(event) => props.onId(event.target.value)}
          />
        </label>
        <label>
          Version
          <input value={props.version} onChange={(event) => props.onVersion(event.target.value)} />
        </label>
      </div>
      <label>
        Name
        <input value={props.name} onChange={(event) => props.onName(event.target.value)} />
      </label>
      <label>
        Description
        <textarea
          rows={3}
          value={props.description}
          onChange={(event) => props.onDescription(event.target.value)}
        />
      </label>
    </>
  );
}

function resourceTargets(resources: readonly PragmaResource[], currentFlowId: string) {
  const targets = resources.flatMap((resource) => {
    const kind =
      resource.kind === "Expert"
        ? ("expert" as const)
        : resource.kind === "ExpertTeam"
          ? ("team" as const)
          : ("flow" as const);
    if (kind === "flow" && resource.metadata.id === currentFlowId) return [];
    return [
      {
        kind,
        ref: `${kind}:${resource.metadata.id}@${resource.metadata.version}`,
        label: resource.metadata.name,
      },
    ];
  });
  return targets;
}

function emptyNode(index: number): NodeDraft {
  return {
    id: index === 1 ? "start" : `step_${index}`,
    version: "1.0.0",
    kind: "human",
    target: "Approve this step",
    transition: "end",
    next: "",
    loopId: `loop_${index}`,
    maxIterations: 3,
    routeField: "approved",
    repeatWhen: "false",
  };
}

function nodeStep(node: NodeDraft) {
  if (node.kind === "human")
    return { human: { kind: "approval" as const, prompt: node.target }, version: node.version };
  return { [node.kind]: { ref: node.target }, version: node.version };
}

function nodeTransition(node: NodeDraft) {
  if (node.transition === "end") return { end: true as const };
  if (node.transition === "repeat") return { repeat: { loop: node.loopId, goto: node.next } };
  if (node.transition === "route-repeat") {
    return {
      route: node.routeField,
      cases: { [node.repeatWhen]: { repeat: { loop: node.loopId, goto: node.next } } },
      fallback: { end: true as const },
    };
  }
  return { goto: node.next };
}

function toNodeDrafts(flow?: PragmaFlowResource): NodeDraft[] {
  if (flow === undefined) return [emptyNode(1)];
  return Object.entries(flow.spec.graph.steps).map(([id, step]) => {
    const transition = flow.spec.graph.transitions[id];
    const repeat =
      typeof transition === "object" && transition !== null && "repeat" in transition
        ? transition.repeat
        : typeof transition === "object" && transition !== null && "cases" in transition
          ? Object.values(transition.cases).find(
              (target): target is { repeat: { loop: string; goto: string } } =>
                typeof target === "object" && target !== null && "repeat" in target,
            )?.repeat
          : undefined;
    const routedRepeat =
      typeof transition === "object" && transition !== null && "cases" in transition;
    const goto =
      typeof transition === "string"
        ? transition
        : typeof transition === "object" && transition !== null && "goto" in transition
          ? transition.goto
          : "";
    const loop = repeat === undefined ? undefined : flow.spec.graph.loops[repeat.loop];
    const kind: NodeKind =
      step.action !== undefined
        ? "action"
        : step.expert !== undefined
          ? "expert"
          : step.team !== undefined
            ? "team"
            : step.flow !== undefined
              ? "flow"
              : "human";
    const target =
      step.action?.ref ??
      step.expert?.ref ??
      step.team?.ref ??
      step.flow?.ref ??
      step.human?.prompt ??
      "";
    return {
      id,
      version: step.version,
      kind,
      target,
      transition:
        repeat !== undefined
          ? routedRepeat
            ? "route-repeat"
            : "repeat"
          : goto !== ""
            ? "goto"
            : "end",
      next: repeat?.goto ?? goto,
      loopId: repeat?.loop ?? `loop_${id}`,
      maxIterations: loop?.maxIterations ?? 3,
      routeField: routedRepeat ? transition.route : "approved",
      repeatWhen: routedRepeat
        ? (Object.entries(transition.cases).find(
            ([, target]) => typeof target === "object" && target !== null && "repeat" in target,
          )?.[0] ?? "false")
        : "false",
    };
  });
}

export function visualFlowUnsupportedReason(flow?: PragmaFlowResource): string | undefined {
  if (flow === undefined) return undefined;
  const repeatedLoops = new Set<string>();
  for (const [stepId, step] of Object.entries(flow.spec.graph.steps)) {
    if (step.action !== undefined) {
      return `Step ${stepId} uses an Action. Desktop has no registered Action host yet, so this Flow is read-only.`;
    }
    if (
      step.input !== undefined ||
      step.save !== undefined ||
      step.context !== undefined ||
      step.runtime !== undefined ||
      step.runtimes !== undefined
    ) {
      return `Step ${stepId} uses input, state, context, or runtime settings that the visual editor does not yet represent.`;
    }
    if (
      step.human !== undefined &&
      (step.human.kind !== "approval" ||
        step.human.title !== undefined ||
        step.human.questions !== undefined)
    ) {
      return `Human step ${stepId} uses an advanced request that the visual editor does not yet represent.`;
    }
  }
  for (const [stepId, transition] of Object.entries(flow.spec.graph.transitions)) {
    if (typeof transition === "string") continue;
    if ("fail" in transition) {
      return `Transition ${stepId} uses an explicit failure target that the visual editor does not yet represent.`;
    }
    if ("repeat" in transition) {
      repeatedLoops.add(transition.repeat.loop);
      continue;
    }
    if ("route" in transition) {
      const cases = Object.values(transition.cases);
      const repeatCases = cases.filter(
        (target): target is { repeat: { loop: string; goto: string } } =>
          typeof target === "object" && target !== null && "repeat" in target,
      );
      const fallbackIsEnd =
        transition.fallback !== undefined &&
        typeof transition.fallback === "object" &&
        transition.fallback !== null &&
        "end" in transition.fallback;
      if (cases.length !== 1 || repeatCases.length !== 1 || !fallbackIsEnd) {
        return `Route transition ${stepId} is more expressive than the visual repeat-or-end editor.`;
      }
      repeatedLoops.add(repeatCases[0]!.repeat.loop);
    }
  }
  for (const [loopId, loop] of Object.entries(flow.spec.graph.loops)) {
    if (loop.onLimit !== undefined) {
      return `Loop ${loopId} has an onLimit target that the visual editor does not yet represent.`;
    }
    if (!repeatedLoops.has(loopId)) {
      return `Loop ${loopId} is not represented by a repeat transition and cannot be edited visually.`;
    }
  }
  return undefined;
}
