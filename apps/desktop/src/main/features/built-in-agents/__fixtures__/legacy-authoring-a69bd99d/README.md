# Historical authoring fixtures

Written by the unchanged main `a69bd99d0591aef773cd126332ae3eecaa37e41a` Local Host
`pragma-project-port.ts` (writer SHA-256 and generated IDs in provenance.json).
The writer was executed from the clean original main checkout, with its real Project repository
and first-stage management test fixture, not by changing version numbers on current objects.

Generation used a fresh temporary root and the original port:

1. `startDslDraft({ missionId, workspacePath: root, targets: [{ mode: "create", key: "writer",
kind: "Expert", name: "Legacy Writer", description: "Historical file draft" }] })`.
2. `createEvaluationDraft({ mode: "create", expectedProjectRevision: 0, metadata: {
id: "7h8j9k0m1n2p3q4r", name: "Legacy Evaluation", description: "Historical Run Dry draft",
tags: [] }, targetRef: "flow:8h9j0k1m2n3p4q5r" })`.
3. Copy the original file-draft record, owner, workspace skeleton and Evaluation JSON.

Only the temporary workspace root string was replaced with `__FIXTURE_ROOT__` for relocation.
macOS canonical `/private` prefix remains from the historical writer. No version or business
fields were fabricated. `workspace-files/` stores the original `.pragma/` tree under a non-ignored
fixture directory; the test copies it back to the authorized workspace's `.pragma/` directory.

The historical Evaluation is a legitimate incomplete draft with no cases and a currently missing
Flow; these diagnostics are retained. Recovery checks valid storage/ownership, not whether the
incomplete draft is publishable. Prepare/commit still enforce target and test validity.

The regression checks rejection before handoff, required approval, preserved JSON bytes,
continued inspection, and refusal to claim a known foreign Context.
