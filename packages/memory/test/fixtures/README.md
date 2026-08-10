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

`skill-learning-store-v1.json` preserves the original Skill Learning v1 classification of a source
threshold rejection beside a genuine extractor configuration failure. The v1 → v2 store migration
archives only the threshold rejection as a completed job and leaves the actionable failure intact.

`skill-learning-store-v2.json` and `knowledge-learning-store-v2.json` preserve candidate-level
validation failures beside genuine configuration failures. Their v2 → v3 migrations requeue only
the candidate failures so the new per-candidate filters can salvage valid siblings, while actionable
configuration failures remain unchanged.
