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

const agent = await defineExpert({
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
      userConfig: {
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

Explicit `userConfig` values take precedence. Authentication secrets must be resolved by the host
before plugin setup; the plugin does not implicitly read configuration from environment variables.

## Plugin Package Usage

The production plugin shape is a Node package or directory containing:

```text
package.json
plugin.json
dist/index.js
```

Pass the plugin directory or zip path to `defineExpert()`. The factory loads
the plugin, copies or extracts it into the Agent workspace, and constructs the
Agent with resolved plugin entries. Directory and zip sources may also receive
direct config:

```ts
import { ExpertAgent } from "@pragma/core";

const workspace = "/path/to/workspace";

const agent = await defineExpert({
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
      userConfig: {
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

`plugin.json` declares an object JSON Schema so hosts can discover and validate config keys,
types, defaults, conditional requirements, secret fields, and descriptions without executing
plugin code. Agent startup applies manifest defaults and resolved `userConfig`. Secret values use
`"x-pragma-secret": true`; Desktop stores them through encrypted bindings instead of YAML.

Repository lists can be supplied directly through plugin `userConfig.repositories`.
For dynamic Agent data, they may still be registered in host Agent context as
`repositories.json`; explicit config takes precedence over host context. Agents
should use bash `git` directly and clone repositories to
`workspace/repos/<repository id>`.

Run the repository example from the monorepo root:

```bash
pnpm --filter @pragma/examples dev src/run-repo-manager-plugin.ts
```
