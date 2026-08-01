# Resources, references, and revisions

Canonical semantic refs have the form `<kind>:<id>`:

```text
expert:1h2j3k4m5n6p7q8r
team:2h3j4k5m6n7p8q9r
flow:3h4j5k6m7n8p9q0r
evaluation:8h9j0k1m2n3p4q5r
automation:4h5j6k7m8n9p0q1r
capability:5h6j7k8m9n0p1q2r
context-store:6h7j8k9m0n1p2q3r
runtime-profile:7h8j9k0m1n2p3q4r
```

- Semantic resource IDs are opaque 16-character lowercase Crockford Base32 values allocated by the
  host. Never derive meaning from them or ask the user to edit them.
- A project revision is the atomic history of the whole DSL project. Updating an existing canonical
  ref creates a new project revision, so runs pinned to an older revision remain reproducible.
- Semantic resources do not have individual versions. External packages and adapters remain
  explicitly versioned, for example `pragma.capability.host@v1`.
- Never embed credentials, local paths, provider secrets, or live database identifiers in portable
  resources. Reference a Capability, ContextStore, RuntimeProfile, or host binding instead.
- Include every interdependent edit in one change-set and validate the complete candidate project.
- Capability and ContextStore resource names are limited to 50 Unicode characters and descriptions
  to 500 after trimming. These are the same limits used by Desktop forms and the compiler.

## Project resources and Host options

- `list_dsl_resources` lists resources already in the current project. Read and reuse their exact
  refs instead of creating another resource with the same name or purpose.
- `list_expert_options` lists ready Host Runtime models and capabilities. For Runtime models, use
  the `runtimeProfileRef` field, not a copied display name or a newly allocated RuntimeProfile.
- Prefer an existing project RuntimeProfile only when its `spec.config.runtimeId`, `providerId`,
  `model`, and optional `thinkingLevel` match the intended selection. Otherwise use the Host
  option's `runtimeProfileRef`; `prepare_dsl_changes` adds that dependency automatically.
- A Host Runtime or Capability ref may not be readable through `read_dsl_resource` before it is
  materialized. This is expected. Project refs must be readable before use.
