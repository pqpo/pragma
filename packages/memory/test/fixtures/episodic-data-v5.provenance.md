The sibling `episodic-data-v5.sqlite` was written by the original
`createEpisodicMemoryStore` implementation at commit `8bf34f5dd9e5f03370c64b1513b7890f77b2a55c` before ADR 075 changes,
using `ingest`, `claimDueJob`, and `completeRetained`. It contains the existing synthetic
`retrieval/episodic-record.json` fixture and one terminal Evidence envelope permitting
local learning. It was closed before copying; user_version was not rewritten.
