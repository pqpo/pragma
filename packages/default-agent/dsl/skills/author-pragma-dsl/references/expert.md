# Expert resources

Use an Expert for one conversational agent with a bounded scope.

```yaml
apiVersion: pragma/v3
kind: Expert
metadata:
  id: 1h2j3k4m5n6p7q8r
  name: Release Writer
  description: Produces concise release notes from verified changes.
  tags: [writing]
spec:
  scope: Write release notes; do not publish them.
  instructions: Verify the supplied changes before drafting.
  runtime:
    ref: runtime-profile:2h3j4k5m6n7p8q9r
  capabilities:
    - ref: capability:3h4j5k6m7n8p9q0r
      kind: tools
      tools: [read_file]
  toolApprovals: {}
  contextStores: []
  plugins: []
  tools: []
```

- Use only exact Capability, ContextStore, RuntimeProfile, plugin, Expert, Team, and Flow refs.
- `name`, `id`, `description`, `scope`, `instructions`, and `runtime` are required. The host
  allocates `id`; never invent or change it.
- Use only a RuntimeProfile returned by `list_expert_options`; it must select an explicit provider
  and model.
- For `kind: tools`, list the exact allowed tool names. For `kind: skill`, omit `tools`.
- Put behavioral rules in `scope` and `instructions`; never put credentials or machine paths in DSL.
- Expose another resource as a tool only through a named, versioned tool adapter.
