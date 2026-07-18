# Repo Manager Plugin

This Pragma plugin initializes an isolated Git environment before each Agent runtime session and removes its temporary configuration after the session ends.

Its responsibility is limited to Git CLI availability, authentication, and session-level configuration. Repository reference information belongs to an independent knowledge or context provider; this plugin does not declare repository metadata, register a context store, or read hidden host context files.

The plugin never injects secrets into Agent context. Authentication values must be resolved by the host before plugin setup.

## Plugin Usage

For plugins available as source dependencies, import the plugin entry and pass it through the Agent `plugins` array:

```ts
import { defineExpert } from "@pragma/core";
import repoManagerPlugin from "@pragma/plugin-repo-manager";

const gitToken = "value loaded from your app secret store";

const agent = await defineExpert({
  schemaVersion: "pragma.expert/v1",
  id: "git-enabled-agent",
  name: "Git Enabled Agent",
  description: "Agent with isolated Git authentication.",
  tags: ["code"],
  version: "0.0.0",
  scope: "local-test",
  workspace: "/path/to/workspace",
  plugins: [
    {
      entry: repoManagerPlugin,
      userConfig: {
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

Supported authentication strategies are `none`, `token`, `ssh`, and `credential_helper`. The default is `none`; even unauthenticated sessions receive isolated Git configuration and have interactive credential prompts disabled.

Each Runtime Session receives its own immutable process-environment snapshot and unique temporary Git home. Codex, Claude Code, and PI Bash commands consume that exact snapshot; the plugin never modifies the Desktop process environment. Concurrent Experts can therefore use different tokens or SSH keys even when they share the same Git executable and workspace. Concurrent writes to the same checkout remain the workflow's responsibility because Git working-tree locks are not managed by this plugin.

Session authentication takes precedence over authentication settings in the current checkout. Repo Manager resets checkout-local credential helpers and HTTP authorization headers while leaving unrelated Git settings intact. `credential_helper` is an explicit local-integration exception: only the helper named in the plugin config is re-enabled, and that helper may access the user's credential store. The plugin never reads or modifies the user's global or system Git configuration.

For SSH, a configured `knownHosts` value is pinned with strict host-key checking. If it is omitted, the session uses `accept-new` and records discovered keys only in its temporary `known_hosts` file; the user's SSH files are not changed.

Repository references and clone URLs must come from the prompt or a separate knowledge/context provider. Keep credentials out of clone URLs so Repo Manager can enforce the selected session authentication strategy.

## Plugin Package Usage

The production plugin shape is a Node package or directory containing:

```text
package.json
plugin.json
dist/index.js
```

Directory and zip plugin sources may receive the same direct authentication config:

```ts
import { defineExpert } from "@pragma/core";

const agent = await defineExpert({
  schemaVersion: "pragma.expert/v1",
  id: "git-enabled-agent",
  name: "Git Enabled Agent",
  description: "Agent with isolated Git authentication.",
  tags: ["code"],
  version: "0.0.0",
  scope: "local-test",
  workspace: "/path/to/workspace",
  plugins: [
    {
      source: "/path/to/repo-manager",
      userConfig: {
        auth: {
          strategy: "ssh",
          privateKey: "value loaded from your app secret store",
          knownHosts: "github.com ssh-ed25519 AAAA...",
        },
      },
    },
  ],
});
```

`plugin.json` declares the authentication JSON Schema so hosts can discover and validate config keys, defaults, conditional requirements, and secret fields without executing plugin code. Secret values use `"x-pragma-secret": true`; Desktop stores them through encrypted bindings instead of YAML.
