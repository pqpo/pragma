## Problem

<!-- What user, product, or architecture problem does this change solve? -->

## Solution

<!-- Summarize the approach and important alternatives considered. -->

## Verification

<!-- List exact commands, tests, and manual checks performed. -->

- [ ] Relevant tests added or updated
- [ ] `pnpm check`
- [ ] `pnpm build` when package exports or application entry points changed

- [ ] `pnpm test:revision` for knowledge revision changes
- [ ] Critical Runtime paths include a real Runtime smoke record (entry point, target, write, and review result)

## Impact

<!-- Check and explain every applicable item. -->

- [ ] Breaking API, protocol, or DSL change
- [ ] Persistent schema or migration change
- [ ] Security, permission, credential, or privacy impact
- [ ] Runtime Adapter or plugin compatibility impact
- [ ] Documentation or ADR update required

## Existing behavior

<!-- Identify removed entry points, narrowed support, or success assertions changed to failures, with the explicit requirement authorizing each change. Bug fixes must preserve existing supported behavior. Recovery changes must test healthy first use as well as damaged state. -->

## Checklist

- [ ] I read `AGENTS.md` and kept the change within the allowed package boundaries.
- [ ] I did not include secrets, private user data, or generated build output.
- [ ] I documented known limitations and follow-up work.
- [ ] I followed the Code of Conduct and contribution guidelines.
