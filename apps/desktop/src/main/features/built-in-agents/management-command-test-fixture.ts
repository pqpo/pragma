import { join } from "node:path";
import { createLocalHostPragmaProjectPort } from "@pragma/local-host";
import {
  PragmaAgentExpertOptionCatalogSchema,
  builtInAgentResources,
  BUILT_IN_PRAGMA_REF,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import { createDesktopRuntimeOptionResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";

/** Real Project repository and shared authoring use cases for boundary tests and native Runtime evidence. */
export function createManagementCommandTestFixture(root: string, withAuthoringCatalog = false) {
  const runtime = createDesktopRuntimeOptionResource({
    runtimeId: "test",
    providerId: "test",
    modelId: "model",
    name: "Probe Runtime",
    description: "Temporary authoring catalog",
  });
  const runtimeRef = canonicalPragmaResourceRef(runtime);
  const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
  const port = createLocalHostPragmaProjectPort({
    project,
    stateRoot: join(root, "state", "pragma"),
    catalog: async () => ({
      options: PragmaAgentExpertOptionCatalogSchema.parse({
        runtimeModels: withAuthoringCatalog
          ? [
              {
                key: "test",
                runtimeProfileRef: runtimeRef,
                runtimeName: "Probe",
                providerName: "Probe",
                modelName: "Probe model",
                isDefault: true,
              },
            ]
          : [],
        capabilities: [],
        avatars: [],
        builtinExperts: [],
      }),
      resources: withAuthoringCatalog ? new Map([[runtimeRef, runtime]]) : new Map(),
      availableModels: withAuthoringCatalog
        ? new Set([JSON.stringify(["test", "test", "model"])])
        : new Set(),
      isCapabilityAvailable: () => true,
    }),
    readSystemResource: (ref) =>
      builtInAgentResources(BUILT_IN_PRAGMA_REF).find(
        (resource) => canonicalPragmaResourceRef(resource) === ref,
      ),
  });
  return { project, port };
}

export const PROBE_AUTHORING_RUNTIME_REF = canonicalPragmaResourceRef(
  createDesktopRuntimeOptionResource({
    runtimeId: "test",
    providerId: "test",
    modelId: "model",
    name: "Probe Runtime",
    description: "Temporary authoring catalog",
  }),
);
