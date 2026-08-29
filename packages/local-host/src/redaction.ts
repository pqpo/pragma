import type { JsonValue } from "@pragma/shared/integration";

import type { SecretRef, SecretStore, SecretValueHandle } from "./secrets/secret-store.ts";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|access[_-]?key|credential|private[_-]?key|cookie)/iu;

export interface RunRedactor {
  registerSecret(value: string | Uint8Array): void;
  redactText(value: string): string;
  redactJson(value: JsonValue): JsonValue;
}

/** A per-run redactor. Registered values are never persisted by this object. */
export function createRunRedactor(): RunRedactor {
  const secrets = new Set<string>();

  return {
    registerSecret(value) {
      const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
      if (text.length >= 4) secrets.add(text);
    },
    redactText(value) {
      return [...secrets]
        .toSorted((left, right) => right.length - left.length)
        .reduce((current, secret) => current.replaceAll(secret, REDACTED), value);
    },
    redactJson(value) {
      return redactJsonValue(value, (text) => this.redactText(text));
    },
  };
}

export interface LateBoundSecret {
  readonly name: string;
  readonly ref: SecretRef;
}

export interface ResolvedLateBoundSecrets {
  readonly values: Readonly<Record<string, string>>;
  readonly redactor: RunRedactor;
  dispose(): void;
}

/** Resolve only the references required by this run, immediately before execution. */
export async function resolveLateBoundSecrets(
  store: SecretStore,
  bindings: readonly LateBoundSecret[],
): Promise<ResolvedLateBoundSecrets> {
  const handles: SecretValueHandle[] = [];
  const values: Record<string, string> = {};
  const redactor = createRunRedactor();
  try {
    for (const binding of bindings) {
      const handle = await store.get(binding.ref);
      handles.push(handle);
      const value = handle.utf8();
      values[binding.name] = value;
      redactor.registerSecret(value);
    }
  } catch (error) {
    for (const handle of handles) handle.dispose();
    throw error;
  }
  let disposed = false;
  return {
    values,
    redactor,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of handles) handle.dispose();
    },
  };
}

function redactJsonValue(value: JsonValue, redactText: (text: string) => string): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, redactText));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key)
        ? REDACTED
        : redactJsonValue(item as JsonValue, redactText),
    ]),
  );
}
