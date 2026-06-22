import { ExpertAgent } from "@expertmesh/agent-core";
import { createCodeRepositoryManagerPlugin } from "@expertmesh/plugin-code-repository-manager";

import { defaultWorkspaceRoot, ensureWorkspaceDir } from "../harness/paths.ts";

const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const codeRepositoryManagerPlugin = createCodeRepositoryManagerPlugin(
  {
    documentInjection: {
      mode: "model_decision",
    },
    auth: {
      strategy: "none",
    },
    repositories: [
      {
        id: "expert-mesh",
        name: "ExpertMesh",
        cloneUrl: "https://github.com/example/expert-mesh.git",
        defaultBranch: "main",
        provider: "github",
        description:
          "Example repository entry showing how repository metadata is exposed to ExpertAgent documents.",
        workspacePath: ".workspace/repos/expert-mesh",
        allowedBranches: ["main"],
        shallowClone: true,
      },
    ],
  },
  {
    workspaceRoot: workspace,
    prepareOnSessionCreate: false,
  },
);

const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "code-repository-plugin-example-agent",
  displayName: "Code Repository Plugin Example Agent",
  description: "Demonstrates how to attach the code repository manager plugin to ExpertAgent.",
  tags: ["example", "plugin", "repository"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  plugins: [codeRepositoryManagerPlugin],
});

const documents = await agent.listDocuments();

console.log("Plugin documents:");
if (documents.ok) {
  for (const document of documents.value) {
    console.log(`- ${document.id} (${document.metadata.trigger})`);
  }
} else {
  console.log(`- error: ${documents.error.message}`);
}

const repositoryDocument = await agent.readDocument({
  id: "code-repository-manager/code-repositories.md",
});

console.log("");
console.log("Repository document preview:");
if (repositoryDocument.ok) {
  console.log(repositoryDocument.value.content);
} else {
  console.log(`error: ${repositoryDocument.error.message}`);
}

console.log("");
console.log("Plugin tools:");
for (const tool of agent.tools ?? []) {
  console.log(`- ${tool.name}: ${tool.description}`);
}
