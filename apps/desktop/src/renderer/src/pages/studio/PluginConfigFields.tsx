import { useEffect, useState } from "react";

import type { DesktopPluginManifest } from "../../../../shared/desktop-api.ts";

export function PluginConfigFields(props: {
  readonly manifest: DesktopPluginManifest;
  readonly values: Readonly<Record<string, unknown>>;
  readonly inherited?: Readonly<Record<string, unknown>> | undefined;
  readonly configuredSecrets: ReadonlySet<string>;
  readonly allowInherit?: boolean | undefined;
  readonly onValuesChange: (values: Record<string, unknown>) => void;
  readonly onSecretChange: (path: string, value: string | null) => void;
}) {
  const properties = flattenConfigurationProperties(props.manifest.configuration);
  return (
    <div className="plugin-config-fields">
      {properties.map((property) => {
        const overridden = hasPath(props.values, property.name);
        const inherited = readPath(props.inherited ?? {}, property.name);
        const manifestDefault = property.default;
        const value = overridden
          ? readPath(props.values, property.name)
          : (inherited ?? manifestDefault);
        return (
          <div className="plugin-config-field" key={property.name}>
            <header>
              <label htmlFor={`plugin-config-${property.name}`}>{property.name}</label>
              {props.allowInherit && !property.secret ? (
                <label className="plugin-inherit-toggle">
                  <input
                    type="checkbox"
                    checked={!overridden}
                    onChange={(event) =>
                      props.onValuesChange(
                        event.target.checked
                          ? removePath(props.values, property.name)
                          : setPath(
                              props.values,
                              property.name,
                              value ?? emptyValue(property.type),
                            ),
                      )
                    }
                  />
                  Inherit default
                </label>
              ) : null}
            </header>
            <small>{property.description}</small>
            {property.secret ? (
              <div className="plugin-secret-input">
                <input
                  id={`plugin-config-${property.name}`}
                  type="password"
                  placeholder={
                    props.configuredSecrets.has(property.name)
                      ? "Secret configured"
                      : property.required
                        ? "Required secret"
                        : "Optional secret"
                  }
                  onChange={(event) => props.onSecretChange(property.name, event.target.value)}
                />
                {props.configuredSecrets.has(property.name) ? (
                  <button type="button" onClick={() => props.onSecretChange(property.name, null)}>
                    Clear
                  </button>
                ) : null}
              </div>
            ) : property.enum !== undefined ? (
              <select
                id={`plugin-config-${property.name}`}
                disabled={props.allowInherit === true && !overridden}
                value={String(value ?? "")}
                onChange={(event) =>
                  props.onValuesChange(
                    setPath(
                      props.values,
                      property.name,
                      property.enum!.find((candidate) => String(candidate) === event.target.value),
                    ),
                  )
                }
              >
                {property.enum.map((candidate) => (
                  <option key={String(candidate)} value={String(candidate)}>
                    {String(candidate)}
                  </option>
                ))}
              </select>
            ) : property.type === "boolean" ? (
              <select
                id={`plugin-config-${property.name}`}
                disabled={props.allowInherit === true && !overridden}
                value={String(value ?? false)}
                onChange={(event) =>
                  props.onValuesChange(
                    setPath(props.values, property.name, event.target.value === "true"),
                  )
                }
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            ) : property.type === "object" || property.type === "array" ? (
              <JsonConfigInput
                id={`plugin-config-${property.name}`}
                disabled={props.allowInherit === true && !overridden}
                type={property.type}
                value={value ?? emptyValue(property.type)}
                onChange={(next) =>
                  props.onValuesChange(setPath(props.values, property.name, next))
                }
              />
            ) : (
              <input
                id={`plugin-config-${property.name}`}
                type={property.type === "number" ? "number" : "text"}
                disabled={props.allowInherit === true && !overridden}
                value={typeof value === "string" || typeof value === "number" ? value : ""}
                onChange={(event) =>
                  props.onValuesChange(
                    setPath(
                      props.values,
                      property.name,
                      property.type === "number" ? Number(event.target.value) : event.target.value,
                    ),
                  )
                }
              />
            )}
          </div>
        );
      })}
      {properties.length === 0 ? (
        <p className="capability-empty">This plugin has no configurable parameters.</p>
      ) : null}
    </div>
  );
}

interface ConfigurationField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "object" | "array";
  readonly description: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly default?: unknown;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
}

function flattenConfigurationProperties(
  schema: Readonly<Record<string, unknown>>,
  prefix = "",
): ConfigurationField[] {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((item): item is string => typeof item === "string")
      : [],
  );
  const fields: ConfigurationField[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue;
    const path = prefix.length === 0 ? name : `${prefix}.${name}`;
    if (value["type"] === "object" && isRecord(value["properties"])) {
      fields.push(...flattenConfigurationProperties(value, path));
      continue;
    }
    const rawType = value["type"] === "integer" ? "number" : value["type"];
    if (!["string", "number", "boolean", "object", "array"].includes(String(rawType))) continue;
    const enumValues = Array.isArray(value["enum"])
      ? value["enum"].filter(
          (item): item is string | number | boolean =>
            typeof item === "string" || typeof item === "number" || typeof item === "boolean",
        )
      : undefined;
    fields.push({
      name: path,
      type: rawType as ConfigurationField["type"],
      description:
        typeof value["description"] === "string" ? value["description"] : `Configure ${path}.`,
      required: required.has(name),
      secret: value["x-pragma-secret"] === true,
      ...(value["default"] === undefined ? {} : { default: value["default"] }),
      ...(enumValues === undefined ? {} : { enum: enumValues }),
    });
  }
  return fields;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function JsonConfigInput(props: {
  readonly id: string;
  readonly disabled: boolean;
  readonly type: "object" | "array";
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const serialized = JSON.stringify(props.value, null, 2);
  const [text, setText] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(serialized);
    setInvalid(false);
  }, [serialized]);
  return (
    <>
      <textarea
        id={props.id}
        disabled={props.disabled}
        spellCheck={false}
        value={text}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            const matchesType =
              props.type === "array"
                ? Array.isArray(parsed)
                : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
            setInvalid(!matchesType);
            if (matchesType) props.onChange(parsed);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? <small className="form-error">Enter a valid JSON {props.type}.</small> : null}
    </>
  );
}

export function readPath(value: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = value;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function hasPath(value: Readonly<Record<string, unknown>>, path: string): boolean {
  let cursor: unknown = value;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
    if (!Object.hasOwn(cursor, segment)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return true;
}

function setPath(
  source: Readonly<Record<string, unknown>>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const result = structuredClone(source) as Record<string, unknown>;
  const segments = path.split(".");
  let cursor = result;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
  return result;
}

function removePath(
  source: Readonly<Record<string, unknown>>,
  path: string,
): Record<string, unknown> {
  const result = structuredClone(source) as Record<string, unknown>;
  const segments = path.split(".");
  let cursor: Record<string, unknown> | undefined = result;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = cursor[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return result;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[segments.at(-1)!];
  return result;
}

function emptyValue(type: ConfigurationField["type"]): unknown {
  if (type === "array") return [];
  if (type === "object") return {};
  if (type === "boolean") return false;
  if (type === "number") return 0;
  return "";
}
