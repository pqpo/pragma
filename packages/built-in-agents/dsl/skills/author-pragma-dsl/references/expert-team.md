# ExpertTeam resources

Use an ExpertTeam when one coordinator governs collaboration among a bounded set of Experts.

```yaml
apiVersion: pragma/v5
kind: ExpertTeam
metadata:
  id: 4h5j6k7m8n9p0q1r
  avatarId: pragma.avatar.team.default
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
  contextStores:
    - ref: context-store:8h9j0k1m2n3p4q5r
      namespace: team_delivery_handbook
      required: true
      visibility:
        mode: whitelist
        expertIds: [5h6j7k8m9n0p1q2r, 6h7j8k9m0n1p2q3r]
  delegation:
    permissions:
      spawn:
        6h7j8k9m0n1p2q3r: [7h8j9k0m1n2p3q4r]
      interact:
        6h7j8k9m0n1p2q3r: [7h8j9k0m1n2p3q4r]
    maxConcurrency: 2
    maxDepth: 2
    runtimes: {}
```

- The coordinator and every member must already exist or be included in the same change-set.
- `avatarId` remains part of the `pragma/v5` portable resource protocol. Desktop displays the
  coordinator's current Expert avatar and adds the Team badge in the UI.
- Text limits use Unicode characters after trimming: name 50, description 500, and optional team
  instructions 5,000.
- `instructions` is optional. When present, it is loaded into the coordinator and every delegated
  member as an always-on `TEAM.md` Context System document. Use it for shared collaboration
  principles, quality requirements, and working agreements rather than role-specific behavior.
- `contextStores` mounts knowledge only while Experts run through this Team. Each namespace and
  ContextStore ref must be unique. Visibility defaults to `all`; `blacklist` excludes the listed
  Expert IDs and `whitelist` includes only the listed IDs. Lists may reference only the coordinator
  or members, and every store must remain visible to at least one participant. Team visibility does
  not revoke an Expert's independent mount of the same ContextStore.
- Permission keys and values use Expert IDs, not canonical refs. `spawn` creates fresh Runtime
  Contexts; `interact` continues or steers existing Contexts without granting spawn or interrupt.
- The coordinator has system-inherited authority within the Team Session: it can spawn every member,
  discover current and historical member Contexts, continue or steer them, and interrupt work.
  Coordinator entries in `permissions` are forbidden; the maps govern member-to-member permissions
  only.
- Keep concurrency and depth bounded. Do not use a Team when a deterministic Flow is sufficient.
