# Repo Manager Plugin

This Pragma plugin exposes a configured list of Git repositories through the Agent context system and prepares Git authentication before each Agent runtime session starts.

The plugin never injects secrets into context. Token and SSH material are read from environment variables only when the session Git environment is prepared.

## Plugin Usage

For plugins available as source dependencies, import the plugin entry and pass it
through the Agent `plugins` array. This is the preferred shape for built-in
plugins because parameters can be supplied directly instead of routed through
environment variables or host context.

```ts
import { ExpertAgent } from "@pragma/core";
import repoManagerPlugin from "@pragma/plugin-repo-manager";

const gitToken = "value loaded from your app secret store";

const agent = await ExpertAgent.create({
  schemaVersion: "pragma.expert/v1",
  id: "repo-aware-agent",
  name: "Repo Aware Agent",
  description: "Agent with repository access.",
  tags: ["code"],
  version: "0.0.0",
  scope: "local-test",
  workspace: "/path/to/workspace",
  plugins: [
    {
      entry: repoManagerPlugin,
      config: {
        repositories: [
          {
            id: "pragma",
            name: "Pragma",
            cloneUrl: "https://github.com/example/pragma.git",
            defaultBranch: "main",
          },
        ],
        auth: {
          strategy: "token",
          token: gitToken,
          username: "x-access-token",
        },
      },
    },
  ],
});
```

Explicit `config` values take precedence. If auth config is omitted, the plugin
falls back to the reserved environment variables listed below.

## Plugin Package Usage

The production plugin shape is a Node package or directory containing:

```text
package.json
plugin.json
dist/index.js
```

Pass the plugin directory or zip path to `ExpertAgent.create`. The factory loads
the plugin, copies or extracts it into the Agent workspace, and constructs the
Agent with resolved plugin entries. Directory and zip sources may also receive
direct config:

```ts
import { ExpertAgent } from "@pragma/core";

const workspace = "/path/to/workspace";

const agent = await ExpertAgent.create({
  schemaVersion: "pragma.expert/v1",
  id: "repo-aware-agent",
  name: "Repo Aware Agent",
  description: "Agent with repository access.",
  tags: ["code"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  plugins: [
    {
      source: "/path/to/repo-manager",
      config: {
        repositories: [
          {
            id: "pragma",
            name: "Pragma",
            cloneUrl: "https://github.com/example/pragma.git",
            defaultBranch: "main",
          },
        ],
      },
    },
  ],
});
```

`plugin.json` declares `configuration.properties` so hosts can discover supported
config keys, types, defaults, secret fields, and descriptions without executing
plugin code. `required_config` is reserved for startup gates: Agent startup builds
those required values from the reserved environment variable namespace first, then
overlays explicit plugin `config`. Missing required config causes startup to fail
with the generated environment variable name in the error message. Secret values
should be marked with `"secret": true`.

This plugin reserves the following environment variable namespace:

```text
PRAGMA_PLUGIN_REPO_MANAGER_AUTH_TOKEN
PRAGMA_PLUGIN_REPO_MANAGER_AUTH_USERNAME
PRAGMA_PLUGIN_REPO_MANAGER_AUTH_HELPER
PRAGMA_PLUGIN_REPO_MANAGER_AUTH_PRIVATE_KEY
PRAGMA_PLUGIN_REPO_MANAGER_AUTH_KNOWN_HOSTS
```

Use `createExpertAgentPluginConfigEnvName` from `@pragma/core` to derive
these names from `pluginId` and config key. Set
`PRAGMA_PLUGIN_REPO_MANAGER_AUTH_HELPER` to a
`credential.helper` value when Git credentials should come from an existing helper
or a custom helper command. During each session, the plugin writes that value to an
isolated temporary Git config and removes it during cleanup.

Repository lists can be supplied directly through plugin `config.repositories`.
For dynamic Agent data, they may still be registered in host Agent context as
`repositories.json`; explicit config takes precedence over host context. Agents
should use bash `git` directly and clone repositories to
`workspace/repos/<repository id>`.

Run the repository example from the monorepo root:

```bash
pnpm --filter @pragma/examples dev src/run-repo-manager-plugin.ts
```
