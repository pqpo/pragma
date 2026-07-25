import { Plus, Trash } from "@phosphor-icons/react";
import type { PragmaJsonSchema } from "@pragma/interpreter/ast";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

type ObjectSchema = Extract<PragmaJsonSchema, { readonly type: "object" }>;

export function SchemaInputForm(props: {
  readonly className?: string | undefined;
  readonly schema: ObjectSchema;
  readonly value: Readonly<Record<string, unknown>>;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}) {
  const { t } = useTranslation("missions");
  return (
    <section
      className={["mission-schema-form", props.className].filter(Boolean).join(" ")}
      aria-label={t("flowInput")}
    >
      <header>
        <strong>{t("flowInput")}</strong>
        <small>{t("flowInputDescription")}</small>
      </header>
      <ObjectFields
        schema={props.schema}
        value={props.value}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    </section>
  );
}

function ObjectFields(props: {
  readonly schema: ObjectSchema;
  readonly value: Readonly<Record<string, unknown>>;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: Readonly<Record<string, unknown>>) => void;
}) {
  const { t } = useTranslation("missions");
  const required = new Set(props.schema.required ?? []);
  if (Object.keys(props.schema.properties).length === 0) {
    return <p className="mission-schema-empty">{t("flowInputEmpty")}</p>;
  }
  return (
    <div className="mission-schema-fields">
      {Object.entries(props.schema.properties).map(([name, schema]) => {
        const included = Object.hasOwn(props.value, name);
        const isRequired = required.has(name);
        return (
          <SchemaField
            key={name}
            name={name}
            schema={schema}
            required={isRequired}
            included={included}
            value={props.value[name]}
            disabled={props.disabled}
            onIncludedChange={(nextIncluded) => {
              const next = { ...props.value };
              if (nextIncluded) next[name] = defaultSchemaValue(schema);
              else delete next[name];
              props.onChange(next);
            }}
            onChange={(value) => props.onChange({ ...props.value, [name]: value })}
          />
        );
      })}
    </div>
  );
}

function SchemaField(props: {
  readonly name: string;
  readonly schema: PragmaJsonSchema;
  readonly required: boolean;
  readonly included: boolean;
  readonly value: unknown;
  readonly disabled?: boolean | undefined;
  readonly onIncludedChange: (included: boolean) => void;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("missions");
  const id = useId();
  const active = props.required || props.included;
  return (
    <section className={`mission-schema-field${active ? "" : " is-disabled"}`}>
      <header>
        <label htmlFor={id}>
          <strong>{props.name}</strong>
          {props.required ? <span>{t("required")}</span> : null}
        </label>
        {props.required ? null : (
          <label className="mission-schema-include">
            <input
              type="checkbox"
              checked={props.included}
              disabled={props.disabled}
              onChange={(event) => props.onIncludedChange(event.target.checked)}
            />
            <span>{t("includeOptionalField")}</span>
          </label>
        )}
      </header>
      {props.schema.description ? <small>{props.schema.description}</small> : null}
      {active ? (
        <SchemaValueInput
          id={id}
          schema={props.schema}
          value={props.value ?? defaultSchemaValue(props.schema)}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      ) : null}
    </section>
  );
}

function SchemaValueInput(props: {
  readonly id?: string | undefined;
  readonly schema: PragmaJsonSchema;
  readonly value: unknown;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("missions");
  if (props.schema.type === "object") {
    return (
      <ObjectFields
        schema={props.schema}
        value={asObject(props.value)}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    );
  }
  if (props.schema.type === "array") {
    const items = Array.isArray(props.value) ? props.value : [];
    const itemSchema = props.schema.items;
    return (
      <div className="mission-schema-array">
        {items.map((item, index) => (
          <div className="mission-schema-array-item" key={index}>
            <SchemaValueInput
              schema={itemSchema}
              value={item}
              disabled={props.disabled}
              onChange={(value) =>
                props.onChange(
                  items.map((current, currentIndex) => (currentIndex === index ? value : current)),
                )
              }
            />
            <button
              type="button"
              aria-label={t("removeArrayItem", { index: index + 1 })}
              disabled={props.disabled}
              onClick={() =>
                props.onChange(items.filter((_, currentIndex) => currentIndex !== index))
              }
            >
              <Trash size={14} />
            </button>
          </div>
        ))}
        <button
          className="secondary-button mission-schema-array-add"
          type="button"
          disabled={props.disabled}
          onClick={() => props.onChange([...items, defaultSchemaValue(itemSchema)])}
        >
          <Plus size={14} /> {t("addArrayItem")}
        </button>
      </div>
    );
  }
  if (props.schema.type === "boolean") {
    return (
      <label className="mission-schema-boolean">
        <input
          id={props.id}
          type="checkbox"
          checked={props.value === true}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span>{props.value === true ? t("enabled") : t("disabled")}</span>
      </label>
    );
  }
  if (props.schema.type === "number" || props.schema.type === "integer") {
    return (
      <input
        id={props.id}
        type="number"
        step={props.schema.type === "integer" ? 1 : "any"}
        value={typeof props.value === "number" ? props.value : 0}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    );
  }
  return (
    <input
      id={props.id}
      type="text"
      value={typeof props.value === "string" ? props.value : ""}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function createSchemaInputValue(schema: ObjectSchema): Readonly<Record<string, unknown>> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([name]) => required.has(name))
      .map(([name, field]) => [name, defaultSchemaValue(field)]),
  );
}

export function isSchemaInputValid(
  schema: ObjectSchema,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(value)
    .success;
}

function defaultSchemaValue(schema: PragmaJsonSchema): unknown {
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
      return createSchemaInputValue(schema);
  }
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
