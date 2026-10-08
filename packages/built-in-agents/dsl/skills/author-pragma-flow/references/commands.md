# Commands and requests

The CLI accepts the existing handler parameter objects and authoritative validation. Read one
command's help for its current Schema, for example `pragma flow draft update --help`.

```sh
pragma dsl resources list --input list.json --format json
pragma flow draft create --input create.json --request-id <uuid> --format json
pragma flow draft update --input update.json --request-id <uuid> --format json
pragma flow draft validate --input draft.json --format json
pragma flow draft prepare --input prepare.json --request-id <uuid> --format json
pragma dsl changes read --input review.json --format json
pragma dsl changes commit --input commit.json --request-id <uuid> --format json
pragma flow draft discard --input draft.json --request-id <uuid> --format json
```

A draft request is `{ "draftId": "<returned UUID>" }`. An update object contains `draftId`,
`expectedDraftRevision`, and a native `operations` array. A prepare object contains `draftId` and
`expectedDraftRevision`; optional `additionalSources` must exclude Evaluations.
A commit object is `{ "changeSetId": "<prepared UUID>" }`.

Resource and options queries retain filters, bounded limits and nextCursor. Prepared source reads
retain the original bounded section/offset interface. Do not concatenate all pages into the next
model prompt.

The command response identifies its command and requestId and includes the original handler result
or management error, including diagnostics, retryability, details and recovery. An invalid prepare
is a business result and exit code 10. Reuse the same requestId only with the same payload.
If an interrupted mutation has an uncertain receipt, inspect the draft before proceeding; a CLI
exit never rolls back an already published Project revision.

If the response status is `input_required`, stop and let the original Execution collect approval.
Do not turn a Human checkpoint into a second independent commit attempt.
