import { createHash } from "node:crypto";
import { join } from "node:path";

import { PragmaPaths, type McpToolRegistryPool } from "@pragma/core";
import { FileSystemContextStore } from "@pragma/context-filesystem";
import { PRAGMA_MANAGEMENT_BINDING_REF } from "@pragma/built-in-agents";
import type { PragmaAdapterHost, PragmaBindingRecord } from "@pragma/interpreter";

import { createNativeOsKeychain } from "../secrets/native-os-keychain.ts";
import {
  createSecretStore,
  type LegacyCredentialDecryptor,
  type SecretStore,
} from "../secrets/secret-store.ts";
import { createCapabilityCredentialStore } from "./capability-credential-store.ts";
import { createLocalHostCapabilityReader } from "./capability-reader.ts";
import { resolveExpertCapabilities } from "./capability-contribution.ts";
import { createLocalHostContextStoreReader } from "./context-store-reader.ts";
import { createPluginCredentialStore } from "./plugin-credential-store.ts";
import { createLocalHostPluginResolver } from "./plugin-resolver.ts";
import {
  parseLegacyLocalHostCapabilityBindingRef,
  parseLocalHostCapabilityBindingRef,
  parseLocalHostContextBindingRef,
} from "./binding-reader.ts";

export class LocalHostResourceUnavailableError extends Error {
  readonly code = "DEPENDENCY_UNAVAILABLE";
  readonly details: { readonly diagnosticCode: string; readonly resourceRef?: string };
  constructor(
    readonly diagnosticCode: string,
    message: string,
    readonly resourceRef?: string | undefined,
  ) {
    super(`${diagnosticCode}: ${message}`);
    this.name = "LocalHostResourceUnavailableError";
    this.details = { diagnosticCode, ...(resourceRef === undefined ? {} : { resourceRef }) };
  }
}

/** Pure Node readers use the same authority parsers and recovery code as Desktop. */
export function createLocalHostResourceResolvers(options: {
  readonly pragmaHome: string;
  readonly secretStore?: SecretStore | undefined;
  readonly legacyDecryptor?: LegacyCredentialDecryptor | undefined;
  readonly builtInPluginsPath?: string | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  readonly environmentId?: string | undefined;
}) {
  const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
  const capabilitiesPath = join(paths.dataRoot(), "capabilities");
  const secretStore =
    options.secretStore ??
    createSecretStore({
      root: paths.secretStoreRoot(),
      dataRoot: paths.dataRoot(),
      keychain: createNativeOsKeychain(),
    });
  const capabilityCredentials = createCapabilityCredentialStore({
    configPath: join(paths.credentialsRoot(), "capability-credentials.json"),
    secretStore,
    legacyDecryptor: options.legacyDecryptor,
  });
  const capabilities = createLocalHostCapabilityReader({
    capabilitiesPath,
    credentials: capabilityCredentials,
  });
  const contextStores = createLocalHostContextStoreReader({
    storesPath: paths.contextStoresRoot(),
  });
  const pluginCredentials = createPluginCredentialStore({
    configPath: join(paths.credentialsRoot(), "plugin-credentials.json"),
    secretStore,
    legacyDecryptor: options.legacyDecryptor,
  });
  const pluginStore = createLocalHostPluginResolver({
    // No surface configuration means no built-in plugin install source. This path is never created.
    builtInPluginsPath:
      options.builtInPluginsPath ?? join(paths.pluginsRoot(), ".unconfigured-built-ins"),
    userPluginsPath: paths.pluginsRoot(),
    paths,
    credentials: pluginCredentials,
  });
  const plugins = {
    inspect: async ({ binding }: { readonly binding: Parameters<typeof pluginStore.inspect>[0] }) =>
      await pluginStore.inspect(binding),
    resolve: async ({ binding }: { readonly binding: Parameters<typeof pluginStore.resolve>[0] }) =>
      await pluginStore.resolve(binding),
  };
  const getCapabilityId = (binding: string): string | undefined =>
    parseLocalHostCapabilityBindingRef(binding) ??
    parseLegacyLocalHostCapabilityBindingRef(binding)?.id;
  const capabilityAuthority = {
    getCapabilityId,
    async resolve(id: string) {
      const capability = await capabilities.resolveActive(id);
      const credentials = await capabilityCredentials.fingerprint(id);
      return {
        capabilityId: capability.manifest.id,
        resolvedRevision: capability.manifest.latestRevision,
        fingerprint: hash({ definition: capability.definition, credentials }),
      };
    },
  };
  const adapterHost = (
    request: { readonly id: string; readonly workspace: { readonly path: string } },
    purpose: "execute" | "stop" = "execute",
  ): PragmaAdapterHost => ({
    environmentId: options.environmentId ?? "cli",
    projectRoot: request.workspace.path,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      const capabilityId = getCapabilityId(ref);
      const contextId = parseLocalHostContextBindingRef(ref);
      if (
        purpose === "stop" &&
        (capabilityId !== undefined || ref === PRAGMA_MANAGEMENT_BINDING_REF)
      ) {
        return {
          ref,
          revision: "stop",
          fingerprint: hashText(`stop:${ref}`),
          value: { contribution: { tools: [], skills: { skills: [] } } },
        };
      }
      if (ref === PRAGMA_MANAGEMENT_BINDING_REF) {
        throw new LocalHostResourceUnavailableError(
          "management_ports_unavailable",
          "This Host has not supplied Pragma management resource ports.",
          ref,
        );
      }
      if (capabilityId !== undefined) {
        const capability = await capabilities.resolveActive(capabilityId);
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
                ? { kind: "skill", capabilityId }
                : { kind: "tools", capabilityId, toolNames },
            ],
            toolApprovals: {},
          },
          store: capabilities,
          credentials: capabilityCredentials,
          capabilitiesPath,
          mcpToolRegistryPool: options.mcpToolRegistryPool,
        });
        return {
          ref,
          revision: String(capability.manifest.latestRevision),
          fingerprint: hash({
            id: capabilityId,
            revision: capability.manifest.latestRevision,
            definition: capability.definition,
            credentials: await capabilityCredentials.fingerprint(capabilityId),
          }),
          value: { contribution },
        };
      }
      if (contextId !== undefined) {
        if (purpose === "stop")
          return {
            ref,
            revision: "stop",
            fingerprint: hashText(`stop:${ref}`),
            value: { store: new FileSystemContextStore({ rootDir: request.workspace.path }) },
          };
        const context = await contextStores.resolve(contextId);
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
      throw new LocalHostResourceUnavailableError(
        "external_artifact_resolver_unavailable",
        source.type === "project"
          ? `Project artifact must be resolved by Interpreter: ${source.path}`
          : `No external artifact resolver is configured for ${source.uri}.`,
      );
    },
    async resolveSecret(ref) {
      const value = await pluginCredentials.get(ref);
      if (value === undefined)
        throw new LocalHostResourceUnavailableError(
          "secret_binding_unavailable",
          "The declared secret binding has no stored value.",
          ref,
        );
      return value;
    },
    openFileContextStore({ rootDir }) {
      return new FileSystemContextStore({ rootDir });
    },
  });
  return {
    adapterHost,
    secretFingerprint: async (ref: string) => await pluginCredentials.fingerprint([ref]),
    capabilityAuthority,
    capabilities,
    capabilityCredentials,
    contextStores,
    plugins,
    pluginStore,
    pluginCredentials,
    secretStore,
  };
}

function hash(value: unknown): string {
  return hashText(JSON.stringify(value));
}
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
