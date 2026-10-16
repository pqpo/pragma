# Historical extraction run archive

`extraction-run-v1.json` was emitted by `createMemoryExtractionRunArchive.save` from commit
`de7aa331350e2439e5f5e23adfeef4559c33ecd1`. The historical module was loaded in a temporary directory
with imports pointed to Core and the frozen v1 schema. The writer itself was unchanged.
All identities and Runtime names are synthetic. It is a real v1 writer output, not a v2 object
with a changed version label.
