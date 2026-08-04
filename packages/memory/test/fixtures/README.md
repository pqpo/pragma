# Memory Compatibility Fixtures

`episodic-v1-record.json` preserves the historical v1 representation verbatim. Its
`expert:0000000000memory` provenance value predates enforcement of the canonical 16-character
Crockford Base32 semantic-resource ID format and is intentionally not corrected in place.

Current built-in declarations use the validated `expert:0000000000mem0ry` ref. Keeping the old
fixture unchanged verifies that readers remain able to inspect already-persisted history without
reintroducing the invalid value into current writes.
