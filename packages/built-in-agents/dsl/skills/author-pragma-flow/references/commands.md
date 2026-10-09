# Commands and requests

The CLI accepts the existing handler parameter objects and authoritative validation. Read one
command's help for its current Schema, for example `pragma manage flow draft update --help`.

```sh
pragma manage dsl resources list --input list.json --format json
pragma manage flow draft create --input create.json --request-id <uuid> --format json
pragma manage flow draft update --input update.json --request-id <uuid> --format json
pragma manage flow draft validate --input draft.json --format json
pragma manage flow draft prepare --input prepare.json --request-id <uuid> --format json
pragma manage dsl changes read --input review.json --format json
pragma manage dsl changes commit --input commit.json --request-id <uuid> --format json
pragma manage flow draft discard --input draft.json --request-id <uuid> --format json
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

## Legacy handoff

Older Flow tools produced drafts and prepared changes without command ownership sidecars.
A missing record reports `details.reason: "unowned_target"` and names a recovery command:

```sh
pragma manage flow draft recover --input draft.json --request-id <uuid> --format json
pragma manage dsl changes recover --input commit.json --request-id <uuid> --format json
```

The inputs retain the original `{ "draftId": "..." }` / `{ "changeSetId": "..." }` shapes.
These operations always require current Execution approval; they validate the original data and
claim ownership without rewriting it. A known foreign owner is rejected, including records in
another Pragma Runtime Session. After a successful handoff, resume get/update/prepare or read/commit.
A rejected approval leaves the original data unclaimed. A checkpoint returns `input_required`;
wait for the original approval and retry with the same requestId. Commit approval is independent.
