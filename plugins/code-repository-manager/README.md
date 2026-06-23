# Code Repository Manager Plugin

This ExpertMesh plugin exposes a configured list of Git repositories through the Agent context system and prepares Git authentication before each Agent runtime session starts.

The plugin never injects secrets into context. Token and SSH material are read from environment variables only when the session Git environment is prepared.

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
import { ExpertAgent, createInMemoryContextStore } from "@expertmesh/agent-core";

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
  context: createInMemoryContextStore({
    context: [
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
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_CREDENTIAL_HELPER
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_PRIVATE_KEY
EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_SSH_KNOWN_HOSTS
```

Set `EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_GIT_CREDENTIAL_HELPER` to a
`credential.helper` value when Git credentials should come from an existing helper
or a custom helper command. During each session, the plugin writes that value to an
isolated temporary Git config and removes it during cleanup.

Repository lists are dynamic Agent data. Register them in the host Agent context
as `repositories.json`; if that context item is missing, the plugin skips repository
context registration. Agents should use bash `git` directly and clone repositories to
`workspace/repos/<repository id>`.

Run the repository example from the monorepo root:

```bash
pnpm --filter @expertmesh/examples start:code-repositories
```
