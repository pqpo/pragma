# Historical repository writer fixture

`skill-name-boundary.json` captures the files returned by the real
`encodeSyncRepository` writer at commit `7ab9269e` in a detached checkout. The entry
document and metadata contain the same name of 50 supplementary Unicode characters.
The writer rejected a 51-character name. The repository marker was not edited.

The v1 format was introduced in `905281f6`. Its `SkillDataSchema` used
`SkillCapabilityDefinitionSchema.shape.name`, whose `capabilityNameSchema()`
already enforced `PRAGMA_TEXT_LIMITS.capability.name = 50` Unicode code points.
The same boundary remained in effect at `7ab9269e`; v1 did not accept 120-character
Skill names. Keep the frozen migration schema at the historical boundary.
