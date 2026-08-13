# Evaluation Secondary Navigation Design QA

- Source visual truth:
  `/Users/linminqiu/.codex/generated_images/019ff6a6-5aea-7931-b2f5-793bcb62a956/exec-62921af1-f544-4b26-9be0-2d9b96ca53f5.png`
- Implementation screenshot: unavailable; the in-app browser rejected the local preview URL under
  its URL security policy.
- Combined comparison: unavailable because no compliant implementation screenshot could be
  captured.
- Intended comparison viewport: 1440 × 1024 CSS pixels at DPR 1, light theme.
- Density normalization:
  - Source: 1487 × 1058 pixels, intended to be normalized to the 1440 × 1024 CSS viewport.
  - Implementation: unavailable.
- State: Simplified Chinese Evaluations page with the Project Manager Expert selected, no Agent
  Judge datasets, and no queued runs.

**Findings**

- [Blocked] The required browser-rendered implementation evidence is unavailable. The local Vite
  preview started successfully, but the selected in-app browser refused navigation to the local
  preview under its URL security policy. Browser guidance prohibits switching surfaces or using an
  alternate route to bypass that decision.
- Fonts and typography, spacing and layout rhythm, colors and tokens, image/icon fidelity, copy,
  responsive wrapping, and the visible no-shadow empty state could not be compared against the
  source image without the implementation capture.
- Static implementation review confirms that the screen continues to use the existing
  Inter/SF/PingFang stack, Pragma tokens, and Phosphor icons; this is not a substitute for visual
  evidence and does not change the blocked result.

**Interaction and code evidence**

- Focused renderer tests verify that Experts and Expert Teams expose Start evaluation, Datasets,
  and Queue actions while Flows keep only the existing Run Dry action.
- Focused renderer tests verify explicit Back to target semantics for both secondary pages.
- Desktop node/web typechecks and Desktop lint pass. Focused Evaluation tests pass 8/8.
- The full Desktop suite passes 790/792 assertions. Two unrelated Runtime availability tests fail
  because local Claude Code and Qoder CLI executables are unavailable and a built-in Runtime probe
  resolves differently in this machine environment.

**Comparison history**

1. Started a local Vite harness using the real Evaluations components, styles, localization, and a
   deterministic project fixture matching the source state.
2. Attempted to open the preview in the selected Codex in-app browser at the required local preview
   address.
3. Navigation was rejected by browser URL policy before any DOM, screenshot, or console evidence
   could be collected. No alternate browser or URL workaround was attempted.

**Implementation checklist**

- Capture the implemented Expert empty state at 1440 × 1024 when local preview navigation is
  permitted.
- Compare the source and implementation in one combined image, then fix any P0/P1/P2 differences.
- Verify Datasets, Queue, Back to target, target switching, keyboard focus, and browser console
  errors before changing the result to passed.

final result: blocked

---

# Memory Health Design QA

- Source visual truth: `design-qa/source-option-2.png`
  - Original generated result:
    `/Users/linminqiu/.codex/generated_images/019fd27b-b893-77f0-a08d-4812bd2ce043/exec-2f71bdee-13b2-40ad-b10f-62a724b418d9.png`
- Implementation screenshot: `design-qa/implementation-final.jpg`
- Combined comparison: `design-qa/comparison-final.jpg`
- Viewport: 1400 × 933 CSS pixels at DPR 1, light theme, collapsed application rail
- Density normalization:
  - Source: 1557 × 1010 pixels, rendered at 1400px width with its aspect ratio preserved.
  - Implementation: 1400 × 933 pixels captured at the CSS viewport size.
  - The comparison keeps the implementation's additional 25px of empty lower canvas rather than
    distorting either image.
- State: Memory page with Health selected, a running plane, three healthy modules, 1325 canonical
  events, 2.7 MiB of 512 MiB Feed storage, safe-through sequence 200, and no durable-consumer block.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography preserve the existing Inter/SF Pro/PingFang stack, compact table sizing,
  tabular numerals, localized status labels, and the selected direction's hierarchy.
- Spacing and layout rhythm match the selected two-stage composition: one restrained overview
  surface followed by a 31/69 Feed-and-module split with lightweight row separators. The redundant
  visible `健康状态` content heading is removed.
- Colors and visual tokens reuse the current Pragma canvas, surface, graphite, sage, border, focus,
  radius, and low-elevation tokens. Degraded, unavailable, and stopped states retain distinct
  semantic colors without relying on color alone.
- Image and asset fidelity: the screen requires no raster content beyond the existing Pragma brand
  asset. All new interface icons use the installed Phosphor library; no handwritten SVG, CSS art,
  placeholder asset, gradient, or decorative chart was introduced.
- Copy and content are complete in English, Simplified Chinese, and Traditional Chinese. The
  implementation intentionally localizes `healthy` as `健康` and shows blocked storage as
  `0.0 MiB`, which is more precise than the generated visual's unitless zero.

**Full-view comparison evidence**

- The selected design and rendered implementation were opened together in
  `design-qa/comparison-final.jpg` at the same normalized width and state.
- Both retain the collapsed application rail, Memory header and tabs, one global status overview,
  a capacity-focused Feed column, and an aligned module diagnostic table.
- The implementation preserves the product's real page insets and denser typography while matching
  the selected visual's information hierarchy and major-region proportions.

**Focused region comparison evidence**

- A separate crop was not required because the stacked 1400px comparison keeps overview metrics,
  Feed labels, module IDs, status pills, headers, and every numeric cell readable.

**Interactions and diagnostics**

- Verified selecting the Health tab from the Memory navigation and confirmed its active state in
  the browser DOM.
- Verified the Feed utilization is exposed as a named progressbar, the overview is announced as a
  status, and the module diagnostics use table, row-header, and column-header semantics.
- Browser console contained no warnings or errors in the verified state.
- Focused Memory tests passed 10/10. Desktop renderer typecheck and focused ESLint checks passed.

**Comparison history**

1. Pass 1 found a P2 proportion mismatch: the overview metric group and Feed column were narrower
   than the selected direction, making the status sentence dominate the top surface.
2. Increased the overview metrics to 58% of the inner surface and the Feed column to 31% of the
   detail grid while preserving minimum table width and responsive overflow behavior.
3. Pass 2 aligned the overview dividers and two-column composition with the selected design. No
   actionable P0/P1/P2 differences remained.

**Follow-up Polish**

- P3: after real degraded and unavailable module states appear in production data, capture those
  states to tune long error-code truncation without changing the current layout.

final result: passed

---

# Evaluations Directory Design QA

- Source visual truth:
  `/tmp/codex-remote-attachments/019fb80c-e9ea-7f52-9064-565ffaf6a77b/4e6cfd54-2239-43c8-bba8-07d20b070eac/1-Photo-1.jpg`
- Implementation screenshot: `design-qa/evaluations-directory.png`
- Combined comparison: `design-qa/evaluations-directory-comparison.png`
- Viewport: 1280 × 800 CSS pixels at DPR 1, light theme, collapsed application rail
- Density normalization:
  - Source: 1280 × 801 pixels.
  - Implementation: 1280 × 800 pixels.
  - No scaling was applied; the combined comparison retains one blank bottom row under the
    implementation.
- State: Evaluations directory with three Experts, two Expert Teams, three Flows, the evaluated
  Flow selected, and three saved Run Dry suites.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography use the existing Desktop system stack and reproduce the source hierarchy:
  30px page heading, compact target-group labels, 20px selected-target heading, and dense table
  metadata.
- Spacing and layout rhythm align the source's 88px application rail, 1100px bounded directory
  surface, 300px target column, 32px workspace inset, action row, and compact table rows. The
  directory surface reaches the viewport bottom without hiding persistent controls.
- Colors and visual tokens reuse the current Pragma background, surface, border, sage selection,
  graphite text, status, focus-ring, radius, and shadow tokens.
- Image and asset fidelity: the screen needs no raster content beyond the existing Pragma product
  icon. All interface icons use the installed Phosphor library; no handwritten SVG, CSS drawing,
  placeholder image, or generated asset was introduced.
- Copy and content are available in English, Simplified Chinese, and Traditional Chinese. The
  implementation deliberately shows `尚未运行` and `—` until a real run finishes because the
  current Evaluation protocol does not persist historical run metadata; it does not fabricate the
  passing and failing history shown in the visual reference.

**Full-view comparison evidence**

- The source and implementation were opened together in
  `design-qa/evaluations-directory-comparison.png` at matching width and state.
- Both show the same three-layer hierarchy: collapsed application rail, searchable grouped target
  directory, and selected-object Run Dry workspace.
- The target title, description, primary actions, table heading, three suite rows, active target,
  and outer surface boundaries align at the same visual scale.

**Focused region comparison evidence**

- A separate crop was not required because the 1280px comparison keeps the complete navigation,
  group labels, controls, table copy, icons, and row dividers readable.
- The unsupported Expert state was inspected separately in the browser DOM and showed a disabled
  global create action plus the explicit `当前仅 Flow 支持 Run Dry 测评` explanation.

**Interactions and diagnostics**

- Verified target search filtering, clearing the filter with the keyboard, switching from a Flow to
  an Expert, the unsupported-method state, and returning to the evaluated Flow without losing its
  suites.
- Create, open-suite, and batch-run controls are wired to the existing Desktop bridge. Batch-run
  results update coverage, pass/fail status, and run time only after the real result returns.
- Browser console contained no warnings or errors in the verified state.
- Desktop renderer typecheck, all 89 Desktop test files (534 tests), and Desktop lint passed.

**Comparison history**

1. Pass 1 found P2 composition drift: the page started about 10px too high, the directory surface
   was centered too narrowly, and target actions sat beside the title, pulling the table about 70px
   above the source.
2. Moved the page to the source vertical origin, fixed the directory at the reference 1100px width
   with a left-aligned 300px target rail, and placed actions below the target description.
3. Pass 2 aligned the title, surface, content rail, action row, and table rhythm. No actionable
   P0/P1/P2 differences remained.

**Follow-up Polish**

- P3: once run history becomes a persisted product domain, replace the session-only last-result and
  last-run values with durable records without changing this page structure.

final result: passed

---

# Knowledge Base Revision Workflow Design QA

- Source visual truth:
  `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-e9bc02e3-93bb-4b05-aa1d-e98421b70720.png`
- Implementation screenshots: `design-qa/context-store-directory-revision-entry.png`,
  `design-qa/context-store-submit-revision-dialog.png`, and
  `design-qa/context-store-revision-list.png`
- Responsive evidence: `design-qa/context-store-revision-list-1280.png`
- Combined comparison: `design-qa/context-store-revision-comparison.png`
- Viewport: 2048 × 1098 CSS pixels at DPR 1; responsive verification at 1280 × 800
- Density normalization:
  - Source: 2612 × 1400 pixels, normalized to 1024 × 549 for the comparison board.
  - Implementation: 2048 × 1098 pixels, normalized to 1024 × 549 for the comparison board.
- State: knowledge base directory with revision entry, knowledge base detail with submission dialog,
  and the filtered revision activity page immediately after a successful submission.

**Findings**

- No actionable P0, P1, or P2 visual or interaction issues remain.
- Fonts and typography preserve the existing Desktop system stack, compact 12–14px interface text,
  16px dialog title, and 30px page-heading hierarchy without introducing a new type style.
- Spacing and layout rhythm preserve the two-rail application shell, existing 48px content inset,
  table density, control heights, radii, and divider rhythm. The revision page now reads as a child
  of Knowledge bases through the retained active navigation state and explicit back action.
- Colors and visual tokens reuse the current graphite, sage selection, surface, border, semantic
  status, focus, radius, and shadow tokens. The dialog backdrop and disabled state retain accessible
  contrast.
- Image and asset fidelity: no new raster content is needed. The existing Pragma logo is preserved
  and all interface icons use the installed Phosphor library; no handwritten SVG, CSS drawing,
  placeholder image, or generated asset was introduced.
- Copy and content accurately separate responsibilities: the directory links to all revision
  activity, the detail page submits a store-scoped request, and the secondary page only tracks,
  reviews, retries, or deletes tasks. English, Simplified Chinese, and Traditional Chinese are kept
  in parity.

**Full-view comparison evidence**

- The source and the three implementation states were opened together in
  `design-qa/context-store-revision-comparison.png`.
- The implementation deliberately removes the old standalone navigation destination and page-level
  composer. The knowledge directory now owns the task-history entry point, while the knowledge
  detail owns the submission action and modal.
- The task activity page preserves the source visual language and status/action density while adding
  a clear parent breadcrumb and a focused knowledge-base filter.

**Focused region comparison evidence**

- The modal screenshot is the focused comparison for the former inline composer: it preserves the
  request field, validation, maximum length, and primary action while adding store context and the
  explicit review-before-apply promise.
- The directory screenshot verifies that the task entry and active-count badge remain adjacent to
  the knowledge-base creation action without creating another navigation row.

**Interactions and diagnostics**

- Verified Studio → Knowledge bases, Knowledge bases → Revision tasks, knowledge row → detail,
  Submit revision → dialog, empty-request disabled state, request entry, successful submit, and
  automatic redirect to the current store's filtered revision activity.
- Verified pending, running, and pending-review status presentation plus approve and reject actions
  with realistic mock tasks.
- At 1280 × 800, the document remained exactly 1280px wide with no horizontal overflow; task actions
  wrap below the status content without hiding controls.
- Browser console contained no warnings or errors in the verified states.
- Desktop node/web typechecks and lint passed. The focused renderer tests passed 11/11, and the
  complete Desktop suite passed 679/679 after the obsolete top-level-navigation expectation was
  updated.

**Comparison history**

1. Pass 1 compared the source against the directory, modal, and revision-list states. No actionable
   P0/P1/P2 issue was found; the hierarchy change is intentional and directly follows the requested
   workflow.
2. Responsive pass at 1280 × 800 confirmed the toolbar, rows, status pills, and task actions remain
   visible without page-level overflow.

**Follow-up Polish**

- P3: a future task-detail route could deep-link directly to a newly submitted job once the product
  needs shareable task URLs. The current filtered-list redirect keeps this change within the
  existing in-app navigation model.

final result: passed

---

## Revision list refinement pass — 2026-08-06

- Source visual truth:
  `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-04d07b4d-c813-4109-b34a-4ce5960e7552.png`
- Implementation screenshot: `design-qa/context-store-revision-list-refined-1688.png`
- Responsive evidence: `design-qa/context-store-revision-list-refined-1280.png`
- Detail-entry evidence: `design-qa/context-store-detail-revision-entry-refined.png`
- Combined full-view comparison: `design-qa/context-store-revision-list-refined-comparison.png`
- Viewport and density: source and implementation are both 1688 × 896 CSS/pixel output at DPR 1;
  no density normalization was required. Responsive verification used 1280 × 800.
- State: two revision tasks filtered to `00pragma`, including running and pending-review states;
  the detail-entry capture shows both Revision history and Submit revision actions.

**Findings**

- No actionable P0, P1, or P2 issues remain after the refinement pass.
- Fonts and typography: the implementation keeps the existing Desktop system stack and removes the
  oversized explanatory card. Page heading, metadata, column labels, body copy, and status labels use
  a clear 30/13/12/11px hierarchy with stable two-line truncation for long requests.
- Spacing and layout rhythm: the filter is now a compact 36px control in the title row. A fixed
  four-column grid aligns request, status, update time, and actions; row dividers and 18px vertical
  padding produce a consistent scan rhythm. At 1280px the actions move to a deliberate second row
  rather than colliding with time or status.
- Colors and visual tokens: all surfaces, borders, sage status fills, semantic buttons, hover states,
  and focus treatment use existing Desktop tokens. No additional palette or decorative treatment was
  introduced.
- Image and asset fidelity: the screen needs no content imagery. The Pragma logo is unchanged and all
  new controls use installed Phosphor icons; there are no custom SVGs, CSS illustrations, emoji, or
  placeholder assets.
- Copy and content: task rows lead with the actual revision request instead of repeating the knowledge
  base name. The knowledge base remains secondary metadata, timestamps are localized, and the detail
  page distinguishes Revision history from the primary Submit revision action in all three locales.

**Full-view comparison evidence**

- `design-qa/context-store-revision-list-refined-comparison.png` places the supplied current screen and
  the rendered replacement at the same 1688 × 896 size.
- The replacement removes the large filter card, converts the loose three-region rows into one aligned
  table, reduces above-the-fold dead space, and keeps review actions attached to the correct task.

**Focused region comparison evidence**

- `design-qa/context-store-detail-revision-entry-refined.png` verifies the newly requested direct list
  entry next to Submit revision. The two actions have distinct secondary/primary hierarchy and remain
  separate from the destructive delete action.
- No additional crop was needed for the table because its labels, status pills, timestamps, and action
  controls are legible at the equal-size full-view comparison.

**Interactions and diagnostics**

- Verified Knowledge bases → Revision tasks opens the unfiltered list with “All knowledge bases”.
- Verified knowledge-base detail → Revision history opens the current-store filtered list without
  submitting a task.
- Verified Submit revision still opens the submission dialog independently.
- Verified 1688 × 896 and 1280 × 800 layouts; no persistent control is clipped or hidden.
- Browser console contained no errors in the verified directory, detail, dialog, and list states.
- Desktop node/web typechecks, focused lint, and focused renderer tests passed.
- Three unrelated runtime/mission tests that timed out during the parallel full-suite run were rerun
  in isolation and passed 36/36.

**Comparison history**

1. The supplied screen showed a P2 alignment and hierarchy problem: an oversized filter card consumed
   the first content row, task fields did not share column baselines, and actions floated independently.
2. The implementation removed the card, introduced the four-column task grid, localized timestamps,
   and added responsive action placement.
3. The equal-size post-fix comparison and the 1280px pass found no remaining actionable P0/P1/P2
   difference.

**Follow-up Polish**

- None required for this scope.

final result: passed

---

## Quiet revision list and Diff review pass — 2026-08-06

- Source visual truth: `design-qa/context-store-revision-list-refined-1688.png`
- Implementation list: `design-qa/context-store-revision-list-quiet.png`
- Diff detail: `design-qa/context-store-revision-diff.png`
- Responsive Diff evidence: `design-qa/context-store-revision-diff-1280.png`
- Combined full-view comparison: `design-qa/context-store-revision-list-quiet-comparison.png`
- Viewport and density: source and implementation list are both 1688 × 896 CSS/pixel output at
  DPR 1; no density normalization was required. Diff responsiveness was verified at 1280 × 800.
- State: two revision tasks, one awaiting review with a two-file change set and one still running;
  Diff evidence includes a modified file and a newly added file.

**Findings**

- No actionable P0, P1, or P2 issues remain.
- Fonts and typography: the quiet list keeps the established Desktop type scale and removes button
  weight from the primary scan path. Diff content uses the system monospace stack with distinct line
  numbers and readable 1.6 line height.
- Spacing and layout rhythm: task rows no longer use separators. Whitespace, a 64px row target, and a
  subtle hover surface provide grouping. The Diff view uses one bounded workspace with a single file
  rail rather than nested cards.
- Colors and visual tokens: the list remains neutral; only status and the View changes affordance use
  sage. Diff additions and deletions use low-opacity semantic green/red fills with sufficient text
  contrast and no decorative gradients.
- Image and asset fidelity: no imagery is required. Existing Pragma branding is unchanged and all
  file, add, edit, delete, and navigation controls use Phosphor icons.
- Copy and content: the list now names the next action “View changes”. Review and rejection move into
  the result page, where the request, result summary, base revision, changed files, line-level changes,
  and approval controls appear together. English, Simplified Chinese, and Traditional Chinese remain
  in parity.

**Full-view comparison evidence**

- `design-qa/context-store-revision-list-quiet-comparison.png` shows the previous divider-heavy list
  above the replacement at the same viewport. The replacement removes the top rule, column rule, row
  rules, inline change-set rule, and list-level approval buttons while preserving scan alignment.
- The resulting page relies on whitespace and one explicit View changes entry, matching the requested
  lower-noise direction.

**Focused region comparison evidence**

- `design-qa/context-store-revision-diff.png` verifies the new review state: changed-file navigation,
  localized base metadata, line numbers, addition/deletion counts, and inline red/green Diff rows are
  all visible without scrolling at 1688 × 896.
- `design-qa/context-store-revision-diff-1280.png` verifies that the file rail, code pane, status, and
  approval controls remain visible at the narrower breakpoint. Long file paths truncate only in the
  rail; the selected path remains visible in the Diff header.

**Interactions and diagnostics**

- Verified Knowledge bases → Revision tasks → View changes.
- Verified switching between an edited file and a newly added file updates the Diff and statistics.
- Verified Approve and Reject are available only inside the review result for a pending-review task.
- Verified running tasks remain non-navigable until a change set exists.
- Browser console contained no errors in the list or both Diff file states.
- Base file content is now captured authoritatively with the generated change set so future reviews
  show real deletions and modifications; older tasks without captured base content fail visibly rather
  than fabricating a Diff.

**Comparison history**

1. The previous implementation had a P2 density issue: five persistent horizontal dividers and
   list-level approval controls made a two-task screen feel like a dense admin table.
2. Removed persistent row dividers and inline result expansion, moved approval behind View changes,
   and added a dedicated two-pane Diff review.
3. Equal-size list comparison plus 1688px and 1280px Diff captures found no remaining actionable
   P0/P1/P2 issue.

**Follow-up Polish**

- P3: when task URLs become shareable, preserve the selected file in the route so reviewers can link
  directly to one changed document.

final result: passed

---

# Home Expert Constellation Design QA

- Source visual truth: `design-qa/home-constellation-reference.png`
  - Original generated result:
    `/Users/linminqiu/.codex/generated_images/019fb3af-94fb-7af0-b04c-4976588bc971/call_dCs8pTzGeOZOqqrZshMEG6Jj.png`
- Implementation screenshot: `design-qa/home-constellation-resting.png`
- Combined comparison: `design-qa/home-constellation-comparison.png`
- Focused-state evidence: `design-qa/home-constellation-focused.png` and
  `design-qa/home-constellation-tooltip.png`
- Viewport: 1440 × 900 CSS pixels at DPR 2
- Density normalization:
  - Source: 1586 × 992 pixels, normalized to 1440 × 900.
  - Implementation: 2880 × 1800 pixels, normalized to 1440 × 900 for comparison.
- State: Home with the navigation rail collapsed, an empty Mission composer, the default workspace,
  and the resting expert constellation.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography preserve the existing Inter/SF Pro stack, weight hierarchy, line height, and
  antialiasing. The constellation status and expert-node labels remain subordinate to the Home
  heading and composer.
- Spacing and layout rhythm keep the existing 900px-wide, 380px-tall Mission composer unchanged.
  The constellation occupies the unused upper field, leaves the centered title unobstructed, and
  does not introduce another panel or card.
- Colors and visual tokens reuse the existing graphite, sage, lime, border, focus, and shadow
  tokens. The lines and nodes are intentionally low-opacity in the resting state and fade further
  when the composer receives focus.
- Image and asset fidelity: the constellation is an interactive canvas layer, while the three
  discoverable expert nodes use the existing Phosphor icon library. The implementation preserves
  the current Pragma application icon instead of replacing it with the generated reference's older
  letter mark.
- Copy and content use localized strings for English, Simplified Chinese, and Traditional Chinese.
  Existing product-real Home copy, workspace data, and executor/model controls remain unchanged.

**Full-view comparison evidence**

- The normalized source and implementation were opened together in
  `design-qa/home-constellation-comparison.png`.
- Both retain the collapsed application rail, centered Home heading, single dominant composer,
  sparse two-sided node graph, central ready status, and generous lower whitespace.
- The implementation intentionally preserves the current product shell, brand asset, placeholder,
  and resolved model controls instead of copying stale generated content.

**Focused region comparison evidence**

- `design-qa/home-constellation-tooltip.png` verifies that clicking a special node reveals one
  compact expert label without shifting layout or covering the Mission composer.
- `design-qa/home-constellation-focused.png` verifies that composer focus dims the complete ambient
  layer while keeping the focus boundary and form controls dominant.

**Interactions and diagnostics**

- Verified cursor-proximity response, slow resting drift, occasional node pulse, special-node click
  disclosure, composer-focus fade, and localized ready copy in the running Electron app.
- Verified `prefers-reduced-motion: reduce`: node drift and pointer displacement stop, and the
  status-dot CSS animation resolves to `none`.
- Submit sequencing is driven only by the existing `saving` state; static component coverage
  verifies the `is-submitting` state and localized orchestrating copy without creating a persisted
  Mission during QA.
- Browser viewport remained 1440 × 900 with a 2704 × 1800 canvas backing store for the 1352 × 900
  Home content region at DPR 2.
- Renderer console and runtime exception collection reported no errors or warnings.
- Desktop lint and node/web typechecks passed. The focused Home test file passed 13/13 tests.

**Comparison history**

- Pass 1: found a P2 vertical-composition mismatch: the ready status sat about 22px above the source,
  and the constellation was too shallow and slightly too strong.
- Fix: moved the ready status to 14.5% of the Home viewport, extended the node distribution
  vertically, and reduced resting line/node opacity.
- Pass 2: the revised resting capture aligned the status and graph field with the selected concept;
  no actionable P0, P1, or P2 differences remained.

**Follow-up Polish**

- P3: tune the exact drift amplitude after observing the animation during longer real-world use if
  it feels too quiet or too active. The current values stay within a 1.4–3px range.

final result: passed

---

# Home Mission Composer Design QA

- Source visual truth: `/tmp/codex-remote-attachments/019f7d75-4f4a-7cb1-98eb-f65af5988432/67a59236-a701-44f9-82f8-036d2bd3b341/1-Photo-1.jpg`
- Implementation screenshots: `design-qa/home-default-workspace.png`,
  `design-qa/home-workspace-menu-focus.png`, and `design-qa/home-keyboard-focus.png`
- Combined comparison: `design-qa/home-reference-comparison.png`
- Viewport: 1440 × 900 at DPR 2; the annotated reference is 1280 × 660
- State: Home with the built-in Pragma Agent, built-in default workspace, and an intentionally disabled
  submit action because the goal is empty

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- The implementation preserves the product shell while matching the reference's centered heading,
  single bordered composer, workspace row, large borderless prompt area, compact option footer, and
  arrow submit action.
- Workspace selection is explicitly optional. The default path is visible without dominating the
  row, and the expanded menu distinguishes the persistent default from a one-Mission override.
- Expert selection defaults to the built-in Pragma Agent. Expert and ExpertTeam states expose only model
  and thinking-depth overrides; Runtime is not presented on Home. Flow states omit both controls.
- Existing typography, Phosphor icons, graphite/sage tokens, radii, and surface shadows are reused.
  No raster or generated product assets were introduced.

**Full-view comparison evidence**

- The source and actual Electron implementation were opened together in
  `home-reference-comparison.png`.
- The implementation keeps the Desktop navigation rail, then centers the reference composition in
  the remaining content viewport. Composer proportions, row order, whitespace, and action placement
  follow the supplied reference.
- The implementation adds the resolved default workspace path and product-real permission choices;
  these are functional content additions, not alternative visual structure.

**Focused region comparison evidence**

- `home-workspace-menu-focus.png` verifies the workspace menu, selected default state, and the
  one-Mission folder override description without clipping.
- `home-keyboard-focus.png` verifies a single visible focus boundary around the composite input. An
  initial nested focus shadow on the workspace trigger was removed during this QA pass.

**Interactions and diagnostics**

- Verified keyboard traversal from the application rail into the workspace trigger and prompt,
  prompt focus styling, workspace menu open/close, selected-default indication, and disabled submit
  state.
- Desktop tests cover Home executor/model state and the Mission creation contracts. Runtime IDs are
  rejected by the strict model-override schema and cannot be submitted by Home.
- The local Electron run reported that the existing model-provider configuration uses an older
  format. Home handled this by disabling model overrides and showing the executor-default fallback;
  the stored user configuration was not changed for QA.

**Comparison history**

- Pass 1: found a nested keyboard focus shadow on the workspace trigger.
- Pass 2: removed the inner shadow, added the correctly scoped outer `:focus-within` state, and
  verified normal, expanded-menu, and keyboard-focus screenshots.

**Follow-up Polish**

- P3: recapture the ordinary state after the local model-provider configuration is reconfigured if
  a populated model dropdown screenshot is desired. The invalid-config fallback is already covered.

final result: passed

---

# Missions v1 Design QA

- Source visual truth: `/Users/linminqiu/.codex/generated_images/019f5139-fbcc-75e0-8165-8c56a2bb5552/exec-aa9b2bf8-e19b-4550-b6a0-67e44aa856d7.png`
- Implementation screenshot: `design-qa/mission-create-1440x900.png`
- Viewport: 1440 × 900
- State: Missions / New mission, empty mission list, no configured experts in browser preview

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- The selected visual uses populated team data and an enabled `Start mission` action. The v1 implementation intentionally shows an empty list, single-Expert selector, disabled `Create mission` action, and no team description because execution and Expert Teams are outside the approved scope.
- Fonts and typography: the implementation uses the existing Inter/SF Pro fallback stack and preserves the source hierarchy, weights, line height, truncation, and antialiasing.
- Spacing and layout rhythm: the two navigation rails, main heading, selector row, composer, dividers, and whitespace follow the selected composition without clipping or horizontal page overflow at the captured viewport.
- Colors and visual tokens: existing Pragma background, surface, border, graphite, sage, and lime tokens match the source direction; disabled state contrast remains legible.
- Image quality and asset fidelity: the screen contains no raster content. All interface icons use the existing Phosphor icon library; the Pragma wordmark and letter mark remain the existing code-native product branding.
- Copy and content: v1 wording accurately communicates creation without implying that Directive execution is available.

**Full-view comparison evidence**

- The source visual and browser-rendered implementation were opened together in the same comparison input.
- Main content starts on the same absolute rail boundary and preserves the source's form-first hierarchy.
- The implementation intentionally omits team-only information rather than leaving placeholder team controls visible.

**Focused region comparison evidence**

- A separate crop was not required: the full 1440 × 900 capture renders all labels, icons, selectors, dividers, and composer controls at readable size, and there are no imagery or dense data regions requiring magnification.

**Interactions and diagnostics**

- Tested Missions navigation, New mission reset, search input and disabled create validation.
- Browser console checked with no errors or warnings.
- Unit tests separately cover single-Expert versus Expert Team conditional detail layout.

**Comparison history**

- Pass 1: no P0/P1/P2 mismatch found; no visual fix iteration was required.

**Follow-up Polish**

- P3: capture a populated Electron-only Mission detail state after the future Execution continuation work enables real execution data.

final result: passed

---

# Studio Scroll Frame Design QA

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-78471d85-e8a6-4913-939d-f26a94c0a427.png`
- Implementation screenshot: `design-qa/studio-scroll-1440x900.png`
- Viewport: 1440 × 900; minimum-size verification at 1080 × 700
- State: Studio / Create expert, content viewport scrolled to `scrollTop=226`

**Findings**

- No actionable P0, P1, or P2 differences remain for the requested scrolling framework.
- The source uses a populated Plugin detail screen to mark the intended boundary. The browser-rendered verification uses Create expert because Electron preload data is unavailable in a plain browser preview; the comparison therefore evaluates the shared shell, fixed navigation/title geometry, and independent content viewport rather than fixture copy.
- Fonts and typography: the existing Inter/SF Pro stack, hierarchy, weights, wrapping, and antialiasing are unchanged.
- Spacing and layout rhythm: the application shell and Studio page remain 900px tall with hidden outer overflow; the fixed title occupies `top=50..152`, and the body owns the remaining `686px` scroll viewport. Scrolling moved only the body from `scrollTop=0` to `226`; the application sidebar, Studio navigation, and title stayed at their original coordinates.
- Colors and visual tokens: the existing Pragma graphite, sage, surface, border, focus, and shadow tokens are unchanged.
- Image quality and assets: no new raster assets were required. Existing Phosphor interface icons and the code-native Pragma branding remain intact.
- Copy and content: existing page labels, descriptions, actions, form fields, and resource content are unchanged.

**Full-view comparison evidence**

- The source and implementation were opened together in the same comparison input.
- Both retain the fixed application rail and Studio section rail while assigning the remaining main-column area to page-specific content.
- The implemented frame makes the page title persistent and constrains scrolling below it; detail pages use the source boundary by keeping only the `Back to …` row fixed and placing the entity title inside the scrolling body.

**Focused region comparison evidence**

- A separate crop was unnecessary: both full views show the complete navigation rails, title boundary, body origin, and lower content clipping at readable scale.

**Interactions and diagnostics**

- Tested Experts directory, Create expert scrolling, Capabilities directory, Plugins directory, and Context stores directory in the browser preview.
- Verified the shared directory/detail/editor frame structurally for Experts, Expert teams, Flows, Capabilities, Plugins, and Context stores; Flow Editor retains its own fixed toolbar and internal panel scrolling.
- At 1080 × 700, document dimensions stayed exactly 1080 × 700 with no page-level horizontal or vertical overflow; the content body remained independently scrollable.
- Browser console checked with no errors or warnings.

**Comparison history**

- Pass 1: no P0/P1/P2 issue found. Scroll metrics and the scrolled screenshot confirmed that only the content viewport moves.

**Follow-up Polish**

- None required for this change.

final result: passed

---

# Current Design QA Gate

- Current report: Evaluation Secondary Navigation Design QA at the top of this file.
- The implementation screenshot and combined comparison remain unavailable because local preview
  navigation was rejected by the selected in-app browser's URL security policy.

final result: blocked
