# ExpertTeam resources

Use an ExpertTeam when one coordinator delegates to an allowlisted set of Experts.

```yaml
apiVersion: pragma/v2
kind: ExpertTeam
metadata:
  id: delivery
  version: 1.0.0
  name: Delivery Team
  description: Coordinates implementation and review.
  tags: [delivery]
spec:
  coordinator:
    ref: expert:lead@1.0.0
  members:
    - ref: expert:implementer@1.0.0
    - ref: expert:reviewer@1.0.0
  instructions: >-
    Collaborate openly, surface uncertainty early, and do not report completion until the work
    satisfies the team's quality requirements.
  delegation:
    allow:
      lead: [implementer, reviewer]
    maxConcurrency: 2
    maxDepth: 2
    context: context-policy:pragma.fresh@v1
    runtimes: {}
```

- The coordinator and every member must already exist or be included in the same change-set.
- `instructions` is optional. When present, it is loaded into the coordinator and every delegated
  member as an always-on `TEAM.md` Context System document. Use it for shared collaboration
  principles, quality requirements, and working agreements rather than role-specific behavior.
- `allow` keys and values use Expert IDs, not canonical refs.
- Keep concurrency and depth bounded. Do not use a Team when a deterministic Flow is sufficient.
