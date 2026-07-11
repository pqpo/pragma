# Expert Studio design QA

## Comparison targets

- Expert directory reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-8d01cacc-d5c7-4512-bbf0-c7af71744d65.png`
- Expert detail reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-d2e5e09d-bbad-4c81-ad1e-fa01a8340b11.png`
- Expert creation reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-715f6979-dbe7-4b83-bfd5-a0a29d5c9ea8.png`
- Implementation captures:
  - `apps/desktop/expert-directory-implementation.png`
  - `apps/desktop/expert-detail-implementation.png`
  - `apps/desktop/expert-create-implementation.png`
- Reference viewport: 1536 × 1024.
- Browser-rendered implementation viewport: 1280 × 720; the in-app browser capped the requested desktop viewport at this size.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] The 1280 px captures use tighter columns and a scrollable page height than the 1536 px references. No persistent control, content group, or primary action is clipped; this is the expected smaller-viewport adaptation.

## Fidelity review

- **Fonts and typography:** The existing Inter/system type scale, dark display headings, muted support copy, and mono-style IDs are preserved. Form labels and small metadata remain readable without truncation.
- **Spacing and layout:** The left application nav and Studio section nav are retained. The list uses one grouped directory surface with row separators; detail uses a focused header, metadata strip, instruction surface, and capability summary; creation uses a progressive four-step layout.
- **Colors and tokens:** Existing off-white, charcoal, forest-green, lime active rail, and gray-green divider tokens are consistently used. No gradients, decorative illustration, or high-elevation dashboard-card treatment was introduced.
- **Image and icon fidelity:** The targets contain no custom raster imagery. Existing Phosphor icons are used consistently, with no handwritten SVG or CSS-drawn icon substitutes.
- **Copy and API alignment:** The flow exposes reusable expert identity fields (name, id, description, tags, version, and scope), optional instructions, and model selection from configured providers. Workspace remains a run-time choice rather than part of the reusable declaration. Skills, tools, MCP servers, and plugins are preserved by the persisted definition but do not yet have dedicated editors. Per-run output schema, raw secrets, environment values, hooks, and logger internals are deliberately omitted.
- **Accessibility and states:** Native buttons, labels, search input, selects, keyboard-focus styles, semantic navigation, empty search behavior, validation feedback, selected steps, and disabled main-navigation items are present.

## Interaction evidence

- Clicking an expert row opens its detail view.
- **Back to Experts** returns to the directory.
- **Create expert** opens the four-step declaration flow.
- Empty Name, ID, or Description blocks the first step with an accessible alert.
- A completed draft persists a revisioned local expert definition and opens its detail view.
- Browser console contained no error-level messages.

## Comparison history

1. Captured and compared the initial directory, detail, and creation screens.
2. Added first-step validation because Name, ID, and Description are required by `defineAgent`.
3. Re-captured all screens and rechecked the core navigation and creation path.

## Follow-up polish

- Define the shared, executable Expert Manifest mapping before wiring these Desktop-managed declarations into `ExpertAgent.create()`; workspace and secret resolution must remain host responsibilities.
- Add dedicated editors for skills, tools, MCP servers, and plugins. The persisted data is preserved during identity/model edits, but only its summary is currently displayed.
- Replace the placeholder team and tool collections when their persisted domain models are defined.

final result: passed
