# Expert Memory Plugin

This ExpertMesh plugin registers long-term Agent memory as context and records
eligible run outputs as pending memory candidates.

For built-in usage, import the plugin entry as a source dependency and pass
parameters through the Agent `plugins` array:

```ts
import { ExpertAgent } from "@pragma/core";
import expertMemoryPlugin from "@pragma/plugin-expert-memory";

const agent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "memory-agent",
  name: "Memory Agent",
  description: "Agent with long-term memory.",
  tags: ["memory"],
  version: "0.0.0",
  scope: "workspace",
  workspace: "/path/to/workspace",
  plugins: [
    {
      entry: expertMemoryPlugin,
      config: {
        enabled: true,
        memoryRoot: ".expertmesh/agent/memories",
        generateMemories: true,
      },
    },
  ],
});
```

Config precedence is:

1. Explicit plugin `config`.
2. Host context `memory-config.json`.
3. Environment variables.
4. Schema defaults.

`plugin.json` declares `configuration.properties` so hosts can discover supported
config keys, types, defaults, and descriptions without executing plugin code.
`required_config` is reserved for startup gates; this plugin currently has no
required startup config because every option has a schema default.

Reserved environment variables:

```text
EXPERTMESH_PLUGIN_EXPERT_MEMORY_ENABLED
EXPERTMESH_PLUGIN_EXPERT_MEMORY_USE_MEMORIES
EXPERTMESH_PLUGIN_EXPERT_MEMORY_GENERATE_MEMORIES
EXPERTMESH_PLUGIN_EXPERT_MEMORY_MEMORY_ROOT
```

Use `createExpertAgentPluginConfigEnvName` from `@pragma/core` to derive
these names from `pluginId` and config key.
