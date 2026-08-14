import type { McpToolRegistryPool } from "../mcp-tools.ts";
import { registerExpertToolsMcpSession, type ExpertToolRuntimeState } from "../expert-tools-mcp-server.ts";
import {
  runtimeFeature,
  type RuntimeFeatureReadiness,
  type RuntimeSessionFeature,
} from "./features.ts";

export interface RuntimeMcpPreparation {
  readonly registry: Awaited<ReturnType<McpToolRegistryPool["acquire"]>>["registry"];
  readonly lease: Awaited<ReturnType<McpToolRegistryPool["acquire"]>>;
  readonly registration: Awaited<ReturnType<typeof registerExpertToolsMcpSession>>;
  readonly toolRuntimeState: ExpertToolRuntimeState;
}

/**
 * The shared HTTP MCP projection used by Harness runtimes. Provider-specific
 * argv/config projection remains in the concrete Runtime package.
 */
export function createExpertToolsHttpMcpFeature(options: {
  readonly readiness: Extract<RuntimeFeatureReadiness, { readonly status: "supported" | "degraded" }>;
  readonly pool: McpToolRegistryPool;
  readonly resourcePrefix: string;
}): RuntimeSessionFeature<RuntimeMcpPreparation> {
  return runtimeFeature.session({
    id: `${options.resourcePrefix}.mcp`,
    readiness: options.readiness,
    async prepare(context) {
      const lease = await context.resources.acquire(
        `${options.resourcePrefix}.mcp-registry`,
        async () => await options.pool.acquire(context.agent.mcp),
        async (value) => await value.release(),
      );
      const toolRuntimeState: ExpertToolRuntimeState = {};
      const registration = await context.resources.acquire(
        `${options.resourcePrefix}.mcp-registration`,
        async () =>
          await registerExpertToolsMcpSession({
            agent: context.agent,
            getContext: () => context.lifecycle.currentContext,
            humanInteractionHandler: context.request.humanInteractionHandler,
            logger: context.logger,
            mcpTools: lease.registry.tools,
            state: toolRuntimeState,
            executionContext: context.request.executionContext,
          }),
        async (value) => await value.dispose(),
      );
      return { registry: lease.registry, lease, registration, toolRuntimeState };
    },
  });
}

export function createMcpRegistryFeature(options: {
  readonly readiness: Extract<RuntimeFeatureReadiness, { readonly status: "supported" | "degraded" }>;
  readonly pool: McpToolRegistryPool;
  readonly resourcePrefix: string;
}): RuntimeSessionFeature<{
  readonly registry: Awaited<ReturnType<McpToolRegistryPool["acquire"]>>["registry"];
  readonly lease: Awaited<ReturnType<McpToolRegistryPool["acquire"]>>;
}> {
  return runtimeFeature.session({
    id: `${options.resourcePrefix}.mcp-registry`,
    readiness: options.readiness,
    async prepare(context) {
      const lease = await context.resources.acquire(
        `${options.resourcePrefix}.mcp-registry`,
        async () => await options.pool.acquire(context.agent.mcp),
        async (value) => await value.release(),
      );
      return { registry: lease.registry, lease };
    },
  });
}
