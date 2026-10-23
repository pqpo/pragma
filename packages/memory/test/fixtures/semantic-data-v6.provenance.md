`semantic-data-v6.sqlite` was written by the original `createSemanticMemoryStore`
implementation at commit `8bf34f5dd9e5f03370c64b1513b7890f77b2a55c` before ADR 075, starting from the existing
synthetic retrieval v5 fixture. The historical store performed its own 5 → 6
upgrade, then its `invalidate` method wrote a governance notification with
`learning_eligible=0`. The store was closed before copying; user_version was
not rewritten. The new 6 → 7 upgrade must distinguish this source invalidation
from a captured-learning denial without changing the Fact revision.
