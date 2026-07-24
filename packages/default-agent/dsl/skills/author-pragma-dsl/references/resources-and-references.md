# Resources, references, and revisions

Canonical semantic refs have the form `<kind>:<id>@<version>`:

```text
expert:writer@1.0.0
team:delivery@1.0.0
flow:review@1.0.0
automation:daily_review@1.0.0
capability:repository_tools@2.0.0
context-store:project_guide@1.0.0
runtime-profile:default_runtime@1.0.0
```

- Semantic resource IDs contain only letters, digits, and underscores and must start with a letter
  or digit. Versions use their separate version syntax.
- A project revision is the atomic history of the whole DSL project. Updating an existing canonical
  ref creates a new project revision, so runs pinned to an older revision remain reproducible.
- Create a new resource version when the user wants both contracts to coexist or callers must opt in
  explicitly. Update the existing version for an ordinary project-local refinement.
- Never embed credentials, local paths, provider secrets, or live database identifiers in portable
  resources. Reference a Capability, ContextStore, RuntimeProfile, or host binding instead.
- Include every interdependent edit in one change-set and validate the complete candidate project.
