import { Plus, X } from "@phosphor-icons/react";
import type { PragmaJsonSchema } from "@pragma/interpreter/ast";
import { useTranslation } from "react-i18next";

export type SchemaFieldType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface SchemaValueDraft {
  readonly type: SchemaFieldType;
  readonly fields: readonly SchemaFieldDraft[];
  readonly item?: SchemaValueDraft;
}

export interface SchemaFieldDraft {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly value: SchemaValueDraft;
}

export function SchemaFieldsEditor(props: {
  readonly title?: string;
  readonly fields: readonly SchemaFieldDraft[];
  readonly depth?: number;
  readonly onChange: (fields: readonly SchemaFieldDraft[]) => void;
}) {
  const { t } = useTranslation("studio");
  const depth = props.depth ?? 2;
  const replace = (index: number, field: SchemaFieldDraft) =>
    props.onChange(
      props.fields.map((current, currentIndex) => (currentIndex === index ? field : current)),
    );
  return (
    <section className="code-schema-fields">
      {props.title ? <h3>{props.title}</h3> : null}
      {props.fields.map((field, index) => (
        <div className="code-schema-field" key={field.id}>
          <div className="code-schema-field-row">
            <input
              aria-label={t("fieldName")}
              value={field.name}
              onChange={(event) => replace(index, { ...field, name: event.target.value })}
              placeholder="field_name"
            />
            <select
              aria-label={t("fieldType")}
              value={field.value.type}
              onChange={(event) =>
                replace(index, {
                  ...field,
                  value: emptySchemaValue(event.target.value as SchemaFieldType),
                })
              }
            >
              {SCHEMA_FIELD_TYPES.map((type) => (
                <option
                  key={type}
                  value={type}
                  disabled={depth >= 5 && (type === "object" || type === "array")}
                >
                  {type}
                </option>
              ))}
            </select>
            <label className="code-required-field">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => replace(index, { ...field, required: event.target.checked })}
              />
              {t("required")}
            </label>
            <button
              type="button"
              aria-label={t("removeField", { name: field.name || t("fieldName") })}
              onClick={() =>
                props.onChange(props.fields.filter((candidate) => candidate !== field))
              }
            >
              <X size={15} />
            </button>
          </div>
          <input
            aria-label={t("fieldDescription")}
            value={field.description}
            onChange={(event) => replace(index, { ...field, description: event.target.value })}
            placeholder={t("optionalFieldDescription")}
          />
          <SchemaValueEditor
            value={field.value}
            depth={depth}
            hideType
            onChange={(value) => replace(index, { ...field, value })}
          />
        </div>
      ))}
      <button
        className="secondary-button"
        type="button"
        onClick={() => props.onChange([...props.fields, newSchemaField()])}
      >
        <Plus size={15} /> {t("addField")}
      </button>
    </section>
  );
}

function SchemaValueEditor(props: {
  readonly value: SchemaValueDraft;
  readonly depth: number;
  readonly hideType?: boolean;
  readonly onChange: (value: SchemaValueDraft) => void;
}) {
  const value = props.value;
  return (
    <div className="code-value-editor">
      {props.hideType ? null : (
        <label>
          Item type
          <select
            value={value.type}
            onChange={(event) =>
              props.onChange(emptySchemaValue(event.target.value as SchemaFieldType))
            }
          >
            {SCHEMA_FIELD_TYPES.map((type) => (
              <option
                key={type}
                value={type}
                disabled={props.depth >= 5 && (type === "object" || type === "array")}
              >
                {type}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.type === "object" ? (
        <SchemaFieldsEditor
          fields={value.fields}
          depth={props.depth + 1}
          onChange={(fields) => props.onChange({ ...value, fields })}
        />
      ) : null}
      {value.type === "array" ? (
        <SchemaValueEditor
          value={value.item ?? emptySchemaValue("string")}
          depth={props.depth + 1}
          onChange={(item) => props.onChange({ ...value, item })}
        />
      ) : null}
    </div>
  );
}

const SCHEMA_FIELD_TYPES: readonly SchemaFieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
];

export function newSchemaField(): SchemaFieldDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    required: true,
    value: emptySchemaValue("string"),
  };
}

export function emptySchemaValue(type: SchemaFieldType): SchemaValueDraft {
  return {
    type,
    fields: [],
    ...(type === "array" ? { item: { type: "string", fields: [] } } : {}),
  };
}

export function objectSchemaToFields(
  schema: Extract<PragmaJsonSchema, { readonly type: "object" }>,
  previousFields: readonly SchemaFieldDraft[] = [],
): readonly SchemaFieldDraft[] {
  const required = new Set(schema.required ?? []);
  const unusedPreviousFields = new Set(previousFields);
  return Object.entries(schema.properties).map(([name, value], index) => {
    const previousAtIndex = previousFields[index];
    const matchingField =
      previousFields.find((field) => unusedPreviousFields.has(field) && field.name === name) ??
      (previousAtIndex !== undefined && unusedPreviousFields.has(previousAtIndex)
        ? previousAtIndex
        : undefined);
    if (matchingField !== undefined) unusedPreviousFields.delete(matchingField);
    return {
      id: matchingField?.id ?? crypto.randomUUID(),
      name,
      description: value.description ?? "",
      required: required.has(name),
      value: schemaValueToDraft(value, matchingField?.value),
    };
  });
}

function schemaValueToDraft(
  schema: PragmaJsonSchema,
  previousValue?: SchemaValueDraft | undefined,
): SchemaValueDraft {
  if (schema.type === "object") {
    return {
      type: "object",
      fields: objectSchemaToFields(
        schema,
        previousValue?.type === "object" ? previousValue.fields : [],
      ),
    };
  }
  if (schema.type === "array") {
    return {
      type: "array",
      fields: [],
      item: schemaValueToDraft(
        schema.items,
        previousValue?.type === "array" ? previousValue.item : undefined,
      ),
    };
  }
  return { type: schema.type, fields: [] };
}

export function fieldsToObjectSchema(
  fields: readonly SchemaFieldDraft[],
): Extract<PragmaJsonSchema, { readonly type: "object" }> {
  const names = fields.map((field) => field.name.trim());
  if (names.some((name) => name === "")) throw new Error("Field names are required.");
  if (new Set(names).size !== names.length) {
    throw new Error("Field names must be unique within each object.");
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      fields.map((field) => [field.name.trim(), valueToSchema(field.value, field.description)]),
    ),
    required: fields.filter((field) => field.required).map((field) => field.name.trim()),
    additionalProperties: false,
  };
}

function valueToSchema(value: SchemaValueDraft, description: string): PragmaJsonSchema {
  const details = description.trim() ? { description: description.trim() } : {};
  if (value.type === "object") return { ...fieldsToObjectSchema(value.fields), ...details };
  if (value.type === "array") {
    return {
      type: "array",
      items: valueToSchema(value.item ?? emptySchemaValue("string"), ""),
      ...details,
    };
  }
  return { type: value.type, ...details };
}
