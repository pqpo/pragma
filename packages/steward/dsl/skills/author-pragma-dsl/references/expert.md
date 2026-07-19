# Expert resources

Use an Expert for one conversational agent with a bounded scope.

```yaml
apiVersion: pragma/v2
kind: Expert
metadata:
  id: release_writer
  version: 1.0.0
  name: Release Writer
  description: Produces concise release notes from verified changes.
  tags: [writing]
spec:
  scope: Write release notes; do not publish them.
  instructions: Verify the supplied changes before drafting.
  runtime:
    ref: runtime-profile:default_runtime@1.0.0
  capabilities:
    - ref: capability:repository_tools@1.0.0
      kind: tools
      tools: [read_file]
  toolApprovals: {}
  contextStores: []
  plugins: []
  tools: []
```

- Use only exact Capability, ContextStore, RuntimeProfile, plugin, Expert, Team, and Flow refs.
- `name`, `id`, `description`, `version`, `scope`, `instructions`, and `runtime` are required.
- Use only a RuntimeProfile returned by `list_expert_options`; it must select an explicit provider
  and model.
- For `kind: tools`, list the exact allowed tool names. For `kind: skill`, omit `tools`.
- Put behavioral rules in `scope` and `instructions`; never put credentials or machine paths in DSL.
- Expose another resource as a tool only through a named, versioned tool adapter.
