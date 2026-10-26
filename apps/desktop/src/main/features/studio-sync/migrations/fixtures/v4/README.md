# Expected DSL fingerprint migration outputs

These are expected outputs of the registered journal v3-to-v4 and embedded state v2-to-v3
migrations. Inputs are the frozen v3 journals in the adjacent directory; their historical
writer provenance is recorded in `../v1/README.md`. The v3 inputs have not been rewritten.
The adjacent `../v3/state.json` is the expected state v2-to-v3 output.

Journal DSL payloads, expected fingerprints, incoming baselines and summary fingerprints
upgrade together. Domain revision expectations remain unchanged. Standalone checkpoints
only contain hashes: their v3 upgrade preserves them until an actual local or remote
resource proves which current fingerprint represents the same content.
