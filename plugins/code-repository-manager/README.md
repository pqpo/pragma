# Code Repository Manager Plugin

This ExpertMesh plugin exposes a configured list of Git repositories as Agent documents and provides managed tools for preparing Git and cloning repositories into the Agent workspace.

The plugin never injects secrets into documents. Token and SSH material are read from environment variables only when Git commands run.

Repository preparation is lazy by default. Set `prepareOnSessionCreate: true` only when session creation should fail fast if Git or credentials are unavailable.

## Minimal Usage

```ts
import { ExpertAgent } from "@expertmesh/agent-core";
import { createCodeRepositoryManagerPlugin } from "@expertmesh/plugin-code-repository-manager";

const workspace = "/path/to/workspace";

const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "repo-aware-agent",
  displayName: "Repo Aware Agent",
  description: "Agent with repository access.",
  tags: ["code"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  plugins: [
    createCodeRepositoryManagerPlugin(
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
          },
        ],
      },
      {
        workspaceRoot: workspace,
      },
    ),
  ],
});
```

Run the repository example from the monorepo root:

```bash
pnpm --filter @expertmesh/examples start:code-repositories
```
