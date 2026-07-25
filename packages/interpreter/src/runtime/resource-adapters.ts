import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  ContextSystem,
  FileSystemContextStore,
  StaticContextStore,
  createCodeServiceMcpServer,
  createHttpServiceMcpServer,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertAgentContextStore,
  type IExpertAgentMcpConfig,
  type IExpertAgentModelsConfig,
  type IExpertAgentSkillsConfig,
} from "@pragma/core";
import { z } from "zod";

import {
  PragmaArtifactSourceSchema,
  PragmaScheduleAutomationConfigSchema,
  PragmaRuntimeProfileConfigSchema,
  type PragmaArtifactSource,
  type PragmaAutomationResource,
  type PragmaBindingRef,
  type PragmaCapabilityResource,
  type PragmaContextStoreResource,
  type PragmaDeclarativeResource,
  type PragmaDiagnostic,
  type PragmaResourceHealth,
  type PragmaRuntimeProfileResource,
  type PragmaSemanticResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import { canonicalPragmaResourceRef } from "../ast/resource-identity.ts";
import {
  PragmaHttpToolSchema,
  PragmaObjectJsonSchemaSchema,
} from "../ast/tool-capability.schema.ts";

export interface PragmaBindingRecord {
  readonly ref: PragmaBindingRef;
  readonly revision: string;
  readonly fingerprint: string;
  readonly value: unknown;
}

export interface PragmaArtifactRecord {
  readonly source: PragmaArtifactSource;
  readonly contentHash: string;
  readonly path?: string | undefined;
  readonly text?: string | undefined;
}

export interface PragmaAdapterHost {
  readonly environmentId: string;
  readonly projectRoot: string;
  readonly resolveBinding: (ref: PragmaBindingRef) => Promise<PragmaBindingRecord | undefined>;
  readonly resolveArtifact: (source: PragmaArtifactSource) => Promise<PragmaArtifactRecord>;
  readonly resolveSecret: (ref: string) => Promise<string | undefined>;
}

export interface PragmaCapabilityContribution {
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
}

export interface PragmaContextStoreContribution {
  readonly store: ExpertAgentContextStore;
}

export interface PragmaRuntimeProfileContribution {
  readonly runtimeId: string;
  readonly models?: IExpertAgentModelsConfig | undefined;
}

export interface PragmaAutomationContribution {
  readonly adapter: string;
  readonly binding: PragmaBindingRef;
  readonly config: unknown;
}

export type PragmaResourceContribution =
  | PragmaCapabilityContribution
  | PragmaContextStoreContribution
  | PragmaRuntimeProfileContribution
  | PragmaAutomationContribution;

export interface PragmaAdapterVerification {
  readonly fingerprint: string;
  readonly contribution: PragmaResourceContribution;
}

export interface PragmaResourceAdapter<TResource extends PragmaDeclarativeResource> {
  readonly id: string;
  readonly version: string;
  readonly kind: TResource["kind"];
  readonly configSchema: z.ZodType;
  readonly bindingSchema?: z.ZodType | undefined;
  readonly bindingRequired?: boolean | undefined;
  /** Enumerates immutable artifact dependencies after adapter-owned config normalization. */
  readonly artifactSources?: ((config: unknown) => readonly PragmaArtifactSource[]) | undefined;
  readonly verify: (input: {
    readonly resource: TResource;
    readonly config: unknown;
    readonly binding: PragmaBindingRecord | undefined;
    readonly host: PragmaAdapterHost;
  }) => Promise<PragmaAdapterVerification>;
}

export interface ResolvedPragmaResource<TContribution extends PragmaResourceContribution> {
  readonly ref: PragmaSemanticResourceRef;
  readonly contribution: TContribution;
  readonly health: PragmaResourceHealth;
}

export interface PragmaResourceInspection<TContribution extends PragmaResourceContribution> {
  readonly ref: PragmaSemanticResourceRef;
  readonly health: PragmaResourceHealth;
  readonly contribution?: TContribution | undefined;
}

export class PragmaResourceNeedsAttentionError extends Error {
  constructor(readonly health: PragmaResourceHealth) {
    super(health.issues[0]?.message ?? `Pragma resource needs attention: ${health.ref}`);
    this.name = "PragmaResourceNeedsAttentionError";
  }
}

export class PragmaResourceAdapterRegistry {
  private readonly adapters = new Map<string, PragmaResourceAdapter<PragmaDeclarativeResource>>();

  register<TResource extends PragmaDeclarativeResource>(
    adapter: PragmaResourceAdapter<TResource>,
  ): this {
    const key = `${adapter.kind}:${adapter.id}@${adapter.version}`;
    if (this.adapters.has(key)) throw new Error(`Duplicate Pragma resource adapter: ${key}`);
    this.adapters.set(key, adapter as unknown as PragmaResourceAdapter<PragmaDeclarativeResource>);
    return this;
  }

  validate(resource: PragmaDeclarativeResource): readonly PragmaDiagnostic[] {
    const adapter = this.find(resource);
    if (adapter === undefined) {
      return [
        diagnostic("adapter.not_found", `Resource adapter not found: ${resource.spec.adapter}`),
      ];
    }
    const parsed = adapter.configSchema.safeParse(resource.spec.config);
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          severity: "error" as const,
          code: "adapter.config.invalid",
          message: issue.message,
          path: [
            "spec",
            "config",
            ...issue.path.map((segment) =>
              typeof segment === "symbol" ? (segment.description ?? "symbol") : segment,
            ),
          ],
        }));
  }

  artifactSources(resource: PragmaDeclarativeResource): readonly PragmaArtifactSource[] {
    const adapter = this.find(resource);
    if (adapter === undefined) return [];
    const config = adapter.configSchema.parse(resource.spec.config);
    return adapter.artifactSources?.(config) ?? [];
  }

  async resolve<TContribution extends PragmaResourceContribution>(
    resource: PragmaDeclarativeResource,
    host: PragmaAdapterHost,
  ): Promise<ResolvedPragmaResource<TContribution>> {
    const inspection = await this.inspect<TContribution>(resource, host);
    if (inspection.health.status !== "ready" || inspection.contribution === undefined) {
      throw new PragmaResourceNeedsAttentionError(inspection.health);
    }
    return {
      ref: inspection.ref,
      contribution: inspection.contribution,
      health: inspection.health,
    };
  }

  async inspect<TContribution extends PragmaResourceContribution>(
    resource: PragmaDeclarativeResource,
    host: PragmaAdapterHost,
  ): Promise<PragmaResourceInspection<TContribution>> {
    const adapter = this.find(resource);
    const resourceFingerprint = sha256(stableStringify(resource));
    const ref = canonicalPragmaResourceRef(resource);
    let binding: PragmaBindingRecord | undefined;
    try {
      if (adapter === undefined)
        throw new Error(`Resource adapter not found: ${resource.spec.adapter}`);
      const config = adapter.configSchema.parse(resource.spec.config);
      binding =
        resource.spec.binding === undefined
          ? undefined
          : await host.resolveBinding(resource.spec.binding);
      if (adapter.bindingRequired === true && binding === undefined) {
        throw new Error(`Binding not found: ${resource.spec.binding ?? "<missing>"}`);
      }
      if (binding !== undefined) {
        if (binding.ref !== resource.spec.binding) {
          throw new Error("Binding resolver returned a record for a different reference.");
        }
        if (!/^[a-f0-9]{64}$/.test(binding.fingerprint)) {
          throw new Error(`Binding fingerprint is invalid: ${binding.ref}`);
        }
        if (adapter.bindingSchema !== undefined) adapter.bindingSchema.parse(binding.value);
      }
      const declaredArtifacts = adapter.artifactSources?.(config) ?? [];
      const declaredArtifactKeys = new Set(declaredArtifacts.map(stableStringify));
      const verificationHost: PragmaAdapterHost = {
        ...host,
        async resolveArtifact(source) {
          if (!declaredArtifactKeys.has(stableStringify(source))) {
            throw new Error(
              `Adapter ${adapter.id}@${adapter.version} requested an undeclared artifact dependency.`,
            );
          }
          return await host.resolveArtifact(source);
        },
      };
      const verification = await adapter.verify({
        resource,
        config,
        binding,
        host: verificationHost,
      });
      return {
        ref,
        contribution: verification.contribution as TContribution,
        health: {
          ref,
          resourceFingerprint,
          ...(binding === undefined ? {} : { bindingRevision: binding.revision }),
          adapter: resource.spec.adapter,
          status: "ready",
          verificationFingerprint: sha256(
            stableStringify({
              adapter: verification.fingerprint,
              binding: binding?.fingerprint,
            }),
          ),
          checkedAt: new Date().toISOString(),
          issues: [],
        },
      };
    } catch (error) {
      return {
        ref,
        health: {
          ref,
          resourceFingerprint,
          ...(binding === undefined ? {} : { bindingRevision: binding.revision }),
          adapter: resource.spec.adapter,
          status: "needs_attention",
          checkedAt: new Date().toISOString(),
          issues: [
            diagnostic(
              "environment.resource_unavailable",
              error instanceof Error ? error.message : String(error),
            ),
          ],
        },
      };
    }
  }

  private find(
    resource: PragmaDeclarativeResource,
  ): PragmaResourceAdapter<PragmaDeclarativeResource> | undefined {
    return this.adapters.get(`${resource.kind}:${resource.spec.adapter}`);
  }
}

const SkillConfigSchema = z
  .object({
    source: PragmaArtifactSourceSchema,
    entry: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => !isAbsolute(value) && !value.split(/[\\/]/).includes(".."),
        "Skill entry must stay inside the artifact.",
      )
      .default("SKILL.md"),
  })
  .strict();

const McpConfigSchema = z
  .object({
    serverKey: z.string().trim().min(1).max(80),
    timeoutMs: z.number().int().positive().default(30_000),
  })
  .strict();

const McpBindingSchema = z.discriminatedUnion("transport", [
  z
    .object({
      transport: z.literal("stdio"),
      command: z.string().trim().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z
    .object({
      transport: z.enum(["streamable-http", "sse"]),
      url: z.string().url(),
      tokenSecretRef: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

const HttpConfigSchema = z
  .object({
    serverKey: z.string().trim().min(1).max(80),
    timeoutMs: z.number().int().positive().default(30_000),
    tools: z.array(PragmaHttpToolSchema).min(1).max(200),
  })
  .strict();

const HttpBindingSchema = z
  .object({
    baseUrl: z.string().url(),
    auth: z.discriminatedUnion("type", [
      z.object({ type: z.literal("none") }).strict(),
      z.object({ type: z.literal("bearer"), secretRef: z.string().min(1) }).strict(),
      z
        .object({
          type: z.literal("api_key_header"),
          headerName: z.string().min(1),
          secretRef: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();

const CodeConfigSchema = z
  .object({
    source: PragmaArtifactSourceSchema,
    timeoutMs: z.number().int().min(100).max(10_000).default(2_000),
    tool: z
      .object({
        name: z.string().trim().min(1).max(128),
        description: z.string().trim().min(1).max(2_000),
        inputSchema: PragmaObjectJsonSchemaSchema,
        outputSchema: PragmaObjectJsonSchemaSchema,
      })
      .strict(),
  })
  .strict();

const HostCapabilityConfigSchema = z.object({ key: z.string().trim().min(1) }).strict();
const HostCapabilityBindingSchema = z
  .object({
    contribution: z.custom<PragmaCapabilityContribution>(isCapabilityContribution),
  })
  .strict();

const FileContextConfigSchema = z.object({ source: PragmaArtifactSourceSchema }).strict();
const StaticContextConfigSchema = z
  .object({
    entries: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          content: z.string(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict();
const HostContextConfigSchema = z.object({ key: z.string().trim().min(1) }).strict();
const HostContextBindingSchema = z
  .object({
    store: z.custom<ExpertAgentContextStore>(isContextStore),
  })
  .strict();

const ScheduleAutomationBindingSchema = z
  .object({
    workspace: z.string().trim().min(1).max(2_000),
    placement: z.literal("desktop").default("desktop"),
    toolPermissionMode: z
      .enum(["request-approval", "auto-approve", "full-access"])
      .default("request-approval"),
    modelOverride: z.unknown().optional(),
  })
  .strict();

export function createDefaultPragmaResourceAdapterRegistry(): PragmaResourceAdapterRegistry {
  return new PragmaResourceAdapterRegistry()
    .register(skillAdapter())
    .register(mcpAdapter())
    .register(httpAdapter())
    .register(codeAdapter())
    .register(hostCapabilityAdapter())
    .register(fileContextAdapter())
    .register(staticContextAdapter("pragma.context.note"))
    .register(staticContextAdapter("pragma.context.static"))
    .register(hostContextAdapter())
    .register(scheduleAutomationAdapter())
    .register(runtimeProfileAdapter());
}

function scheduleAutomationAdapter(): PragmaResourceAdapter<PragmaAutomationResource> {
  return {
    id: "pragma.automation.schedule",
    version: "v1",
    kind: "Automation",
    configSchema: PragmaScheduleAutomationConfigSchema,
    bindingSchema: ScheduleAutomationBindingSchema,
    bindingRequired: true,
    async verify({ resource, config, binding }) {
      PragmaScheduleAutomationConfigSchema.parse(config);
      ScheduleAutomationBindingSchema.parse(binding!.value);
      return {
        fingerprint: sha256(stableStringify({ config, binding: binding!.revision })),
        contribution: {
          adapter: resource.spec.adapter,
          binding: resource.spec.binding,
          config,
        },
      };
    },
  };
}

function skillAdapter(): PragmaResourceAdapter<PragmaCapabilityResource> {
  return {
    id: "pragma.capability.skill",
    version: "v1",
    kind: "Capability",
    configSchema: SkillConfigSchema,
    artifactSources: (config) => [SkillConfigSchema.parse(config).source],
    async verify({ resource, config, host }) {
      const parsed = SkillConfigSchema.parse(config);
      const artifact = await verifiedArtifact(host, parsed.source);
      if (artifact.path === undefined)
        throw new Error("Skill artifacts must materialize to a path.");
      const root = await realpath(artifact.path);
      if (!(await lstat(root)).isDirectory())
        throw new Error("Skill artifacts must materialize to a directory.");
      const entry = await realpath(resolve(root, parsed.entry));
      const child = relative(root, entry);
      if (child.startsWith("..") || isAbsolute(child))
        throw new Error(`Skill entry escapes its artifact: ${parsed.entry}`);
      if (!(await lstat(entry)).isFile())
        throw new Error(`Skill entry is not a regular file: ${parsed.entry}`);
      return {
        fingerprint: artifact.contentHash,
        contribution: {
          skills: {
            skills: [
              {
                type: parsed.source.type === "project" ? "local" : "registry",
                name: resource.metadata.name,
                description: resource.metadata.description,
                path: entry,
                baseDir: root,
              },
            ],
          },
        },
      };
    },
  };
}

function mcpAdapter(): PragmaResourceAdapter<PragmaCapabilityResource> {
  return {
    id: "pragma.capability.mcp",
    version: "v1",
    kind: "Capability",
    configSchema: McpConfigSchema,
    bindingSchema: McpBindingSchema,
    bindingRequired: true,
    async verify({ resource, config, binding, host }) {
      const parsed = McpConfigSchema.parse(config);
      const value = McpBindingSchema.parse(binding!.value);
      const server =
        value.transport === "stdio"
          ? {
              name: resource.metadata.name,
              transport: value.transport,
              command: value.command,
              args: value.args,
              env: value.env,
              timeout: parsed.timeoutMs,
            }
          : {
              name: resource.metadata.name,
              transport: value.transport,
              url: value.url,
              ...(value.tokenSecretRef === undefined
                ? {}
                : { token: await requireSecret(host, value.tokenSecretRef) }),
              timeout: parsed.timeoutMs,
            };
      return {
        fingerprint: sha256(stableStringify({ parsed, binding: binding!.revision })),
        contribution: { mcp: { mcpServers: { [parsed.serverKey]: server } } },
      };
    },
  };
}

function httpAdapter(): PragmaResourceAdapter<PragmaCapabilityResource> {
  return {
    id: "pragma.capability.http",
    version: "v1",
    kind: "Capability",
    configSchema: HttpConfigSchema,
    bindingSchema: HttpBindingSchema,
    bindingRequired: true,
    async verify({ resource, config, binding, host }) {
      const parsed = HttpConfigSchema.parse(config);
      const value = HttpBindingSchema.parse(binding!.value);
      const auth =
        value.auth.type === "none"
          ? value.auth
          : value.auth.type === "bearer"
            ? { type: "bearer" as const, token: await requireSecret(host, value.auth.secretRef) }
            : {
                type: "api_key_header" as const,
                headerName: value.auth.headerName,
                value: await requireSecret(host, value.auth.secretRef),
              };
      const inProcess = createHttpServiceMcpServer({
        name: resource.metadata.name,
        baseUrl: value.baseUrl,
        auth,
        timeoutMs: parsed.timeoutMs,
        tools: parsed.tools,
      });
      return {
        fingerprint: sha256(stableStringify({ parsed, binding: binding!.revision })),
        contribution: {
          mcp: {
            mcpServers: {
              [parsed.serverKey]: {
                name: resource.metadata.name,
                transport: "in-process",
                timeout: parsed.timeoutMs,
                inProcess,
                toolApprovals: Object.fromEntries(
                  parsed.tools.map((tool) => [
                    tool.name,
                    { mode: tool.method === "POST" ? "required" : "ask" },
                  ]),
                ),
              },
            },
          },
        },
      };
    },
  };
}

function codeAdapter(): PragmaResourceAdapter<PragmaCapabilityResource> {
  return {
    id: "pragma.capability.code",
    version: "v1",
    kind: "Capability",
    configSchema: CodeConfigSchema,
    artifactSources: (config) => [CodeConfigSchema.parse(config).source],
    async verify({ resource, config, host }) {
      const parsed = CodeConfigSchema.parse(config);
      const artifact = await verifiedArtifact(host, parsed.source);
      if (artifact.text === undefined) throw new Error("Code artifacts must materialize as text.");
      const tool = { ...parsed.tool, source: artifact.text };
      return {
        fingerprint: artifact.contentHash,
        contribution: {
          mcp: {
            mcpServers: {
              [resource.metadata.id]: {
                name: resource.metadata.name,
                transport: "in-process",
                timeout: parsed.timeoutMs,
                inProcess: createCodeServiceMcpServer({
                  name: resource.metadata.name,
                  timeoutMs: parsed.timeoutMs,
                  tool,
                }),
              },
            },
          },
        },
      };
    },
  };
}

function hostCapabilityAdapter(): PragmaResourceAdapter<PragmaCapabilityResource> {
  return {
    id: "pragma.capability.host",
    version: "v1",
    kind: "Capability",
    configSchema: HostCapabilityConfigSchema,
    bindingSchema: HostCapabilityBindingSchema,
    bindingRequired: true,
    async verify({ binding }) {
      const value = HostCapabilityBindingSchema.parse(binding!.value);
      return {
        fingerprint: sha256(binding!.revision),
        contribution: value.contribution,
      };
    },
  };
}

function fileContextAdapter(): PragmaResourceAdapter<PragmaContextStoreResource> {
  return {
    id: "pragma.context.file",
    version: "v1",
    kind: "ContextStore",
    configSchema: FileContextConfigSchema,
    artifactSources: (config) => [FileContextConfigSchema.parse(config).source],
    async verify({ config, host }) {
      const parsed = FileContextConfigSchema.parse(config);
      const artifact = await verifiedArtifact(host, parsed.source);
      if (artifact.path === undefined) throw new Error("File context must materialize to a path.");
      return {
        fingerprint: artifact.contentHash,
        contribution: { store: new FileSystemContextStore({ rootDir: artifact.path }) },
      };
    },
  };
}

function staticContextAdapter(
  id: "pragma.context.note" | "pragma.context.static",
): PragmaResourceAdapter<PragmaContextStoreResource> {
  return {
    id,
    version: "v1",
    kind: "ContextStore",
    configSchema: StaticContextConfigSchema,
    async verify({ config }) {
      const parsed = StaticContextConfigSchema.parse(config);
      return {
        fingerprint: sha256(stableStringify(parsed)),
        contribution: {
          store: new StaticContextStore(
            parsed.entries.map((entry) => ({
              id: entry.id,
              content: entry.content,
              metadata: entry.metadata,
            })),
          ),
        },
      };
    },
  };
}

function hostContextAdapter(): PragmaResourceAdapter<PragmaContextStoreResource> {
  return {
    id: "pragma.context.host",
    version: "v1",
    kind: "ContextStore",
    configSchema: HostContextConfigSchema,
    bindingSchema: HostContextBindingSchema,
    bindingRequired: true,
    async verify({ binding }) {
      return {
        fingerprint: sha256(binding!.revision),
        contribution: HostContextBindingSchema.parse(binding!.value),
      };
    },
  };
}

function runtimeProfileAdapter(): PragmaResourceAdapter<PragmaRuntimeProfileResource> {
  return {
    id: "pragma.runtime.profile",
    version: "v1",
    kind: "RuntimeProfile",
    configSchema: PragmaRuntimeProfileConfigSchema,
    async verify({ config }) {
      const parsed = PragmaRuntimeProfileConfigSchema.parse(config);
      const models =
        parsed.model === undefined || parsed.providerId === undefined
          ? undefined
          : {
              default: {
                model: { providerId: parsed.providerId, modelId: parsed.model },
                ...(parsed.thinkingLevel === undefined
                  ? {}
                  : { thinkingLevel: parsed.thinkingLevel }),
              },
            };
      return {
        fingerprint: sha256(stableStringify({ parsed })),
        contribution: {
          runtimeId: parsed.runtimeId,
          ...(models === undefined ? {} : { models }),
        },
      };
    },
  };
}

async function verifiedArtifact(
  host: PragmaAdapterHost,
  source: PragmaArtifactSource,
): Promise<PragmaArtifactRecord> {
  const artifact = await host.resolveArtifact(source);
  if (stableStringify(artifact.source) !== stableStringify(source)) {
    throw new Error("Artifact resolver returned a record for a different source.");
  }
  const expected = source.type === "project" ? undefined : source.integrity.slice("sha256:".length);
  if (expected !== undefined && artifact.contentHash !== expected) {
    throw new Error(
      `Artifact integrity mismatch for ${source.type === "project" ? source.path : source.uri}.`,
    );
  }
  if (artifact.text !== undefined && sha256(artifact.text) !== artifact.contentHash) {
    throw new Error("Artifact text does not match its contentHash.");
  }
  if (
    artifact.path !== undefined &&
    (await hashArtifactPath(artifact.path)) !== artifact.contentHash
  ) {
    throw new Error("Artifact path does not match its contentHash.");
  }
  return artifact;
}

async function hashArtifactPath(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (info.isFile()) return sha256(await readFile(canonical));
  if (!info.isDirectory()) throw new Error(`Artifact is not a regular file or directory: ${path}`);
  const entries = await readdir(canonical, { withFileTypes: true });
  const unsupported = entries.find((entry) => !entry.isFile() && !entry.isDirectory());
  if (unsupported !== undefined) {
    throw new Error(
      `Artifact contains a non-regular entry: ${resolve(canonical, unsupported.name)}`,
    );
  }
  const values = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      hash: await hashArtifactPath(resolve(canonical, entry.name)),
    })),
  );
  return sha256(stableStringify(values.sort((left, right) => left.name.localeCompare(right.name))));
}

function isContextStore(value: unknown): value is ExpertAgentContextStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return [
    "listContext",
    "readContext",
    "addContext",
    "editContext",
    "deleteContext",
    "searchContext",
  ].every((name) => typeof candidate[name] === "function");
}

function isCapabilityContribution(value: unknown): value is PragmaCapabilityContribution {
  const contribution = asRecord(value);
  if (contribution === undefined) return false;
  if (contribution["skills"] !== undefined) {
    const skills = asRecord(contribution["skills"])?.["skills"];
    if (!Array.isArray(skills) || !skills.every(isSkill)) return false;
  }
  if (contribution["tools"] !== undefined) {
    const tools = contribution["tools"];
    if (!Array.isArray(tools) || !tools.every(isManagedTool)) return false;
  }
  if (contribution["mcp"] !== undefined) {
    const servers = asRecord(asRecord(contribution["mcp"])?.["mcpServers"]);
    if (servers === undefined || !Object.values(servers).every(isMcpServer)) return false;
  }
  return true;
}

function isSkill(value: unknown): boolean {
  const skill = asRecord(value);
  return (
    skill !== undefined &&
    ["builtin", "registry", "local"].includes(String(skill["type"])) &&
    typeof skill["name"] === "string" &&
    typeof skill["description"] === "string" &&
    optionalString(skill["path"]) &&
    optionalString(skill["baseDir"]) &&
    (skill["version"] === undefined ||
      skill["version"] === null ||
      typeof skill["version"] === "string")
  );
}

function isManagedTool(value: unknown): boolean {
  const tool = asRecord(value);
  return (
    tool !== undefined &&
    typeof tool["name"] === "string" &&
    typeof tool["description"] === "string" &&
    typeof tool["call"] === "function"
  );
}

function isMcpServer(value: unknown): boolean {
  const server = asRecord(value);
  if (server === undefined || typeof server["name"] !== "string") return false;
  if (server["transport"] === "stdio") return typeof server["command"] === "string";
  if (server["transport"] === "streamable-http" || server["transport"] === "sse") {
    return typeof server["url"] === "string";
  }
  if (server["transport"] !== "in-process") return false;
  const inProcess = asRecord(server["inProcess"]);
  return (
    inProcess !== undefined &&
    typeof inProcess["listTools"] === "function" &&
    typeof inProcess["callTool"] === "function" &&
    (inProcess["dispose"] === undefined || typeof inProcess["dispose"] === "function")
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createContextSystem(
  stores: readonly {
    readonly namespace: string;
    readonly required: boolean;
    readonly contribution: PragmaContextStoreContribution;
  }[],
): ContextSystem {
  const contextSystem = new ContextSystem();
  for (const entry of stores) {
    const result = contextSystem.register({
      namespace: entry.namespace,
      required: entry.required,
      store: entry.contribution.store,
    });
    if (!result.ok) throw new Error(result.error.message);
  }
  return contextSystem;
}

async function requireSecret(host: PragmaAdapterHost, ref: string): Promise<string> {
  const secret = await host.resolveSecret(ref);
  if (secret === undefined) throw new Error(`Secret not found: ${ref}`);
  return secret;
}

function diagnostic(code: string, message: string): PragmaDiagnostic {
  return { severity: "error", code, message, path: [] };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
