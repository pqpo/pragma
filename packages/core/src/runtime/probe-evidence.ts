import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { encodePragmaPathSegment, PragmaPaths } from "../storage/pragma-paths.ts";
import { RUNTIME_FEATURE_CATALOG } from "./features.ts";

export const RUNTIME_PROBE_EVIDENCE_SCHEMA_VERSION = "pragma.runtime-probe-evidence/v1";

const RuntimeProbeAssertionSchema = z
  .object({
    id: z.string().min(1).max(200),
    feature: z.enum(RUNTIME_FEATURE_CATALOG.map(({ name }) => name)),
    stage: z.enum(["materialized", "discovered", "executed", "invariant"]),
    status: z.enum(["passed", "failed", "skipped"]),
    message: z.string().min(1).max(4_000),
  })
  .strict();

export const RuntimeProbeEvidenceSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_PROBE_EVIDENCE_SCHEMA_VERSION),
    runtime: z
      .object({
        id: z.string().min(1).max(200),
        kind: z.string().min(1).max(200),
        version: z.string().min(1).max(200).optional(),
      })
      .strict(),
    probe: z
      .object({
        id: z.string().min(1).max(200),
        version: z.string().min(1).max(50),
      })
      .strict(),
    environment: z
      .object({
        capturedAt: z.string().datetime(),
        platform: z.string().min(1).max(100),
        architecture: z.string().min(1).max(100),
        authenticationMode: z.string().min(1).max(200).optional(),
      })
      .strict(),
    command: z
      .object({
        executable: z.string().min(1).max(500),
        arguments: z.array(z.string().max(1_000)).max(100),
      })
      .strict(),
    assertions: z.array(RuntimeProbeAssertionSchema).min(1).max(500),
    observations: z.array(z.string().max(16_384)).max(1_000).default([]),
    redaction: z
      .object({
        version: z.literal("sha256-placeholders/v1"),
        leakScanPassed: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type RuntimeProbeEvidence = z.infer<typeof RuntimeProbeEvidenceSchema>;
export type RuntimeProbeAssertion = z.infer<typeof RuntimeProbeAssertionSchema>;

export interface RuntimeProbeRedactionOptions {
  readonly home?: string | undefined;
  readonly workspace?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly secrets?: readonly string[] | undefined;
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|private[-_]?key)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}/gi,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}/gi,
  /\bAIza[A-Za-z0-9_-]{12,}/g,
] as const;

export function redactRuntimeProbeValue(
  value: unknown,
  options: RuntimeProbeRedactionOptions = {},
): unknown {
  return redactValue(value, options, new WeakSet<object>());
}

export function assertRuntimeProbeValueIsRedacted(
  value: unknown,
  options: RuntimeProbeRedactionOptions = {},
): void {
  const serialized = JSON.stringify(value);
  for (const secret of options.secrets ?? []) {
    if (secret.length >= 4 && serialized.includes(secret)) {
      throw new Error("Runtime probe evidence contains an explicitly registered secret.");
    }
  }
  for (const [label, path] of [
    ["home", options.home],
    ["workspace", options.workspace],
    ...(options.paths ?? []).map((path, index) => [`registered path ${index + 1}`, path] as const),
  ] as const) {
    if (path !== undefined && path !== "" && serialized.includes(path)) {
      throw new Error(`Runtime probe evidence contains the unredacted ${label} path.`);
    }
  }
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(serialized)) {
      throw new Error(`Runtime probe evidence failed secret-pattern scan: ${pattern.source}`);
    }
  }
}

export function createRuntimeProbeEvidence(
  input: Omit<RuntimeProbeEvidence, "schemaVersion" | "redaction">,
  redaction: RuntimeProbeRedactionOptions = {},
): RuntimeProbeEvidence {
  const sanitized = redactRuntimeProbeValue(input, redaction);
  assertRuntimeProbeValueIsRedacted(sanitized, redaction);
  return RuntimeProbeEvidenceSchema.parse({
    ...(sanitized as object),
    schemaVersion: RUNTIME_PROBE_EVIDENCE_SCHEMA_VERSION,
    redaction: {
      version: "sha256-placeholders/v1",
      leakScanPassed: true,
    },
  });
}

export async function writeRuntimeProbeEvidence(
  evidence: RuntimeProbeEvidence,
  options: {
    readonly paths?: PragmaPaths | undefined;
    readonly fileName?: string | undefined;
  } = {},
): Promise<string> {
  const parsed = RuntimeProbeEvidenceSchema.parse(evidence);
  const paths = options.paths ?? new PragmaPaths();
  const capturedDate = parsed.environment.capturedAt.slice(0, 10);
  const directory = join(
    paths.runtimeProbeArchivesRoot(),
    encodePragmaPathSegment(parsed.runtime.id),
    capturedDate,
  );
  await mkdir(directory, { recursive: true });
  const fileName =
    options.fileName ?? `${encodePragmaPathSegment(parsed.probe.id)}-${randomUUID()}.json`;
  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) {
    throw new Error(`Invalid Runtime probe evidence file name: ${fileName}`);
  }
  const target = join(directory, fileName);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

function redactValue(
  value: unknown,
  options: RuntimeProbeRedactionOptions,
  visited: WeakSet<object>,
  key?: string,
): unknown {
  if (SENSITIVE_KEY.test(key ?? "") && value !== undefined && value !== null) {
    return redactionPlaceholder(String(value));
  }
  if (typeof value === "string") return redactString(value, options);
  if (value === null || typeof value !== "object") return value;
  if (visited.has(value)) return "[redacted:circular]";
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, options, visited));
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      redactValue(entry, options, visited, entryKey),
    ]),
  );
}

function redactString(value: string, options: RuntimeProbeRedactionOptions): string {
  let redacted = value;
  const replacements: readonly (readonly [string | undefined, string])[] = [
    [options.workspace, "[workspace]"],
    [options.home, "[home]"],
    ...(options.paths ?? []).map((path) => [path, "[path]"] as const),
  ];
  for (const [candidate, replacement] of replacements) {
    if (candidate !== undefined && candidate !== "")
      redacted = redacted.split(candidate).join(replacement);
  }
  for (const secret of options.secrets ?? []) {
    if (secret.length >= 4) redacted = redacted.split(secret).join(redactionPlaceholder(secret));
  }
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => redactionPlaceholder(match));
  }
  return redacted;
}

function redactionPlaceholder(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `[redacted:sha256:${digest}]`;
}
