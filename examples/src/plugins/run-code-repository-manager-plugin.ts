import {
  ExpertAgent,
  createInMemoryDocumentStore,
} from "@expertmesh/agent-core";

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
  documents: createInMemoryDocumentStore({
    documents: [
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
                  "Example repository entry showing how repository metadata is exposed to ExpertAgent documents.",
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
console.log("Plugin Git environment hook:");
console.log(
  agent.hooks?.beforeSessionCreate === undefined ? "- not configured" : "- beforeSessionCreate",
);
