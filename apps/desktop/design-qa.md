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
