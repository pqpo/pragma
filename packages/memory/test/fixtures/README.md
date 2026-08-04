# Memory Compatibility Fixtures

`episodic-v1-record.json` preserves the historical v1 representation verbatim. Its
`expert:0000000000memory` provenance value predates enforcement of the canonical 16-character
Crockford Base32 semantic-resource ID format and is intentionally not corrected in place.

Current built-in declarations use the validated `expert:0000000000mem0ry` ref. Keeping the old
fixture unchanged verifies that readers remain able to inspect already-persisted history without
reintroducing the invalid value into current writes.

`memory-extraction-malformed-attention-v1.json` preserves the 6 episodic and 9 semantic v1 job
records from the first-start failure shape. In particular, the historical Zod issue text is kept
verbatim in `lastErrorCode` so the chained v1 → v2 → v3 repair is tested without manufacturing an
old version by mutating a current job object.
