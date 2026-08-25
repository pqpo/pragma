# Expert Team Permissions Design QA

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-79a7228e-4e56-4bac-8167-1657c45b0921.png`
- Implementation screenshot: `/Users/linminqiu/.codex/visualizations/2026/08/23/01a02eb7-0fb4-7623-b6ad-f299795b5259/team-permissions-stacked.png`
- Picker screenshot: `/Users/linminqiu/.codex/visualizations/2026/08/23/01a02eb7-0fb4-7623-b6ad-f299795b5259/team-permissions-picker.png`
- Combined comparison: `/Users/linminqiu/.codex/visualizations/2026/08/23/01a02eb7-0fb4-7623-b6ad-f299795b5259/team-permissions-stacked-comparison.png`
- Viewport: 1280 × 720 CSS px, desktop light theme
- Pixels and density: source 2558 × 838 px; implementation 1280 × 720 px at device scale factor 1. The comparison normalizes each side into a 1280 × 720 panel without cropping.
- State: 10 team experts; the first non-coordinator member is active; eight delegation targets and ten collaboration targets are selected.

## Full-view comparison evidence

The source is the previous two-card implementation, not a pixel-fidelity target. Its permission cards sit side by side at the top of a 360 px detail region and leave roughly half the panel empty. The revised implementation stacks the two permissions, lets both rows fill the detail height, expands the visible target summary, and fixes the edit affordance to the right edge.

## Focused-region evidence

The picker screenshot verifies the reused expert picker at the same 1280 × 720 viewport. It shows selected states, long-list scrolling, the selected count, `全选`, `清除选择`, and the persistent completion action. Browser inspection confirmed that selecting all changes five selected delegation targets to all nine eligible targets and changes the bulk action to `清空全部`.

## Required fidelity surfaces

- Fonts and typography: existing app font stack, weights, sizes, line heights, and truncation rules are preserved. Member and permission summaries remain readable without wrapping the layout.
- Spacing and layout rhythm: the permission area is bounded, uses existing spacing and radius tokens, and keeps a stable member/detail composition. The two permission rows now fill the detail height and align with the 360 px member navigator.
- Colors and visual tokens: existing surface, border, muted text, green soft, green dark, focus ring, and hover tokens are reused.
- Image quality and assets: existing `ExpertAvatar` and Phosphor icons are used; no replacement or generated asset is required.
- Copy and content: ambiguous labels were replaced with `可委派给` and `可协作对象`; concise behavioral descriptions and a keyboard-focusable help tooltip explain their effects.

## Comparison history

1. Source findings: the complete permission matrix is unbounded for large teams; permission labels describe implementation actions poorly; there is no bulk selection path.
2. Fixes: replaced the matrix with member navigation plus two summaries, reused the expert picker for permission targets, added filtered-result select-all behavior, and added explanatory copy and help affordance.
3. Post-fix evidence: the 10-member focused screenshot has no page-level matrix growth or clipped permission controls; the picker screenshot shows bulk selection and selected-state clarity. No P0, P1, or P2 issue remains.
4. Follow-up finding: the two permission cards used only the top half of the right panel, while each summary exposed only three expert names.
5. Follow-up fix: stacked both permissions vertically, split each row into description, expanded summary, and right-aligned action regions, and raised the explicit summary limit from three to eight names.
6. Follow-up evidence: the latest screenshot shows both rows filling the right panel without overflow; the edit action is consistently right aligned, and the 8/10-target states remain readable. No P0, P1, or P2 issue remains.

## Interaction and console checks

- Switched from the 10-member list to the active member detail.
- Opened the delegation-target picker.
- Selected all nine eligible experts and verified the count and reverse action.
- Checked a 720 × 900 viewport; the desktop shell enforces its existing minimum content width, while the permission component switches to stacked cards within that constraint.
- Browser console errors and warnings: none in the QA harness.

## Follow-up polish

- P3: if the desktop product later lowers its global minimum window width, convert the member navigator breakpoint from viewport-based media rules to a container query.

final result: passed
