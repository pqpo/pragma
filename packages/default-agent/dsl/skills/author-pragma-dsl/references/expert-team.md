# ExpertTeam resources

Use an ExpertTeam when one coordinator delegates to an allowlisted set of Experts.

```yaml
apiVersion: pragma/v3
kind: ExpertTeam
metadata:
  id: 4h5j6k7m8n9p0q1r
  name: Delivery Team
  description: Coordinates implementation and review.
  tags: [delivery]
spec:
  coordinator:
    ref: expert:5h6j7k8m9n0p1q2r
  members:
    - ref: expert:6h7j8k9m0n1p2q3r
    - ref: expert:7h8j9k0m1n2p3q4r
  instructions: >-
    Collaborate openly, surface uncertainty early, and do not report completion until the work
    satisfies the team's quality requirements.
  delegation:
    allow:
      5h6j7k8m9n0p1q2r: [6h7j8k9m0n1p2q3r, 7h8j9k0m1n2p3q4r]
    maxConcurrency: 2
    maxDepth: 2
    context: context-policy:pragma.fresh@v1
    runtimes: {}
```

- The coordinator and every member must already exist or be included in the same change-set.
- Text limits use Unicode characters after trimming: name 50, description 500, and optional team
  instructions 5,000.
- `instructions` is optional. When present, it is loaded into the coordinator and every delegated
  member as an always-on `TEAM.md` Context System document. Use it for shared collaboration
  principles, quality requirements, and working agreements rather than role-specific behavior.
- `allow` keys and values use Expert IDs, not canonical refs.
- Keep concurrency and depth bounded. Do not use a Team when a deterministic Flow is sufficient.
