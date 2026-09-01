import { createHash } from "node:crypto";

import {
  PRAGMA_MANAGEMENT_BINDING_REF,
  createPragmaManagementTools,
  type PragmaManagementToolPorts,
} from "@pragma/built-in-agents";
import type { McpToolRegistryPool } from "@pragma/core";
import type { PragmaAdapterHost, PragmaBindingRecord } from "@pragma/interpreter";

import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import { resolveExpertCapabilities } from "../experts/desktop-expert-factory.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";

export function createDesktopAdapterHost(
  options: {
    readonly capabilityStore: CapabilityStore;
    readonly capabilityCredentials: CapabilityCredentialStore;
    readonly capabilitiesPath: string;
    readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
    readonly contextStores?: ContextStoreStore | undefined;
    readonly pragmaManagement?: PragmaManagementToolPorts | undefined;
  },
  projectRoot: string,
): PragmaAdapterHost {
  return {
    environmentId: "desktop",
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      if (ref === PRAGMA_MANAGEMENT_BINDING_REF) {
        if (options.pragmaManagement === undefined) return undefined;
        const tools = createPragmaManagementTools(options.pragmaManagement);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
            ),
          )
          .digest("hex");
        return {
          ref,
          revision: "1",
          fingerprint,
          value: { contribution: { tools } },
        };
      }
      const capabilityRef = parseDesktopCapabilityBindingRef(ref);
      if (capabilityRef !== undefined) {
        const capabilityId = capabilityRef.id;
        const revision = capabilityRef.revision;
        const capability = await options.capabilityStore.get(capabilityId, revision);
        const toolNames =
          capability.definition.kind === "skill"
            ? []
            : capability.definition.kind === "code_service"
              ? [capability.definition.tool.name]
              : capability.definition.tools.map((tool) => tool.name);
        const contribution = await resolveExpertCapabilities({
          expert: {
            capabilities: [
              capability.definition.kind === "skill"
                ? { kind: "skill", capabilityId, revision }
                : { kind: "tools", capabilityId, revision, toolNames },
            ],
            toolApprovals: {},
          },
          store: options.capabilityStore,
          credentials: options.capabilityCredentials,
          capabilitiesPath: options.capabilitiesPath,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              id: capabilityId,
              revision,
              definition: capability.definition,
              credentials: await options.capabilityCredentials.fingerprint(capabilityId),
            }),
          )
          .digest("hex");
        return { ref, revision: String(revision), fingerprint, value: { contribution } };
      }

      const contextId = parseDesktopContextBindingRef(ref);
      if (contextId !== undefined) {
        if (options.contextStores === undefined) {
          throw new Error(`Desktop context binding is unavailable: ${contextId}`);
        }
        const context = await options.contextStores.resolve(contextId);
        return {
          ref,
          revision: context.revision,
          fingerprint: context.revision,
          value: { store: context.store, storeName: context.name },
        };
      }
      return undefined;
    },
    async resolveArtifact(source) {
      throw new Error(
        source.type === "project"
          ? `Project artifact was not resolved by the interpreter: ${source.path}`
          : `Desktop has no external artifact resolver for: ${source.uri}`,
      );
    },
    async resolveSecret() {
      return undefined;
    },
  };
}
