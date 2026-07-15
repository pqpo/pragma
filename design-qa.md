# Expert Studio design QA

## Comparison targets

- Expert directory reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-8d01cacc-d5c7-4512-bbf0-c7af71744d65.png`
- Expert detail reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-d2e5e09d-bbad-4c81-ad1e-fa01a8340b11.png`
- Expert creation reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-715f6979-dbe7-4b83-bfd5-a0a29d5c9ea8.png`
- Historical implementation captures were removed after the comparison was completed; the
  findings below retain the durable QA record.
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
2. Added first-step validation because Name, ID, and Description are required by `defineExpert`.
3. Re-captured all screens and rechecked the core navigation and creation path.

## Follow-up polish

- Define the shared, executable Expert Manifest mapping before wiring these Desktop-managed declarations into `defineExpert()`; workspace and secret resolution must remain host responsibilities.
- Add dedicated editors for skills, tools, MCP servers, and plugins. The persisted data is preserved during identity/model edits, but only its summary is currently displayed.
- Replace the placeholder team and tool collections when their persisted domain models are defined.

final result: passed

---

# Overview long-content optimization design QA

## Comparison targets

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-188c9ee2-36c2-4706-a899-0d84aae65f96.png`
- Browser-rendered implementation: `/tmp/pragma-overview-long-content-optimized.png`
- Side-by-side comparison evidence: `/tmp/pragma-overview-long-content-comparison.png`
- Compact-layout evidence: `/tmp/pragma-overview-long-content-compact.png`
- Primary viewport and state: 1440 × 900, Studio Overview, one expert with a 176-character unbroken description.
- Responsive viewport and state: 1100 × 900, the same Studio Overview data.

## Findings

- The source exposed a P1 content-containment failure: the long expert description crossed the Experts boundary and overlaid the other three resource sections.
- The initial four-column layout also forced headings and support copy into narrow, uneven measures at a normal desktop window.
- No actionable P0, P1, or P2 differences remain after the optimization.

## Fidelity review

- **Fonts and typography:** Existing type families, weights, hierarchy, and link styling are preserved. Names use a one-line clamp and descriptions use a two-line clamp; both retain the complete DOM text and native hover title.
- **Spacing and layout:** The four resources now form a two-by-two desktop grid, giving each section a readable measure. At 1100 px the grid becomes one column. Both checked viewports have equal document client and scroll widths, so there is no horizontal overflow.
- **Colors and tokens:** Existing off-white, charcoal, muted green-gray, divider, focus, and hover tokens are unchanged.
- **Image and icon fidelity:** No raster imagery is involved. Existing Phosphor resource icons are retained without custom SVG or CSS-drawn replacements.
- **Copy and content:** Product copy and real resource data remain unchanged. Long uninterrupted strings wrap inside their own text box before being visually clamped, rather than crossing section boundaries.

## Interaction evidence

- Overview resource rows remain keyboard-accessible buttons.
- Clicking the long-content expert preview opens the Experts directory as designed.
- The full name and description remain available in the accessible button name and native title attributes.
- Browser console contained no warning- or error-level messages.

## Focused region comparison

- The side-by-side evidence focuses on the full resource grid because the failure crossed multiple section boundaries. The revised Experts row remains inside its 401 px column at 1440 px, with its 269 px copy region clamped to two lines and no row or document overflow.

## Comparison history

1. The supplied screenshot showed a P1 overflow where an unbroken expert description rendered across adjacent sections.
2. Replaced the four-column layout with a two-by-two desktop grid, added explicit text containment and line clamps, and preserved full content through title attributes and accessible text.
3. Re-captured at 1440 × 900 with a deliberately long uninterrupted description; document width remained 1440 px with no overflow.
4. Re-captured at 1100 × 900; the layout adapted to one column and document width remained 1100 px with no overflow.

## Follow-up polish

- None required for this scoped optimization.

final result: passed

---

# Context stores overview design QA

## Comparison targets

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-6c8dcd4e-3c52-4143-b48c-d6bc04d1dab8.png`
- Browser-rendered implementation: `/tmp/pragma-overview-context-stores.png`
- Side-by-side comparison evidence: `/tmp/pragma-overview-comparison.png`
- Compact-layout evidence: `/tmp/pragma-overview-context-stores-compact.png`
- Primary viewport and state: 2048 × 872, Studio Overview, empty persisted collections.
- Responsive viewport and state: 1100 × 800, Studio Overview, empty persisted collections.

## Findings

- No actionable P0, P1, or P2 differences remain for the requested Context stores addition.
- The source capture begins at the Studio navigation, while the browser capture includes the existing global application sidebar. This is an expected crop difference and does not affect the Overview implementation.

## Fidelity review

- **Fonts and typography:** The new heading and description reuse the same existing type scale, weights, line height, and muted text color as Experts, Expert teams, and Capabilities.
- **Spacing and layout:** The desktop Overview uses four equal columns with the existing separators, heading rhythm, asset rows, and View all alignment. At 1100 px it becomes a two-column grid with no horizontal overflow.
- **Colors and tokens:** The Context stores section uses the existing background, border, foreground, muted, green-link, and focus tokens without introducing new visual treatments.
- **Image and icon fidelity:** The reference contains no raster assets in this region. The existing Phosphor Database icon is reused for Context stores; no custom SVG or CSS-drawn substitute was added.
- **Copy and content:** The section uses the existing product label and description and renders up to two real Context store names and descriptions, with type labels as the empty-description fallback.

## Interaction evidence

- The Context stores section and fourth View all control render in the Overview DOM.
- Clicking Context stores View all opens the existing Context stores directory.
- The Studio navigation reports the Context store count from the loaded store collection.
- Browser console contained no warning- or error-level messages.

## Focused region comparison

- The full Overview header region is readable at 2048 × 872, so a separate zoomed crop was not needed. The fourth section repeats the source's column border, heading, supporting copy, and action pattern.

## Comparison history

1. Captured the four-column implementation at the same 2048 × 872 viewport as the source and compared both images together.
2. Verified the requested fourth resource section preserves the existing visual system; no P0/P1/P2 fix was required.
3. Captured the 1100 × 800 layout and confirmed the intended two-column adaptation has no horizontal overflow.

## Follow-up polish

- None required for this scoped addition.

final result: passed
