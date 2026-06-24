import { ExpertAgent, createInMemoryContextStore } from "@expertmesh/agent-core";

import { defaultWorkspaceRoot, ensureWorkspaceDir, resolveExamplePath } from "../harness/paths.ts";

const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const agent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "code-repository-plugin-example-agent",
  displayName: "Code Repository Plugin Example Agent",
  description: "Demonstrates how to attach the code repository manager plugin to ExpertAgent.",
  tags: ["example", "plugin", "repository"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  context: createInMemoryContextStore({
    context: [
      {
        id: "repositories.json",
        content: JSON.stringify(
          {
            repositories: [
              {
                id: "expert-mesh",
                name: "ExpertMesh",
                cloneUrl: "https://github.com/example/expert-mesh.git",
                defaultBranch: "main",
                provider: "github",
                description:
                  "Example repository entry showing how repository metadata is exposed to ExpertAgent context.",
                allowedBranches: ["main"],
                shallowClone: true,
              },
            ],
          },
          null,
          2,
        ),
        metadata: {
          description: "Repositories available to the code repository manager plugin.",
          trigger: "manual",
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      },
    ],
  }),
  plugins: [resolveExamplePath("plugins/code-repository-manager")],
});

const contextItems = await agent.listContext();

console.log("Plugin context:");
if (contextItems.ok) {
  for (const item of contextItems.value) {
    console.log(
      `- namespace=${item.namespace ?? "<none>"} id=${item.id} trigger=${item.metadata.trigger}`,
    );
  }
} else {
  console.log(`- error: ${contextItems.error.message}`);
}

const repositoryContext = await agent.readContext({
  namespace: "code-repository-manager",
  id: "code-repositories.md",
});

console.log("");
console.log("Repository context preview:");
if (repositoryContext.ok) {
  console.log(repositoryContext.value.content);
} else {
  console.log(`error: ${repositoryContext.error.message}`);
}

console.log("");
console.log("Plugin Git environment hook:");
console.log(
  agent.hooks?.beforeSessionCreate === undefined ? "- not configured" : "- beforeSessionCreate",
);
