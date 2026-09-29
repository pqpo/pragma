These fixtures were written by the unmodified implementations at main commit
858ae1abaa3116694a708f6f906c5e639ede8137, executed with the repository dependencies.
The episodic and semantic fixtures use that commit's fake extractors and evidence builders
through the real Module/Store writes (not direct inserts or current objects with changed versions).
SQLite files were copied after closing their owners, with WAL checkpointed.
`model-providers-v6.json` was written by Desktop's real v6 provider store with a synthetic
`historical-test-only-key` in an isolated test SecretStore. The SecretRef is provenance;
no credential store or actual credentials are included. `attention-v1.json` was written by
the real v1 file state store. New code must migrate these files without altering the originals.

`model-providers-v5.json` was written by the actual v5 Desktop writer at `4f7e1b2a^`,
using the same synthetic provider/isolated SecretStore. Its optional token-limit metadata
is absent exactly as the old writer produced it. This fixture exercises the v5 → v6 → v7 chain.
