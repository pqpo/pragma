import type { ExpertAgentContextStore } from "@pragma/core";
import {
  MemorySubjectRefSchema,
  type MemoryEvidenceEnvelope,
  type MemoryModuleDiagnostic,
} from "@pragma/shared";
import { z } from "zod";

import {
  createBuiltInMemorySchemaRegistry,
  type MemorySchemaRegistry,
} from "./memory-schema-registry.ts";

export interface MemoryModuleDescriptor {
  readonly id: string;
  readonly version: string;
  readonly pathPrefix: string;
  readonly storageModel: "dynamic-projection" | "immutable-revision";
  /** Projection modules build queryable memory; learning modules build candidates. */
  readonly purpose: "projection" | "learning";
  readonly contextLayers: MemoryModuleContextLayers;
}

export interface MemoryModuleContextLayers {
  /** Short instructions merged into the global always-on Memory guide. */
  readonly usagePrompt: string;
  readonly summaryPath: "summary.md";
  readonly indexPath: "index.md";
  readonly itemsPrefix: "items/";
  readonly evidencePrefix: "evidence/";
  readonly summaryMaxBytes: number;
  readonly indexMaxBytes: number;
}

export interface MemoryModuleSubscription {
  readonly topic: string;
  readonly schemaRefs: readonly string[];
}

export interface MemoryModuleConsumeResult {
  readonly derivedEvents?: readonly MemoryEvidenceEnvelope[] | undefined;
}

export const MemoryRecallScopeSchema = z.object({
  rootRef: MemorySubjectRefSchema.extend({
    type: z.enum(["pragma.expert", "pragma.expert-team", "pragma.flow"]),
  }),
  expertRef: MemorySubjectRefSchema.extend({ type: z.literal("pragma.expert") }).optional(),
  principalRefs: z.array(MemorySubjectRefSchema).optional(),
});

export type MemoryRecallScope = z.infer<typeof MemoryRecallScopeSchema>;

export interface MemoryModule {
  readonly descriptor: MemoryModuleDescriptor;
  readonly subscriptions: readonly MemoryModuleSubscription[];
  createContextProvider(scope: MemoryRecallScope): ExpertAgentContextStore;
  consume(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<MemoryModuleConsumeResult>;
  /** Durable module-owned work which must not hold the feed checkpoint open. */
  runBackgroundOnce?(): Promise<void>;
}

export class MemoryModuleRegistry {
  private readonly modulesById = new Map<string, MemoryModule>();
  private readonly modulesByPrefix = new Map<string, MemoryModule>();
  private readonly diagnostics = new Map<string, MemoryModuleDiagnostic>();

  constructor(readonly schemas: MemorySchemaRegistry = createBuiltInMemorySchemaRegistry()) {}

  register(module: MemoryModule): void {
    validateDescriptor(module.descriptor);
    validateSubscriptions(module, this.schemas);
    if (this.modulesById.has(module.descriptor.id)) {
      throw new Error(`Duplicate Memory Module id: ${module.descriptor.id}`);
    }
    if (this.modulesByPrefix.has(module.descriptor.pathPrefix)) {
      throw new Error(`Duplicate Memory Module path prefix: ${module.descriptor.pathPrefix}`);
    }
    this.modulesById.set(module.descriptor.id, module);
    this.modulesByPrefix.set(module.descriptor.pathPrefix, module);
  }

  list(): readonly MemoryModule[] {
    return [...this.modulesById.values()].toSorted((left, right) =>
      left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }

  resolvePrefix(prefix: string): MemoryModule | undefined {
    return this.modulesByPrefix.get(prefix);
  }

  setDiagnostic(diagnostic: MemoryModuleDiagnostic): void {
    if (!this.modulesById.has(diagnostic.moduleId)) return;
    this.diagnostics.set(diagnostic.moduleId, diagnostic);
  }

  diagnostic(moduleId: string): MemoryModuleDiagnostic | undefined {
    return this.diagnostics.get(moduleId);
  }
}

function validateSubscriptions(module: MemoryModule, schemas: MemorySchemaRegistry): void {
  const keys = new Set<string>();
  for (const subscription of module.subscriptions) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(subscription.topic)) {
      throw new TypeError(`Invalid Memory Module topic: ${subscription.topic}`);
    }
    if (subscription.schemaRefs.length === 0) {
      throw new TypeError(
        `Memory Module subscription requires schemaRefs: ${module.descriptor.id}`,
      );
    }
    for (const schemaRef of subscription.schemaRefs) {
      if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/v[1-9][0-9]*$/.test(schemaRef)) {
        throw new TypeError(`Invalid Memory Module schema reference: ${schemaRef}`);
      }
      if (!schemas.supports(subscription.topic, schemaRef)) {
        throw new TypeError(
          `Memory Module subscription has no registered payload schema: ${subscription.topic} ${schemaRef}`,
        );
      }
      const key = `${subscription.topic}\0${schemaRef}`;
      if (keys.has(key)) throw new TypeError(`Duplicate Memory Module subscription: ${key}`);
      keys.add(key);
    }
  }
}

function validateDescriptor(descriptor: MemoryModuleDescriptor): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(descriptor.id)) {
    throw new TypeError(`Invalid Memory Module id: ${descriptor.id}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(descriptor.pathPrefix)) {
    throw new TypeError(`Invalid Memory Module path prefix: ${descriptor.pathPrefix}`);
  }
  if (descriptor.version.trim() === "") throw new TypeError("Memory Module version is required.");
  const layers = descriptor.contextLayers;
  if (layers.usagePrompt.trim() === "") {
    throw new TypeError(`Memory Module usage prompt is required: ${descriptor.id}`);
  }
  if (layers.usagePrompt.length > 2_000) {
    throw new TypeError(`Memory Module usage prompt is too large: ${descriptor.id}`);
  }
  for (const [name, value] of [
    ["summaryMaxBytes", layers.summaryMaxBytes],
    ["indexMaxBytes", layers.indexMaxBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 64_000) {
      throw new TypeError(`Invalid Memory Module ${name}: ${descriptor.id}`);
    }
  }
}
