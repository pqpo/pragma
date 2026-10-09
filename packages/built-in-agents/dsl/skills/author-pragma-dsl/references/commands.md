# DSL command workflow

Each command accepts `--input <file|-> --request-id <uuid> --format json`. Inspect its `--help`
for current fields and limits. JSON files are inside the authorized workspace; stdin carries the
same JSON object. Returned draft paths are the editable files, not Project storage.

```sh
pragma dsl draft start --input start.json --format json
pragma dsl draft inspect --input draft.json --format json
pragma dsl draft review --input review.json --format json
pragma dsl draft prepare --input draft.json --format json
pragma dsl changes commit --input commit.json --format json
```

`start.json` uses `targets`, for example an existing Expert:

```json
{ "targets": [{ "mode": "edit", "ref": "expert:1xddvess309a6gme" }] }
```

New targets use `{ "mode": "create", "key": "writer", "kind": "Expert", "name": "Writer",
"description": "Draft concise copy" }`; Teams use `kind: "ExpertTeam"`. `draft.json` contains
`draftId`; `commit.json` contains the returned `changeSetId`. Neither contains caller identity.

Follow review `nextCursor` with the same section and ref. A stale target requires `dsl draft restart`
and explicit edit replay; do not modify the read-only reference. Invalid prepare returns exit 10
and diagnostics. Permission/conflict failures preserve structured error and recovery information.
Reuse a request ID only with identical payload; inspect/recover rather than blindly issuing a new
mutation when a receipt is uncertain. Legacy draft recovery requires approval and preserves files.
