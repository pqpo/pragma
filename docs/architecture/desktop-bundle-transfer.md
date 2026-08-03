# Desktop Bundle Transfer

The Pragma desktop app is the Host Adapter for the `@pragma/interpreter` Bundle protocol. It can
export one custom Expert, Expert Team, or Flow from Studio as a `.pragma`. The file is an ordinary
`pragma.bundle/v1` ZIP archive intended for transfer between computers; Desktop does not own a
second Bundle Schema or codec.

## Export

Open Studio and use **Export** in the sidebar. Select the root object and the modules that should
travel with it:

- **Capabilities** includes portable Skills and service definitions.
- **Plugins** includes user-installed plugin packages when available.
- **Knowledge bases** includes their Markdown content and is off by default.
- **Flow layouts** includes canvas positions and viewport state.

Interpreter selects the root's transitive DSL closure and emits canonical YAML, lock, requirements,
payload indexes, and both archive and portable-project fingerprints. Turning a module off omits its
Host payload, not the DSL dependency, so the destination can guide the user through binding it.

Secrets, local sessions, Missions, usage data, workspace files, provider accounts, and absolute
local paths are excluded.

## Import

Use **Import** in Studio and choose or drag in one `.pragma` file. Import and export use separate
dialogs. Interpreter validates the ZIP, file hashes, Pragma YAML, lock, compiler capability, and
portable project fingerprint before Desktop writes local state. If an archive declares multiple
roots, choose exactly one root for this installation.

Import is prepared as a wizard before one final confirmation:

1. Select and validate the Bundle.
2. Resolve every resource conflict independently. **Import as a copy** creates a new identity for
   that resource; **Update matching resource** retains its local identity. Desktop chooses the
   identities and Interpreter rewrites all typed references in a localized project copy.
3. Bind one unresolved dependency at a time.
4. Review the complete import and commit it.

Desktop automatically reuses exact Runtime/model, capability, knowledge-base, and plugin matches.
Included portable payloads are installed automatically. Everything else appears in **Finish local
setup**. Runtime and model are selected separately. Entering a Runtime binding refreshes local
availability automatically; the same screen also has a manual refresh action and listens for
background model-catalog updates.

The imported object remains visible and persisted while setup is incomplete, but it cannot create
or run a Mission. This gate also applies when another Flow reaches the pending object indirectly.
Save all required bindings and secrets to move the installation to `ready`.

If Desktop closes during import, the installation is marked failed at the next startup. Selecting
the same archive and root again performs a fresh validated retry. Incomplete copy imports can also be
discarded from the import dialog; update imports are not automatically rolled back because doing so
could overwrite later project work.

Desktop stores installation state as `pragma.bundle-installation/v3`. Archive identity
(`bundleFingerprint`) and portable content identity (`sourceProjectFingerprint`) are distinct: the
former protects the inspected bytes and retry transaction, while the latter supports advisory
content comparison without silently merging installations.

Legacy `pragma.desktop-bundle/v1` archives are deliberately not accepted. Import them with Pragma
Desktop v0.1.0, upgrade the application, and export them again as `pragma.bundle/v1`.
