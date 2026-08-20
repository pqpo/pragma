# Expert resources

Use an Expert for one conversational agent with a bounded scope.

```yaml
apiVersion: pragma/v5
kind: Expert
metadata:
  id: 1h2j3k4m5n6p7q8r
  avatarId: pragma.avatar.expert.default
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
  contextStores:
    - ref: context-store:4h5j6k7m8n9p0q1r
      namespace: project_docs
      required: true
  plugins: []
  tools: []
```

- Use only exact Capability, ContextStore, RuntimeProfile, plugin, Expert, Team, and Flow refs.
- `name`, `id`, `avatarId`, `description`, `scope`, `instructions`, and `runtime` are required. The host
  allocates `id`; never invent or change it.
- Text limits use Unicode characters after trimming: name 50, description 500, scope 1,000, and
  instructions 5,000. Each tag is at most 20 characters and an Expert has at most 10 tags.
- Reuse an existing project RuntimeProfile when its Runtime, provider, model, and thinking level
  match the selected `list_expert_options` model. Otherwise use that option's `runtimeProfileRef`;
  `prepare_dsl_changes` materializes the Host dependency, so do not author a RuntimeProfile.
- For `kind: tools`, list the exact allowed tool names. For `kind: skill`, omit `tools`.
- A ContextStore mount always declares `ref`, `namespace`, and `required`. Choose a stable,
  Expert-local namespace such as `project_docs`; it is the name used by context tools and must be
  unique within the Expert. It is not derived from the ContextStore ID, binding, or `config.key`.
  Preserve the namespace when editing an existing mount. Use `contextStores: []` when none apply.
- Put behavioral rules in `scope` and `instructions`; never put credentials or machine paths in DSL.
- `avatarId` is a portable system-avatar identifier. Select an exact `avatars[].avatarId` returned
  by `list_expert_options`; never use a path, URL, or embedded image. Read
  [avatars.md](avatars.md) for the stable persona catalog and selection rules.
- Expose another resource as a tool only through a named, versioned tool adapter.
