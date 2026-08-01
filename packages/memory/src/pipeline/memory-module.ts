import type { ExpertAgentContextStore } from "@pragma/core";
import type { MemoryEvidenceEnvelope, MemoryModuleDiagnostic } from "@pragma/shared";

import {
  createBuiltInMemorySchemaRegistry,
  type MemorySchemaRegistry,
} from "./memory-schema-registry.ts";

export interface MemoryModuleDescriptor {
  readonly id: string;
  readonly version: string;
  readonly pathPrefix: string;
  readonly storageModel: "dynamic-projection" | "immutable-revision";
}

export interface MemoryModuleSubscription {
  readonly topic: string;
  readonly schemaRefs: readonly string[];
}

export interface MemoryModuleConsumeResult {
  readonly derivedEvents?: readonly MemoryEvidenceEnvelope[] | undefined;
}

export interface MemoryModule {
  readonly descriptor: MemoryModuleDescriptor;
  readonly subscriptions: readonly MemoryModuleSubscription[];
  readonly contextProvider: ExpertAgentContextStore;
  consume(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<MemoryModuleConsumeResult>;
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
}
