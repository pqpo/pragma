import { Plus, Trash } from "@phosphor-icons/react";
import type {
  PragmaFlowVariable,
  PragmaFlowResource,
  PragmaJsonSchema,
  PragmaResource,
} from "@pragma/interpreter/ast";
import {
  canonicalPragmaResourceRef,
  PragmaRuntimeProfileConfigSchema,
  PragmaRuntimeProfileResourceSchema,
} from "@pragma/interpreter/ast";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopRuntimeAvailability,
  DesktopRuntimeModel,
} from "../../../../../shared/contracts/index.ts";
import { canonicalRuntimeDisplayName, runtimeDisplayName } from "../../../lib/runtime-display.ts";
import {
  SchemaFieldsEditor,
  fieldsToObjectSchema,
  objectSchemaToFields,
  type SchemaFieldDraft,
} from "../JsonSchemaFieldsEditor.tsx";
import {
  flowStepKind,
  flowStepTarget,
  type FlowStep,
  type FlowStepKind,
  type FlowValidationIssue,
} from "./flow-model.ts";
import { stepOutputSchema } from "./flow-canvas-model.ts";
import { InspectorField } from "./flow-inspector-field.tsx";
import { flowVariableOptions } from "./flow-prompt-editor.tsx";

export function emptyResultMapping(
  schema: PragmaJsonSchema,
  path: readonly string[] = [],
): unknown {
  if (schema.type === "object") {
    return Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [
        name,
        emptyResultMapping(child, [...path, name]),
      ]),
    );
  }
  return `$node.output${path.length === 0 ? "" : `.${path.join(".")}`}`;
}

export function ResultMappingEditor(props: {
  readonly flow: PragmaFlowResource;
  readonly schema: Extract<PragmaJsonSchema, { readonly type: "object" }>;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("studio");
  const fields = schemaLeafFields(props.schema);
  return (
    <section className="flow-result-mapping">
      <header>
        <strong>{t("resultMapping")}</strong>
        <small>{t("resultMappingHint")}</small>
      </header>
      {fields.length === 0 ? (
        <small className="flow-field-hint">{t("emptyResultMapping")}</small>
      ) : (
        fields.map((field) => {
          const current = readMappingValue(props.value, field.path);
          const options = resultSourceOptions(props.flow, field.path, {
            terminalResult: t("terminalResultSource"),
            flowInput: t("flowInputSource"),
          });
          const selected =
            typeof current === "string" && options.some((option) => option.value === current)
              ? current
              : "__constant";
          return (
            <div className="flow-result-mapping-row" key={field.path.join(".")}>
              <label>
                <span>{field.path.join(".")}</span>
                <select
                  value={selected}
                  onChange={(event) => {
                    const value =
                      event.target.value === "__constant"
                        ? defaultMappingConstant(field.schema)
                        : event.target.value;
                    props.onChange(setMappingValue(props.value, field.path, value));
                  }}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  <option value="__constant">{t("constantValue")}</option>
                </select>
              </label>
              {selected === "__constant" ? (
                <MappingConstantInput
                  schema={field.schema}
                  value={current}
                  onChange={(value) =>
                    props.onChange(setMappingValue(props.value, field.path, value))
                  }
                />
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}

function MappingConstantInput(props: {
  readonly schema: PragmaJsonSchema;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("studio");
  if (props.schema.type === "boolean") {
    return (
      <select
        aria-label={t("constantValue")}
        value={props.value === true ? "true" : "false"}
        onChange={(event) => props.onChange(event.target.value === "true")}
      >
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  }
  if (props.schema.type === "number" || props.schema.type === "integer") {
    return (
      <input
        aria-label={t("constantValue")}
        type="number"
        step={props.schema.type === "integer" ? 1 : "any"}
        value={typeof props.value === "number" ? props.value : 0}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    );
  }
  if (props.schema.type === "array") {
    return <small className="flow-field-hint">{t("arrayMappingRequiresSource")}</small>;
  }
  return (
    <input
      aria-label={t("constantValue")}
      value={typeof props.value === "string" ? props.value : ""}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function schemaLeafFields(
  schema: PragmaJsonSchema,
  path: readonly string[] = [],
): readonly { readonly path: readonly string[]; readonly schema: PragmaJsonSchema }[] {
  if (schema.type !== "object") return [{ path, schema }];
  return Object.entries(schema.properties).flatMap(([name, child]) =>
    schemaLeafFields(child, [...path, name]),
  );
}

function resultSourceOptions(
  flow: PragmaFlowResource,
  resultPath: readonly string[],
  labels: {
    readonly terminalResult: string;
    readonly flowInput: string;
  },
): readonly { readonly value: string; readonly label: string }[] {
  const suffix = resultPath.length === 0 ? "" : `.${resultPath.join(".")}`;
  const options: Array<{ value: string; label: string }> = [
    { value: `$node.output${suffix}`, label: `${labels.terminalResult}${suffix}` },
  ];
  if (flow.spec.input !== undefined) {
    for (const field of schemaLeafFields(flow.spec.input.schema)) {
      if (field.path.length === 0) continue;
      options.push({
        value: `$flow.input.${field.path.join(".")}`,
        label: `${labels.flowInput}.${field.path.join(".")}`,
      });
    }
  }
  for (const [nodeId, step] of Object.entries(flow.spec.graph.steps)) {
    options.push({
      value: `$state.nodes.${nodeId}.result`,
      label: `${nodeId}.result`,
    });
    const schema = stepOutputSchema(step);
    if (schema !== undefined) {
      for (const field of schemaLeafFields(schema)) {
        if (field.path.length === 0) continue;
        options.push({
          value: `$state.nodes.${nodeId}.result.${field.path.join(".")}`,
          label: `${nodeId}.result.${field.path.join(".")}`,
        });
      }
    }
  }
  return options;
}

function readMappingValue(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function setMappingValue(value: unknown, path: readonly string[], nextValue: unknown): unknown {
  const root =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? structuredClone(value as Record<string, unknown>)
      : {};
  let current = root;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      current[segment] = nextValue;
      return;
    }
    const child = current[segment];
    const next =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? (child as Record<string, unknown>)
        : {};
    current[segment] = next;
    current = next;
  });
  return root;
}

function defaultMappingConstant(schema: PragmaJsonSchema): unknown {
  switch (schema.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties).map(([name, child]) => [
          name,
          defaultMappingConstant(child),
        ]),
      );
  }
}

export function StructuredOutputEditor(props: {
  readonly label?: string | undefined;
  readonly nativeLabel?: string | undefined;
  readonly structuredLabel?: string | undefined;
  readonly nativeHint?: string | undefined;
  readonly fieldsTitle?: string | undefined;
  readonly value: Extract<PragmaJsonSchema, { readonly type: "object" }> | undefined;
  readonly onChange: (
    value: Extract<PragmaJsonSchema, { readonly type: "object" }> | undefined,
  ) => void;
}) {
  const { t } = useTranslation("studio");
  const [fields, setFields] = useState<readonly SchemaFieldDraft[]>(
    props.value === undefined ? [] : objectSchemaToFields(props.value),
  );
  useEffect(() => {
    setFields((current) =>
      props.value === undefined ? [] : objectSchemaToFields(props.value, current),
    );
  }, [props.value]);
  const update = (next: readonly SchemaFieldDraft[]) => {
    setFields(next);
    try {
      props.onChange(fieldsToObjectSchema(next));
    } catch {
      // Keep the in-progress form value; Flow validation remains on the last valid schema.
    }
  };
  return (
    <section className="flow-output-editor">
      <InspectorField label={props.label ?? t("flowOutput")}>
        <select
          value={props.value === undefined ? "native" : "structured"}
          onChange={(event) => {
            if (event.target.value === "native") {
              setFields([]);
              props.onChange(undefined);
            } else {
              const schema = {
                type: "object" as const,
                properties: {},
                required: [],
                additionalProperties: false as const,
              };
              setFields([]);
              props.onChange(schema);
            }
          }}
        >
          <option value="native">{props.nativeLabel ?? t("nativeResult")}</option>
          <option value="structured">{props.structuredLabel ?? t("structuredResult")}</option>
        </select>
      </InspectorField>
      {props.value === undefined ? (
        <small className="flow-field-hint">{props.nativeHint ?? t("nativeResultHint")}</small>
      ) : (
        <SchemaFieldsEditor
          title={props.fieldsTitle ?? t("resultFields")}
          fields={fields}
          onChange={update}
        />
      )}
    </section>
  );
}

export function RuntimeBindingEditor(props: {
  readonly value: FlowStep["runtime"];
  readonly allowModel: boolean;
  readonly targetKind: FlowStepKind;
  readonly targetRef: string;
  readonly resources: readonly PragmaResource[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onSupportingResource: (resource: PragmaResource) => void;
  readonly onChange: (value: FlowStep["runtime"]) => void;
}) {
  const { t } = useTranslation("studio");
  const profiles = runtimeProfiles(props.resources);
  const inheritedProfileRef = targetRuntimeProfileRef(
    props.targetKind,
    props.targetRef,
    props.resources,
  );
  const inheritedProfile = profiles.find((profile) => profile.ref === inheritedProfileRef);
  const selectedProfile = profiles.find((profile) => profile.ref === props.value?.ref);
  const runtimeIsInherited =
    props.value === undefined ||
    (inheritedProfileRef !== undefined && props.value.ref === inheritedProfileRef);
  const selectedRuntimeId = runtimeIsInherited
    ? ""
    : (selectedProfile?.config.runtimeId ?? props.value?.ref ?? "");
  const effectiveRuntimeId =
    selectedRuntimeId === "" ? inheritedProfile?.config.runtimeId : selectedRuntimeId;
  const availability = props.runtimes.find((runtime) => runtime.id === effectiveRuntimeId);
  const models = availability?.models ?? [];
  const profileModel =
    selectedProfile?.config.providerId === undefined || selectedProfile.config.model === undefined
      ? undefined
      : {
          providerId: selectedProfile.config.providerId,
          modelId: selectedProfile.config.model,
        };
  const selectedIdentity =
    props.value?.modelSelection?.model ?? (runtimeIsInherited ? undefined : profileModel);
  const selectedModel = models.find(
    (model) =>
      model.id === selectedIdentity?.modelId && model.provider.id === selectedIdentity?.providerId,
  );
  return (
    <section className="flow-runtime-editor">
      <InspectorField label={t("runtime")}>
        <select
          value={selectedRuntimeId}
          onChange={(event) => {
            const runtimeId = event.target.value;
            if (runtimeId === "") {
              props.onChange(
                props.value?.modelSelection === undefined || inheritedProfileRef === undefined
                  ? undefined
                  : {
                      ref: inheritedProfileRef,
                      modelSelection: props.value.modelSelection,
                    },
              );
              return;
            }
            const runtime = props.runtimes.find((candidate) => candidate.id === runtimeId);
            if (runtime === undefined) return;
            const profile = flowRuntimeProfile(runtime);
            props.onSupportingResource(profile);
            props.onChange({ ref: pragmaResourceRef(profile) });
          }}
        >
          <option value="">{t("inheritExpertRuntime")}</option>
          {selectedRuntimeId !== "" &&
          !props.runtimes.some((runtime) => runtime.id === selectedRuntimeId) ? (
            <option value={selectedRuntimeId}>
              {runtimeDisplayName(t, {
                id: selectedRuntimeId,
                displayName: selectedRuntimeId,
              })}{" "}
              · {t("unavailable")}
            </option>
          ) : null}
          {props.runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id} disabled={runtime.status !== "available"}>
              {runtimeDisplayName(t, runtime)}
              {runtime.status === "available" ? "" : ` · ${t("unavailable")}`}
            </option>
          ))}
        </select>
      </InspectorField>
      {props.allowModel ? (
        <InspectorField label={t("model")}>
          <select
            value={selectedModel === undefined ? "" : runtimeModelKey(selectedModel)}
            onChange={(event) => {
              const model = models.find(
                (candidate) => runtimeModelKey(candidate) === event.target.value,
              );
              const bindingRef =
                selectedRuntimeId === "" ? inheritedProfileRef : selectedProfile?.ref;
              if (bindingRef === undefined) return;
              if (model === undefined) {
                props.onChange(selectedRuntimeId === "" ? undefined : { ref: bindingRef });
                return;
              }
              props.onChange({
                ref: bindingRef,
                modelSelection: {
                  model: { providerId: model.provider.id, modelId: model.id },
                },
              });
            }}
            disabled={effectiveRuntimeId === undefined || availability?.status !== "available"}
          >
            <option value="">
              {selectedRuntimeId === "" ? t("inheritExpertModel") : t("selectModel")}
            </option>
            {models.map((model) => (
              <option key={runtimeModelKey(model)} value={runtimeModelKey(model)}>
                {model.provider.kind === "registered"
                  ? `${model.provider.displayName} / ${model.displayName}`
                  : model.displayName}
              </option>
            ))}
          </select>
        </InspectorField>
      ) : null}
      {props.allowModel &&
      selectedModel?.thinking !== undefined &&
      props.value?.modelSelection !== undefined ? (
        <InspectorField label={t("thinkingLevel")}>
          <select
            value={props.value.modelSelection?.thinkingLevel ?? ""}
            onChange={(event) => {
              if (props.value?.modelSelection === undefined) return;
              const thinkingLevel = event.target.value;
              props.onChange({
                ...props.value,
                modelSelection: {
                  model: props.value.modelSelection.model,
                  ...(thinkingLevel === "" ? {} : { thinkingLevel }),
                },
              });
            }}
          >
            <option value="">{t("runtimeDefault")}</option>
            {selectedModel.thinking.supportedLevels.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </InspectorField>
      ) : null}
      {availability?.modelDiscoveryError ? (
        <small className="form-error">{availability.modelDiscoveryError}</small>
      ) : null}
      {props.allowModel && selectedRuntimeId !== "" && props.value?.modelSelection === undefined ? (
        <small className="form-error">{t("selectModelForRuntime")}</small>
      ) : null}
    </section>
  );
}

function runtimeProfiles(resources: readonly PragmaResource[]) {
  return resources.flatMap((resource) => {
    if (resource.kind !== "RuntimeProfile") return [];
    const config = PragmaRuntimeProfileConfigSchema.safeParse(resource.spec.config);
    if (!config.success) return [];
    return [
      {
        ref: `runtime-profile:${resource.metadata.id}`,
        name: resource.metadata.name,
        config: config.data,
      },
    ];
  });
}

function targetRuntimeProfileRef(
  kind: FlowStepKind,
  targetRef: string,
  resources: readonly PragmaResource[],
): string | undefined {
  const target = resources.find((resource) => canonicalPragmaResourceRef(resource) === targetRef);
  if (kind === "expert" && target?.kind === "Expert") return target.spec.runtime?.ref;
  if (kind !== "team" || target?.kind !== "ExpertTeam") return undefined;
  const coordinator = resources.find(
    (resource) =>
      resource.kind === "Expert" &&
      canonicalPragmaResourceRef(resource) === target.spec.coordinator.ref,
  );
  return coordinator?.kind === "Expert" ? coordinator.spec.runtime?.ref : undefined;
}

export function flowRuntimeProfile(runtime: DesktopRuntimeAvailability) {
  const displayName = canonicalRuntimeDisplayName(runtime);
  return PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: "pragma/v3",
    kind: "RuntimeProfile",
    metadata: {
      id: stableRuntimeKey(runtime.id),
      name: `${displayName} Flow Runtime`,
      description: `Desktop-managed Runtime profile for Flow node overrides using ${displayName}.`,
      tags: ["desktop-managed", "flow-runtime-override"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: runtime.id },
    },
  });
}

function stableRuntimeKey(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function pragmaResourceRef(resource: PragmaResource): string {
  return canonicalPragmaResourceRef(resource);
}

export function mergePragmaResources(
  existing: readonly PragmaResource[],
  additions: readonly PragmaResource[],
): readonly PragmaResource[] {
  const byRef = new Map(existing.map((resource) => [pragmaResourceRef(resource), resource]));
  for (const resource of additions) byRef.set(pragmaResourceRef(resource), resource);
  return [...byRef.values()];
}

export function validateFlowRuntimeSelections(
  flow: PragmaFlowResource,
  resources: readonly PragmaResource[],
): readonly FlowValidationIssue[] {
  const profiles = new Map(runtimeProfiles(resources).map((profile) => [profile.ref, profile]));
  const issues: FlowValidationIssue[] = [];
  for (const [stepId, step] of Object.entries(flow.spec.graph.steps)) {
    const kind = flowStepKind(step);
    if ((kind !== "expert" && kind !== "team") || step.runtime === undefined) continue;
    const inheritedRef = targetRuntimeProfileRef(kind, flowStepTarget(step), resources);
    if (step.runtime.ref === inheritedRef || step.runtime.modelSelection !== undefined) continue;
    const profile = profiles.get(step.runtime.ref);
    if (profile === undefined) continue;
    issues.push({
      path: ["spec", "graph", "steps", stepId, "runtime", "modelSelection"],
      message: "Choose a model when overriding the node Runtime.",
      stepId,
    });
  }
  return issues;
}

function runtimeModelKey(model: DesktopRuntimeModel): string {
  return `${model.provider.id}\u0000${model.id}`;
}

type HumanOption = NonNullable<FlowStep["human"]>["options"][number];

export function removeHumanOption(options: readonly HumanOption[], index: number): HumanOption[] {
  return options.filter((_, current) => current !== index);
}

export function nextHumanOptionNumber(options: readonly HumanOption[]): number {
  let number = 1;
  while (options.some((option) => option.value === `option_${number}`)) number += 1;
  return number;
}

export function HumanOptionsEditor(props: {
  readonly options: readonly HumanOption[];
  readonly onChange: (options: HumanOption[]) => void;
}) {
  const { t } = useTranslation("studio");
  const patch = (index: number, update: (option: HumanOption) => HumanOption) => {
    props.onChange(
      props.options.map((option, current) => (current === index ? update(option) : option)),
    );
  };
  return (
    <div className="flow-human-questions">
      <header className="flow-human-options-header">
        <div>
          <strong>{t("humanOptions")}</strong>
          <small>{t("humanOptionsHint")}</small>
        </div>
      </header>
      {props.options.length === 0 ? (
        <p className="flow-human-options-empty">{t("humanOptionsEmpty")}</p>
      ) : null}
      {props.options.map((option, index) => (
        <section className="flow-human-question-card" key={`${option.value}-${index}`}>
          <header>
            <strong>{t("humanOptionNumber", { number: index + 1 })}</strong>
            <button
              type="button"
              className="flow-inspector-delete"
              aria-label={t("humanRemoveOption", { number: index + 1 })}
              onClick={() => props.onChange(removeHumanOption(props.options, index))}
            >
              <Trash size={14} /> {t("remove")}
            </button>
          </header>
          <InspectorField label={t("humanOptionLabel")}>
            <input
              value={option.label}
              placeholder={t("humanOptionLabelPlaceholder")}
              onChange={(event) =>
                patch(index, (current) => ({ ...current, label: event.target.value }))
              }
            />
          </InspectorField>
          <InspectorField label={t("humanOptionValue")}>
            <input
              value={option.value}
              placeholder={t("humanOptionValuePlaceholder")}
              onChange={(event) =>
                patch(index, (current) => ({
                  ...current,
                  value: event.target.value,
                }))
              }
            />
          </InspectorField>
          <InspectorField label={t("humanOptionDescription")}>
            <input
              value={option.description ?? ""}
              placeholder={t("humanOptionDescriptionPlaceholder")}
              onChange={(event) =>
                patch(index, (current) => ({
                  ...current,
                  description: event.target.value || undefined,
                }))
              }
            />
          </InspectorField>
        </section>
      ))}
      <button
        type="button"
        className="flow-human-add-question"
        onClick={() => {
          const number = nextHumanOptionNumber(props.options);
          props.onChange([
            ...props.options,
            {
              value: `option_${number}`,
              label: t("humanDefaultOption", { number }),
            },
          ]);
        }}
      >
        <Plus size={14} /> {t("humanAddOption")}
      </button>
    </div>
  );
}

export function InputBindingEditor(props: {
  readonly flow: PragmaFlowResource;
  readonly stepId: string;
  readonly schema: Extract<PragmaJsonSchema, { readonly type: "object" }> | undefined;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("studio");
  const variables = flowVariableOptions(props.flow, props.stepId).map((option) => ({
    value: flowVariableExpression(option.variable),
    label: option.label,
  }));
  const variableSelected =
    typeof props.value === "string" && variables.some((option) => option.value === props.value);
  const objectSelected =
    typeof props.value === "object" && props.value !== null && !Array.isArray(props.value);
  const mode =
    props.value === undefined
      ? "flow"
      : variableSelected
        ? "variable"
        : objectSelected
          ? "fields"
          : "constant";
  const fields = props.schema === undefined ? [] : schemaLeafFields(props.schema);

  return (
    <section className="flow-input-binding">
      <InspectorField label={t("inputBindingMode")}>
        <select
          value={mode}
          onChange={(event) => {
            if (event.target.value === "flow") props.onChange(undefined);
            else if (event.target.value === "variable") {
              props.onChange(variables[0]?.value ?? "$flow.input");
            } else if (event.target.value === "fields") {
              props.onChange(props.schema === undefined ? {} : defaultInputMapping(props.schema));
            } else {
              props.onChange({});
            }
          }}
        >
          <option value="flow">{t("useFlowInput")}</option>
          <option value="variable">{t("bindWholeInput")}</option>
          <option value="fields">{t("bindInputFields")}</option>
          <option value="constant">{t("constantInput")}</option>
        </select>
      </InspectorField>
      {mode === "flow" ? (
        <small className="flow-field-hint">{t("useFlowInputHint")}</small>
      ) : mode === "variable" ? (
        <InspectorField label={t("variableSource")}>
          <select
            value={String(props.value)}
            onChange={(event) => props.onChange(event.target.value)}
          >
            {variables.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </InspectorField>
      ) : mode === "fields" ? (
        props.schema === undefined ? (
          <CustomInputBindingFields
            value={props.value}
            variables={variables}
            onChange={props.onChange}
          />
        ) : (
          <div className="flow-input-binding-fields">
            {fields.map((field) => {
              const current = readMappingValue(props.value, field.path);
              const selected =
                typeof current === "string" && variables.some((option) => option.value === current)
                  ? current
                  : "__constant";
              return (
                <div className="flow-result-mapping-row" key={field.path.join(".")}>
                  <label>
                    <span>{field.path.join(".")}</span>
                    <select
                      value={selected}
                      onChange={(event) =>
                        props.onChange(
                          setMappingValue(
                            props.value,
                            field.path,
                            event.target.value === "__constant"
                              ? defaultMappingConstant(field.schema)
                              : event.target.value,
                          ),
                        )
                      }
                    >
                      {variables.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value="__constant">{t("constantValue")}</option>
                    </select>
                  </label>
                  {selected === "__constant" ? (
                    <MappingConstantInput
                      schema={field.schema}
                      value={current}
                      onChange={(value) =>
                        props.onChange(setMappingValue(props.value, field.path, value))
                      }
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <JsonField
          label={t("constantInput")}
          value={props.value}
          onCommit={props.onChange}
          required
        />
      )}
    </section>
  );
}

function CustomInputBindingFields(props: {
  readonly value: unknown;
  readonly variables: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("studio");
  const record =
    typeof props.value === "object" && props.value !== null && !Array.isArray(props.value)
      ? (props.value as Record<string, unknown>)
      : {};
  const entries = Object.entries(record);
  const replace = (previous: string, name: string, value: unknown) =>
    props.onChange(
      Object.fromEntries(
        entries.map(([key, current]) => [
          key === previous ? name : key,
          key === previous ? value : current,
        ]),
      ),
    );
  return (
    <div className="flow-input-binding-fields">
      {entries.map(([name, current]) => {
        const selected =
          typeof current === "string" && props.variables.some((option) => option.value === current)
            ? current
            : "__constant";
        return (
          <div className="flow-result-mapping-row" key={name}>
            <label>
              <span>{t("targetField")}</span>
              <input
                value={name}
                onChange={(event) => replace(name, event.target.value, current)}
              />
            </label>
            <label>
              <span>{t("variableSource")}</span>
              <select
                value={selected}
                onChange={(event) =>
                  replace(name, name, event.target.value === "__constant" ? "" : event.target.value)
                }
              >
                {props.variables.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value="__constant">{t("constantValue")}</option>
              </select>
            </label>
            {selected === "__constant" ? (
              <input
                aria-label={t("constantValue")}
                value={typeof current === "string" ? current : JSON.stringify(current)}
                onChange={(event) => replace(name, name, event.target.value)}
              />
            ) : null}
            <button
              type="button"
              className="flow-inspector-delete"
              onClick={() =>
                props.onChange(Object.fromEntries(entries.filter(([key]) => key !== name)))
              }
            >
              <Trash size={14} /> {t("remove")}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="flow-human-add-question"
        onClick={() => {
          let index = entries.length + 1;
          let name = `field_${index}`;
          while (Object.hasOwn(record, name)) {
            index += 1;
            name = `field_${index}`;
          }
          props.onChange({ ...record, [name]: props.variables[0]?.value ?? "" });
        }}
      >
        <Plus size={14} /> {t("addInputField")}
      </button>
    </div>
  );
}

function flowVariableExpression(variable: PragmaFlowVariable): string {
  if (variable.source === "flow-input") {
    return `$flow.input${variable.path.length === 0 ? "" : `.${variable.path.join(".")}`}`;
  }
  return `$state.nodes.${variable.nodeId}.result${
    variable.path.length === 0 ? "" : `.${variable.path.join(".")}`
  }`;
}

function defaultInputMapping(
  schema: Extract<PragmaJsonSchema, { readonly type: "object" }>,
): unknown {
  return Object.fromEntries(
    Object.entries(schema.properties).map(([name, child]) => [
      name,
      child.type === "object" ? defaultInputMapping(child) : defaultMappingConstant(child),
    ]),
  );
}

function JsonField(props: {
  readonly label: string;
  readonly value: unknown;
  readonly onCommit: (value: unknown) => void;
  readonly required?: boolean;
}) {
  const serialized = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
  const [text, setText] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(serialized), [serialized]);
  return (
    <label className="flow-inspector-field">
      <span>{props.label}</span>
      <textarea
        className={invalid ? "is-invalid" : ""}
        rows={4}
        value={text}
        placeholder={props.required ? "{}" : "Optional JSON"}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onBlur={() => {
          if (text.trim() === "" && !props.required) {
            props.onCommit(undefined);
            return;
          }
          try {
            props.onCommit(JSON.parse(text));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </label>
  );
}
