# Code Repository Manager Plugin

This ExpertMesh plugin exposes a configured list of Git repositories as Agent documents and prepares Git authentication before each Agent runtime session starts.

The plugin never injects secrets into documents. Token and SSH material are read from environment variables only when the session Git environment is prepared.

## Plugin Package Usage

The production plugin shape is a Node package or directory containing:

```text
package.json
plugin.json
dist/index.js
```

Pass the plugin directory or zip path to `ExpertAgent.create`. The factory loads
the plugin, copies or extracts it into the Agent workspace, and constructs the
Agent with resolved plugin entries.

```ts
import { ExpertAgent, createInMemoryDocumentStore } from "@expertmesh/agent-core";

const workspace = "/path/to/workspace";

const agent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "repo-aware-agent",
  displayName: "Repo Aware Agent",
  description: "Agent with repository access.",
  tags: ["code"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  documents: createInMemoryDocumentStore({
    documents: [
      {
        id: "repositories.json",
        content: JSON.stringify({
          repositories: [
            {
              id: "expert-mesh",
              name: "ExpertMesh",
              cloneUrl: "https://github.com/example/expert-mesh.git",
              defaultBranch: "main",
            },
          ],
        }),
        metadata: {
          trigger: "manual",
        },
      },
    ],
  }),
  plugins: ["/path/to/code-repository-manager"],
});
```

If `plugin.json` declares required `requires_env` entries and the host environment is
missing them, the loader records a `pluginLoadIssues` entry and skips the plugin.
Secret values should be marked with `"secret": true`.

This plugin reserves the following environment variable namespace:

```text
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_TOKEN
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_USERNAME
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_PRIVATE_KEY
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_KNOWN_HOSTS
```

Repository lists are dynamic Agent data. Put them in the host Agent document
`repositories.json`; if the document is missing, the plugin skips repository document
injection. Agents should use bash `git` directly and clone repositories to
`workspace/repos/<repository id>`.

Run the repository example from the monorepo root:

```bash
pnpm --filter @expertmesh/examples start:code-repositories
```
