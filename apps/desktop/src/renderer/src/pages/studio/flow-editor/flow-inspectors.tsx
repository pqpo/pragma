import {
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle,
  DiamondsFour,
  GitBranch,
  Path,
  Plus,
  Robot,
  Sparkle,
  Trash,
  UserFocus,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import type {
  PragmaFlowDestination,
  PragmaFlowResource,
  PragmaResource,
} from "@pragma/interpreter/ast";
import type { Edge } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { stringify } from "yaml";

import type { DesktopRuntimeAvailability } from "../../../../../shared/contracts/index.ts";
import { AssetMemoryPolicySection } from "../../settings/AssetMemoryPolicySection.tsx";
import { flowStepKind, flowStepTarget, type FlowStep } from "./flow-model.ts";
import {
  createRouteTransition,
  destinationLabel,
  edgeDestination,
  flowTargetFromSelect,
  flowTargetSelectValue,
  isArrayRouteTransition,
  isRouteTransition,
  isUnconnectedDestination,
  logicSourceId,
  moveArrayBranch,
  nextArrayBranchId,
  nextCaseKey,
  removeOrphanedLoop,
  renameRouteCase,
  routeFieldOptions,
  setEdgeDestination,
  setStepReference,
  targetInputSchema,
  transitionDestinations,
  unconnectedDestination,
  type ArrayRouteTransition,
  type ResourceTarget,
  type RouteTransition,
} from "./flow-canvas-model.ts";
import {
  HumanOptionsEditor,
  InputBindingEditor,
  ResultMappingEditor,
  RuntimeBindingEditor,
  StructuredOutputEditor,
  emptyResultMapping,
} from "./flow-editor-fields.tsx";
import { InspectorField } from "./flow-inspector-field.tsx";
import { PromptTemplateEditor } from "./flow-prompt-editor.tsx";
import { FlowTimeoutField } from "./flow-timeout.tsx";

export function FlowSettings(props: {
  readonly flow: PragmaFlowResource;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly showMemoryPolicy?: boolean | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="flow-inspector-content">
      <header>
        <span className="flow-inspector-icon">
          <Brain size={19} />
        </span>
        <div>
          <strong>{t("flowSettings")}</strong>
          <small>{t("flowSettingsDescription")}</small>
        </div>
      </header>
      <InspectorField label="Name">
        <input
          value={props.flow.metadata.name}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.metadata.name = event.target.value;
            })
          }
        />
      </InspectorField>
      <InspectorField label="Description">
        <textarea
          rows={3}
          value={props.flow.metadata.description}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.metadata.description = event.target.value;
            })
          }
        />
      </InspectorField>
      <div className="flow-inspector-grid">
        <InspectorField label="Max node visits">
          <input
            type="number"
            min={1}
            value={props.flow.spec.limits.maxNodeVisits}
            onChange={(event) =>
              props.onPatch((copy) => {
                copy.spec.limits.maxNodeVisits = Number(event.target.value);
              })
            }
          />
        </InspectorField>
        <FlowTimeoutField
          timeoutMs={props.flow.spec.limits.timeoutMs}
          onChange={(timeoutMs) =>
            props.onPatch((copy) => {
              copy.spec.limits.timeoutMs = timeoutMs;
            })
          }
        />
      </div>
      <StructuredOutputEditor
        label={t("flowInputContract")}
        nativeLabel={t("freeformInput")}
        structuredLabel={t("structuredInput")}
        nativeHint={t("freeformInputHint")}
        fieldsTitle={t("inputFields")}
        value={props.flow.spec.input?.schema}
        onChange={(schema) =>
          props.onPatch((copy) => {
            copy.spec.input = schema === undefined ? undefined : { schema };
          })
        }
      />
      <StructuredOutputEditor
        label={t("flowOutputContract")}
        nativeLabel={t("uncheckedOutput")}
        structuredLabel={t("structuredResult")}
        nativeHint={t("uncheckedOutputHint")}
        fieldsTitle={t("resultFields")}
        value={props.flow.spec.output?.schema}
        onChange={(schema) =>
          props.onPatch((copy) => {
            if (schema === undefined) {
              delete copy.spec.output;
            } else {
              copy.spec.output = {
                schema,
                ...(copy.spec.output?.value === undefined ? {} : { value: copy.spec.output.value }),
              };
            }
          })
        }
      />
      {props.showMemoryPolicy ? (
        <AssetMemoryPolicySection
          compact
          targetRef={{ type: "pragma.flow", id: props.flow.metadata.id }}
        />
      ) : null}
    </div>
  );
}

export function EndInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="flow-inspector-content">
      <header>
        <span className="flow-inspector-icon is-end">
          <CheckCircle size={19} />
        </span>
        <div>
          <strong>{t("endFlow")}</strong>
          <small>{t("endResultDescription")}</small>
        </div>
      </header>
      {props.flow.spec.output === undefined ? (
        <p className="flow-field-hint">{t("configureOutputContractFirst")}</p>
      ) : (
        <>
          <InspectorField label={t("flowResultSource")}>
            <select
              value={props.flow.spec.output.value === undefined ? "terminal" : "mapping"}
              onChange={(event) =>
                props.onPatch((copy) => {
                  if (copy.spec.output === undefined) return;
                  if (event.target.value === "terminal") delete copy.spec.output.value;
                  else copy.spec.output.value = emptyResultMapping(copy.spec.output.schema);
                })
              }
            >
              <option value="terminal">{t("terminalNodeResult")}</option>
              <option value="mapping">{t("customResultMapping")}</option>
            </select>
          </InspectorField>
          {props.flow.spec.output.value === undefined ? (
            <small className="flow-field-hint">{t("terminalNodeResultHint")}</small>
          ) : (
            <ResultMappingEditor
              flow={props.flow}
              schema={props.flow.spec.output.schema}
              value={props.flow.spec.output.value}
              onChange={(value) =>
                props.onPatch((copy) => {
                  if (copy.spec.output !== undefined) copy.spec.output.value = value;
                })
              }
            />
          )}
        </>
      )}
    </div>
  );
}

export function StepInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly stepId: string;
  readonly targets: readonly ResourceTarget[];
  readonly resources: readonly PragmaResource[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onSupportingResource: (resource: PragmaResource) => void;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly onRename: (nextId: string) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const step = props.flow.spec.graph.steps[props.stepId];
  if (step === undefined) return null;
  const kind = flowStepKind(step);
  const target = flowStepTarget(step);
  const StepIcon =
    kind === "expert"
      ? Robot
      : kind === "team"
        ? UsersThree
        : kind === "flow"
          ? GitBranch
          : kind === "action"
            ? Sparkle
            : UserFocus;
  const kindLabel =
    kind === "expert"
      ? t("expert")
      : kind === "team"
        ? t("expertTeam")
        : kind === "flow"
          ? t("subFlow")
          : kind === "action"
            ? t("action")
            : t("humanInput");
  const patchStep = (mutator: (copy: FlowStep) => void) =>
    props.onPatch((copy) => {
      const current = copy.spec.graph.steps[props.stepId];
      if (current !== undefined) mutator(current);
    });
  return (
    <div className="flow-inspector-content">
      <header>
        <span className={`flow-inspector-icon is-${kind}`}>
          <StepIcon size={19} />
        </span>
        <div>
          <strong>{props.stepId}</strong>
          <small>{t("nodeKind", { kind: kindLabel })}</small>
        </div>
      </header>
      <InspectorField label={t("nodeId")}>
        <input
          key={props.stepId}
          defaultValue={props.stepId}
          onBlur={(event) => props.onRename(event.target.value)}
        />
      </InspectorField>
      {kind === "human" ? (
        <>
          <section className="flow-human-purpose">
            <UserFocus size={18} />
            <div>
              <strong>{t("humanPurposeTitle")}</strong>
              <p>{t("humanPurposeDescription")}</p>
            </div>
          </section>
          <InspectorField label={t("humanSelectionMode")}>
            <select
              value={step.human?.selectionMode}
              onChange={(event) =>
                patchStep((current) => {
                  if (!current.human) return;
                  current.human.selectionMode = event.target.value as NonNullable<
                    FlowStep["human"]
                  >["selectionMode"];
                })
              }
            >
              <option value="single">{t("humanSingleSelection")}</option>
              <option value="multiple">{t("humanMultipleSelection")}</option>
            </select>
          </InspectorField>
          <small className="flow-field-hint">{t("humanSelectionModeHint")}</small>
          <PromptTemplateEditor
            flow={props.flow}
            stepId={props.stepId}
            value={step.human?.prompt}
            label={t("humanPrompt")}
            placeholder={t("humanPromptPlaceholder")}
            onChange={(prompt) =>
              patchStep((current) => {
                if (current.human) current.human.prompt = prompt;
              })
            }
          />
          <HumanOptionsEditor
            options={step.human?.options ?? []}
            onChange={(options) =>
              patchStep((current) => {
                if (current.human) current.human.options = options;
              })
            }
          />
          <section className="flow-human-output">
            <strong>{t("humanOutputVariable")}</strong>
            <code>
              selection: {step.human?.selectionMode === "multiple" ? "string[]" : "string"}
            </code>
            <small>{t("humanOutputVariableHint")}</small>
          </section>
        </>
      ) : kind === "action" ? (
        <InspectorField label="Action reference">
          <input
            value={target}
            onChange={(event) =>
              patchStep((current) => {
                if (current.action) current.action.ref = event.target.value;
              })
            }
            placeholder="action:my_action@v1"
          />
        </InspectorField>
      ) : (
        <InspectorField label="Resource">
          <select
            value={target}
            onChange={(event) =>
              patchStep((current) => setStepReference(current, kind, event.target.value))
            }
          >
            <option value="">{t("selectResource")}</option>
            {target !== "" &&
            !props.targets.some((item) => item.kind === kind && item.ref === target) ? (
              <option value={target}>{target} · unavailable</option>
            ) : null}
            {props.targets
              .filter((item) => item.kind === kind)
              .map((item) => (
                <option key={item.ref} value={item.ref}>
                  {item.label}
                </option>
              ))}
          </select>
        </InspectorField>
      )}
      {kind === "expert" || kind === "team" ? (
        <>
          <PromptTemplateEditor
            flow={props.flow}
            stepId={props.stepId}
            value={step.prompt}
            onChange={(prompt) =>
              patchStep((current) => {
                current.prompt = prompt;
              })
            }
          />
          <StructuredOutputEditor
            value={step.output?.schema}
            onChange={(schema) =>
              patchStep((current) => {
                current.output = schema === undefined ? undefined : { schema };
              })
            }
          />
        </>
      ) : kind === "action" || kind === "flow" ? (
        <InputBindingEditor
          flow={props.flow}
          stepId={props.stepId}
          schema={targetInputSchema(kind, target, props.resources)}
          value={step.input}
          onChange={(value) =>
            patchStep((current) => {
              current.input = value;
            })
          }
        />
      ) : null}
      {kind === "expert" || kind === "team" || kind === "flow" ? (
        <RuntimeBindingEditor
          value={step.runtime}
          allowModel={kind === "expert" || kind === "team"}
          targetKind={kind}
          targetRef={target}
          resources={props.resources}
          runtimes={props.runtimes}
          onSupportingResource={props.onSupportingResource}
          onChange={(runtime) =>
            patchStep((current) => {
              current.runtime = runtime;
            })
          }
        />
      ) : null}
      <details className="flow-advanced-settings">
        <summary>{t("advancedSettings")}</summary>
        {kind === "expert" || kind === "team" ? (
          <InspectorField label="Context">
            <input
              value={step.context ?? ""}
              onChange={(event) =>
                patchStep((current) => {
                  current.context = event.target.value || undefined;
                })
              }
            />
          </InspectorField>
        ) : null}
        <InspectorField label={t("rawNodeDsl")}>
          <pre className="flow-raw-dsl">{stringify(step, { lineWidth: 72 })}</pre>
        </InspectorField>
      </details>

      <button className="flow-delete-node" type="button" onClick={props.onDelete}>
        <Trash size={16} /> Delete node
      </button>
    </div>
  );
}

export function LogicInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly nodeId: string;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const sourceId = logicSourceId(props.nodeId);
  if (sourceId === null) {
    return (
      <div className="flow-inspector-content">
        <header>
          <span className="flow-inspector-icon is-logic">
            <DiamondsFour size={19} />
          </span>
          <div>
            <strong>{t("logicCondition")}</strong>
            <small>{t("logicDraftDescription")}</small>
          </div>
        </header>
        <div className="flow-logic-empty">
          <DiamondsFour size={20} />
          <strong>{t("connectLogicUpstream")}</strong>
          <p>{t("connectLogicUpstreamHint")}</p>
        </div>
        <button className="flow-delete-node" type="button" onClick={props.onDelete}>
          <Trash size={16} /> {t("deleteNode")}
        </button>
      </div>
    );
  }
  const transition = props.flow.spec.graph.transitions[sourceId];
  if (!isRouteTransition(transition)) return null;
  const fields = routeFieldOptions(props.flow, sourceId);
  const currentField = fields.find((field) => field.name === transition.route);
  const booleanField = currentField?.type === "boolean";
  const arrayRoute = isArrayRouteTransition(transition);
  const visibleCases: readonly [string, PragmaFlowDestination][] = arrayRoute
    ? []
    : booleanField
      ? (["true", "false"] as const).map((key) => [
          key,
          transition.cases[key] ?? unconnectedDestination(),
        ])
      : Object.entries(transition.cases);
  const fieldLabel = `${sourceId}.result.${transition.route}`;
  const patchRoute = (mutator: (route: RouteTransition) => void) =>
    props.onPatch((copy) => {
      const route = copy.spec.graph.transitions[sourceId];
      if (isRouteTransition(route)) mutator(route);
    });

  return (
    <div className="flow-inspector-content">
      <header>
        <span className="flow-inspector-icon is-logic">
          <DiamondsFour size={19} />
        </span>
        <div>
          <strong>{t("logicCondition")}</strong>
          <small>{t("logicFromNode", { node: sourceId })}</small>
        </div>
      </header>
      <InspectorField label={t("decisionField")}>
        <select
          value={transition.route}
          onChange={(event) => {
            const field = fields.find((candidate) => candidate.name === event.target.value);
            props.onPatch((copy) => {
              const route = copy.spec.graph.transitions[sourceId];
              if (!isRouteTransition(route)) return;
              const previousDestinations = transitionDestinations(route);
              copy.spec.graph.transitions[sourceId] = createRouteTransition(field);
              for (const destination of previousDestinations) {
                removeOrphanedLoop(copy, destination);
              }
            });
          }}
        >
          {currentField === undefined ? (
            <option value={transition.route}>
              {t("customDecisionField", { field: fieldLabel })}
            </option>
          ) : null}
          {fields.map((field) => (
            <option key={field.name} value={field.name}>
              {sourceId}.result.{field.name} · {field.type}
            </option>
          ))}
        </select>
      </InspectorField>
      {fields.length === 0 || currentField === undefined ? (
        <p className="flow-logic-warning">{t("decisionFieldNotInSchema")}</p>
      ) : (
        <p className="flow-field-hint">{t("decisionFieldHint", { field: fieldLabel })}</p>
      )}
      <section className="flow-logic-branches">
        <header>
          <div>
            <strong>{t("branches")}</strong>
            <small>
              {arrayRoute
                ? t("arrayBranchesHint")
                : booleanField
                  ? t("booleanBranchesHint")
                  : t("exactMatchBranchesHint")}
            </small>
          </div>
          {booleanField ? null : (
            <button
              type="button"
              onClick={() =>
                patchRoute((route) => {
                  if (isArrayRouteTransition(route)) {
                    route.branches = [
                      ...route.branches,
                      {
                        id: nextArrayBranchId(route.branches),
                        operator: "contains_any",
                        values: [currentField?.values?.[0] ?? "value_1"],
                        destination: unconnectedDestination(),
                      },
                    ];
                    return;
                  }
                  const key = nextCaseKey(route.cases);
                  route.cases = { ...route.cases, [key]: unconnectedDestination() };
                })
              }
            >
              <Plus size={14} /> {t("addCase")}
            </button>
          )}
        </header>
        {arrayRoute
          ? transition.branches.map((branch, index) => (
              <div className="flow-logic-array-branch" key={branch.id}>
                <div className="flow-logic-array-branch-heading">
                  <strong>{t("logicBranchNumber", { number: index + 1 })}</strong>
                  <span>
                    <button
                      type="button"
                      disabled={index === 0}
                      aria-label={t("moveBranchUp")}
                      onClick={() =>
                        patchRoute((route) => {
                          if (isArrayRouteTransition(route)) {
                            route.branches = moveArrayBranch(route.branches, index, index - 1);
                          }
                        })
                      }
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={index === transition.branches.length - 1}
                      aria-label={t("moveBranchDown")}
                      onClick={() =>
                        patchRoute((route) => {
                          if (isArrayRouteTransition(route)) {
                            route.branches = moveArrayBranch(route.branches, index, index + 1);
                          }
                        })
                      }
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={transition.branches.length <= 1}
                      aria-label={t("removeCase", { value: branch.id })}
                      onClick={() =>
                        props.onPatch((copy) => {
                          const route = copy.spec.graph.transitions[sourceId];
                          if (!isRouteTransition(route) || !isArrayRouteTransition(route)) return;
                          const removed = route.branches[index]?.destination;
                          route.branches = route.branches.filter((_, current) => current !== index);
                          removeOrphanedLoop(copy, removed);
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  </span>
                </div>
                <InspectorField label={t("arrayMatchOperator")}>
                  <select
                    value={branch.operator}
                    onChange={(event) =>
                      patchRoute((route) => {
                        if (!isArrayRouteTransition(route)) return;
                        route.branches[index] = {
                          ...route.branches[index]!,
                          operator: event.target
                            .value as ArrayRouteTransition["branches"][number]["operator"],
                        };
                      })
                    }
                  >
                    <option value="contains_any">{t("containsAny")}</option>
                    <option value="contains_all">{t("containsAll")}</option>
                    <option value="contains_none">{t("containsNone")}</option>
                  </select>
                </InspectorField>
                {currentField?.values === undefined ? (
                  <InspectorField label={t("arrayMatchValues")}>
                    <input
                      value={branch.values.join(", ")}
                      onChange={(event) =>
                        patchRoute((route) => {
                          if (!isArrayRouteTransition(route)) return;
                          route.branches[index] = {
                            ...route.branches[index]!,
                            values: event.target.value
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          };
                        })
                      }
                    />
                  </InspectorField>
                ) : (
                  <div className="flow-logic-array-values">
                    <span>{t("arrayMatchValues")}</span>
                    {currentField.values.map((value) => (
                      <label key={value}>
                        <input
                          type="checkbox"
                          checked={branch.values.includes(value)}
                          onChange={(event) =>
                            patchRoute((route) => {
                              if (!isArrayRouteTransition(route)) return;
                              const current = route.branches[index]!;
                              route.branches[index] = {
                                ...current,
                                values: event.target.checked
                                  ? [...current.values, value]
                                  : current.values.filter((candidate) => candidate !== value),
                              };
                            })
                          }
                        />
                        <span>{value}</span>
                      </label>
                    ))}
                  </div>
                )}
                <span
                  className={`flow-logic-branch-target${
                    isUnconnectedDestination(branch.destination) ? " is-unconnected" : ""
                  }`}
                >
                  {isUnconnectedDestination(branch.destination)
                    ? t("branchNotConnected")
                    : destinationLabel(branch.destination)}
                </span>
              </div>
            ))
          : visibleCases.map(([key, destination]) => (
              <div className="flow-logic-branch-row" key={key}>
                <span className={`flow-logic-branch-value${booleanField ? " is-boolean" : ""}`}>
                  {booleanField ? (
                    key
                  ) : (
                    <input
                      aria-label={t("caseValue")}
                      value={key}
                      onChange={(event) =>
                        patchRoute((route) => {
                          if (!isArrayRouteTransition(route)) {
                            route.cases = renameRouteCase(route.cases, key, event.target.value);
                          }
                        })
                      }
                    />
                  )}
                </span>
                <span
                  className={`flow-logic-branch-target${
                    isUnconnectedDestination(destination) ? " is-unconnected" : ""
                  }`}
                >
                  {isUnconnectedDestination(destination)
                    ? t("branchNotConnected")
                    : destinationLabel(destination)}
                </span>
                {booleanField ? null : (
                  <button
                    type="button"
                    aria-label={t("removeCase", { value: key })}
                    onClick={() =>
                      props.onPatch((copy) => {
                        const route = copy.spec.graph.transitions[sourceId];
                        if (!isRouteTransition(route) || isArrayRouteTransition(route)) return;
                        const removed = route.cases[key];
                        const next = { ...route.cases };
                        delete next[key];
                        route.cases = next;
                        removeOrphanedLoop(copy, removed);
                      })
                    }
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
        {booleanField ? null : transition.fallback === undefined ? (
          <button
            className="flow-logic-add-fallback"
            type="button"
            onClick={() => patchRoute((route) => (route.fallback = unconnectedDestination()))}
          >
            <Plus size={14} /> {t("addFallback")}
          </button>
        ) : (
          <div className="flow-logic-branch-row is-fallback">
            <span className="flow-logic-branch-value">{t("otherBranch")}</span>
            <span
              className={`flow-logic-branch-target${
                isUnconnectedDestination(transition.fallback) ? " is-unconnected" : ""
              }`}
            >
              {isUnconnectedDestination(transition.fallback)
                ? t("branchNotConnected")
                : destinationLabel(transition.fallback)}
            </span>
          </div>
        )}
      </section>
      <p className="flow-field-hint">{t("dragBranchHint")}</p>
      <details className="flow-advanced-settings">
        <summary>{t("advancedSettings")}</summary>
        <InspectorField label={t("rawTransitionDsl")}>
          <pre className="flow-raw-dsl">{stringify(transition, { lineWidth: 72 })}</pre>
        </InspectorField>
      </details>
      <button className="flow-delete-node" type="button" onClick={props.onDelete}>
        <Trash size={16} /> {t("deleteLogicNode")}
      </button>
    </div>
  );
}

export function EdgeInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly edge: Edge | undefined;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const destination =
    props.edge === undefined ? undefined : edgeDestination(props.flow, props.edge);
  if (props.edge === undefined) {
    return (
      <div className="flow-inspector-content">
        <p className="flow-field-hint">{t("selectControlEdge")}</p>
      </div>
    );
  }
  if (destination === undefined) {
    return (
      <div className="flow-inspector-content">
        <header>
          <span className="flow-inspector-icon">
            <Path size={19} />
          </span>
          <div>
            <strong>{t("flowEdge")}</strong>
            <small>{props.edge.label}</small>
          </div>
        </header>
        <p className="flow-field-hint">{t("logicInputEdgeHint")}</p>
        <button className="flow-delete-node" type="button" onClick={props.onDelete}>
          <Trash size={16} /> {t("deleteEdge")}
        </button>
      </div>
    );
  }
  const mode =
    typeof destination === "object" && "repeat" in destination
      ? "repeat"
      : typeof destination === "object" && "fail" in destination
        ? "fail"
        : "next";
  const patchDestination = (next: PragmaFlowDestination) =>
    props.onPatch((copy) => {
      if (props.edge !== undefined) setEdgeDestination(copy, props.edge, next);
    });
  const loop =
    mode === "repeat" && typeof destination === "object" && "repeat" in destination
      ? props.flow.spec.graph.loops[destination.repeat.loop]
      : undefined;
  return (
    <div className="flow-inspector-content">
      <header>
        <span className={`flow-inspector-icon is-${mode}`}>
          <Path size={19} />
        </span>
        <div>
          <strong>
            {mode === "repeat" ? t("loopEdge") : mode === "fail" ? t("failEdge") : t("flowEdge")}
          </strong>
          <small>{props.edge.label}</small>
        </div>
      </header>
      {mode === "fail" && typeof destination === "object" && "fail" in destination ? (
        <InspectorField label={t("failureMessage")}>
          <input
            value={destination.fail}
            onChange={(event) => patchDestination({ fail: event.target.value })}
          />
        </InspectorField>
      ) : null}
      {mode === "repeat" && typeof destination === "object" && "repeat" in destination ? (
        <>
          <InspectorField label={t("loopId")}>
            <input
              value={destination.repeat.loop}
              onChange={(event) => {
                const nextId = event.target.value;
                props.onPatch((copy) => {
                  if (props.edge === undefined) return;
                  const previousId = destination.repeat.loop;
                  setEdgeDestination(copy, props.edge, {
                    repeat: { loop: nextId, goto: destination.repeat.goto },
                  });
                  const definition = copy.spec.graph.loops[previousId];
                  if (definition !== undefined) {
                    delete copy.spec.graph.loops[previousId];
                    copy.spec.graph.loops[nextId] = definition;
                  }
                });
              }}
            />
          </InspectorField>
          <InspectorField label={t("loopEntry")}>
            <input value={destination.repeat.goto} readOnly />
          </InspectorField>
          <InspectorField label={t("maxIterations")}>
            <input
              type="number"
              min={1}
              value={loop?.maxIterations ?? 3}
              onChange={(event) =>
                props.onPatch((copy) => {
                  copy.spec.graph.loops[destination.repeat.loop] = {
                    ...(copy.spec.graph.loops[destination.repeat.loop] ?? {
                      entry: destination.repeat.goto,
                    }),
                    maxIterations: Math.max(1, Number(event.target.value)),
                  };
                })
              }
            />
          </InspectorField>
          <InspectorField label={t("onLimit")}>
            <select
              value={flowTargetSelectValue(loop?.onLimit)}
              onChange={(event) =>
                props.onPatch((copy) => {
                  const current = copy.spec.graph.loops[destination.repeat.loop];
                  if (current !== undefined)
                    current.onLimit = flowTargetFromSelect(event.target.value);
                })
              }
            >
              <option value="end">{t("endFlow")}</option>
              <option value="fail">{t("failFlow")}</option>
              {Object.keys(props.flow.spec.graph.steps)
                .filter((id) => id !== destination.repeat.goto)
                .map((id) => (
                  <option key={id} value={`goto:${id}`}>
                    {id}
                  </option>
                ))}
            </select>
          </InspectorField>
        </>
      ) : null}
      {mode === "next" ? (
        <p className="flow-field-hint">
          {t("edgeTarget", { target: destinationLabel(destination) })}
        </p>
      ) : null}
      <button className="flow-delete-node" type="button" onClick={props.onDelete}>
        <Trash size={16} /> {t("deleteEdge")}
      </button>
    </div>
  );
}
