import { join } from "node:path";
import { createLocalHostPragmaProjectPort } from "@pragma/local-host";
import {
  PragmaAgentExpertOptionCatalogSchema,
  builtInAgentResources,
  BUILT_IN_PRAGMA_REF,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";

/** Real Project repository and shared authoring use cases for boundary tests and native Runtime evidence. */
export function createManagementCommandTestFixture(root: string) {
  const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
  const port = createLocalHostPragmaProjectPort({
    project,
    stateRoot: join(root, "state", "pragma"),
    catalog: async () => ({
      options: PragmaAgentExpertOptionCatalogSchema.parse({
        runtimeModels: [],
        capabilities: [],
        avatars: [],
        builtinExperts: [],
      }),
      resources: new Map(),
      availableModels: new Set(),
      isCapabilityAvailable: () => true,
    }),
    readSystemResource: (ref) =>
      builtInAgentResources(BUILT_IN_PRAGMA_REF).find(
        (resource) => canonicalPragmaResourceRef(resource) === ref,
      ),
  });
  return { project, port };
}
