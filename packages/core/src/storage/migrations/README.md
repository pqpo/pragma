# Persistent state migrations

Each durable state family owns one directory. Historical schemas are immutable snapshots, and every
behavioral change is an adjacent TypeScript step.

```text
<family>/
  schemas/
    vN.ts
  steps/
    vN-to-vN+1.ts
  index.ts
```

Rules:

1. Add the new current Zod schema to its owner before adding the migration.
2. Freeze the previous complete persisted shape in `schemas/vN.ts`; historical schemas must not be
   derived from the newest aggregate schema.
3. Add exactly one adjacent step. Never add pairwise shortcuts such as `v5-to-v8`.
4. Keep `index.ts` declarative: static imports, ordered steps, current family/version/schema, and no
   transformation logic.
5. Multi-document aggregate transforms belong to the step and are published through the stable
   state-migration journal by the owning store.
6. Version embedded business transaction journals separately and reuse the same aggregate
   transforms.
7. Add old/current/future fixtures and interruption-recovery tests before changing the current
   version.

Do not dynamically scan this directory or execute arbitrary migration modules at runtime. Static
imports keep migrations visible to TypeScript, lint, tests, and Electron packaging.
