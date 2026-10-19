import {
  SharedConfigurationChangeSchema,
  ModelProviderImpactSchema,
  type SharedConfigurationChange,
  type CreateModelProvider,
} from "../../deployment-contracts/index.ts";
import { invalidateTargetRuntimeAvailability } from "../runtimes/runtime-availability.ts";
import type { RuntimeEnvironmentService } from "../runtimes/runtime-environment-service.ts";
import { createHash } from "node:crypto";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import type { PragmaResource } from "@pragma/interpreter/ast";
import { ModelProviderStoreError, type ModelProviderStore } from "./model-provider-store.ts";
import type {
  ModelConnectionTestResult,
  ModelProviderModel,
  UpdateModelProvider,
} from "../../deployment-contracts/index.ts";
import type { ResolvedModelProvider } from "@pragma/core";
import type { ModelThinkingLevel } from "@pragma/shared";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { createModelDiscovery } from "./model-discovery.ts";

export function createModelConnectionService(options: {
  readonly store: ModelProviderStore;
  readonly runtimes?: RuntimeEnvironmentService | undefined;
  readonly project?: Pick<PragmaProjectStore, "get">;
  readonly externalResources?: () => readonly PragmaResource[];
  readonly discover: ReturnType<typeof createModelDiscovery>["discoverProviderModels"];
  readonly test: (input: {
    readonly provider: ResolvedModelProvider;
    readonly model: ModelProviderModel;
    readonly thinkingLevel?: ModelThinkingLevel;
  }) => Promise<ModelConnectionTestResult>;
  readonly beforeConnectionChange?: () => void;
}) {
  const inspectImpact = async (providerId: string) => {
    const snapshot = await options.project?.get();
    const provider = (await options.store.list()).find((value) => value.id === providerId);
    const resources = [...(snapshot?.resources ?? []), ...(options.externalResources?.() ?? [])];
    const refs = new Set(
      resources
        .filter(
          (resource) =>
            resource.kind === "RuntimeProfile" &&
            typeof resource.spec.config === "object" &&
            resource.spec.config !== null &&
            "providerId" in resource.spec.config &&
            resource.spec.config.providerId === providerId,
        )
        .map(canonicalPragmaResourceRef),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const resource of resources) {
        const ref = canonicalPragmaResourceRef(resource);
        if (
          !refs.has(ref) &&
          [...referencedPragmaResourceRefs([resource])].some((value) => refs.has(value))
        ) {
          refs.add(ref);
          changed = true;
        }
      }
    }
    const affectedResourceRefs = [...refs].sort();
    return ModelProviderImpactSchema.parse({
      scope: "shared" as const,
      complete: options.project !== undefined,
      providerId,
      providerRevision: provider?.revision ?? 0,
      projectRevision: snapshot?.revision ?? 0,
      affectedResourceRefs,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            providerId,
            provider?.revision,
            snapshot?.revision,
            affectedResourceRefs,
          ]),
        )
        .digest("hex"),
    });
  };
  const changed = () => {
    if (options.runtimes !== undefined) invalidateTargetRuntimeAvailability(options.runtimes);
  };
  return {
    inspectImpact,
    async create(input: CreateModelProvider) {
      const result = await options.store.create(input);
      changed();
      return result;
    },
    async update(input: UpdateModelProvider, change: SharedConfigurationChange) {
      change = SharedConfigurationChangeSchema.parse(change);
      const impact = await inspectImpact(input.id);
      if (change.expectedImpact !== undefined && change.expectedImpact !== impact.fingerprint)
        throw Object.assign(
          new Error(
            "The shared connection or its consumers changed. Refresh its impact before saving.",
          ),
          { code: "connection_impact_conflict" },
        );
      options.beforeConnectionChange?.();
      const result = await options.store.update({
        ...input,
        expectedRevision: input.expectedRevision ?? impact.providerRevision,
      });
      changed();
      return result;
    },
    async remove(id: string) {
      const impact = await inspectImpact(id);
      if (impact.affectedResourceRefs.length > 0)
        throw new Error("This provider is used by a Runtime Profile and cannot be deleted.");
      options.beforeConnectionChange?.();
      await options.store.remove(id);
      changed();
    },
    async reset() {
      options.beforeConnectionChange?.();
      const result = await options.store.reset();
      changed();
      return result;
    },
    async discover(
      request: Parameters<ReturnType<typeof createModelDiscovery>["discoverProviderModels"]>[0] & {
        providerId?: string | undefined;
        apiKey?: string | undefined;
      },
    ) {
      let apiKey = request.apiKey ?? "";
      if (apiKey === "" && request.providerId !== undefined) {
        try {
          apiKey = await options.store.resolveDiscoveryApiKey(request.providerId, request);
        } catch (error) {
          if (error instanceof ModelProviderStoreError && error.code === "provider_not_found")
            return {
              ok: false,
              models: [],
              message:
                "This provider was removed while it was being configured. Return to the provider list and add or select it again.",
              source: "manual" as const,
            };
          throw error;
        }
      }
      return await options.discover({ ...request, apiKey });
    },
    async test(request: {
      providerId: string;
      modelId?: string | undefined;
      thinkingLevel?: ModelThinkingLevel | undefined;
    }): Promise<ModelConnectionTestResult> {
      try {
        const resolved = await options.store.resolveProviderWithRevision(request.providerId);
        const provider = resolved.provider;
        const model =
          request.modelId === undefined
            ? provider.models[0]
            : provider.models.find((value) => value.id === request.modelId);
        if (model === undefined)
          return {
            ok: false,
            code: "model_unavailable",
            message: "The model is not configured for this provider.",
          };
        const result = await options.test({
          provider,
          model: { ...model, capabilitiesSource: "provider" },
          ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
        });
        await options.store.recordVerification(request.providerId, resolved.revision, result);
        return result;
      } catch (error) {
        return {
          ok: false,
          code: "not_configured",
          message: error instanceof Error ? error.message : "The provider could not be loaded.",
        };
      }
    },
  };
}
