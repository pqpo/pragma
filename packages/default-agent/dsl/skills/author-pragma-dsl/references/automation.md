# Automation resources

Use an Automation to connect an Expert, ExpertTeam, or Flow to an external trigger. Schedule is the
built-in trigger adapter; webhook and conversation adapters can use the same resource boundary later.

```yaml
apiVersion: pragma/v2
kind: Automation
metadata:
  id: daily_release_summary
  version: 1.0.0
  name: Daily release summary
  description: Ask the release writer for a summary every weekday morning.
  tags: [integration, schedule]
spec:
  adapter: pragma.automation.schedule@v1
  binding: binding:desktop-automation
  config:
    trigger:
      kind: calendar
      frequency: weekdays
      time: "09:00"
      timezone: Asia/Shanghai
  enabled: true
  route:
    executor:
      ref: expert:release_writer@1.0.0
    input:
      kind: prompt
      value: Prepare today's release summary from verified changes.
  interaction:
    mode: reuse-session
  delivery:
    adapter: pragma.automation.delivery.local@v1
```

Schedule trigger forms:

- `once`: `at` is an ISO timestamp with an offset.
- `interval`: positive `every`, a `unit` of `minutes`, `hours`, `days`, or `weeks`, and an offset
  timestamp `anchorAt`.
- `calendar`: `daily`, `weekdays`, `weekly`, or `monthly`, with a 24-hour `time` and IANA
  `timezone`. Weekly rules include `weekdays`; monthly rules include `dayOfMonth`.
- `cron`: a five-field `expression` plus an IANA `timezone`.
- Interval, calendar, and Cron may include a `window` with offset timestamps `startsAt` and/or
  `endsAt`.

Mission continuity:

- Expert and ExpertTeam default to `reuse-session`; events for one Automation are processed FIFO
  in one Mission. A pending human or tool approval blocks later events.
- `new-mission` creates an independent Mission for every event and permits concurrent execution.
- Flow always requires `new-mission` and structured `route.input.kind: flow`.
- Deleting the Automation does not delete Missions. Reset continuity only when the user explicitly
  wants the next event to start a fresh Mission.

The workspace, tool permission mode, model override, credentials, and future IM connection secrets
are host bindings. Never place them in DSL. Call `save_automation` with an explicit `workspaceId` and
`toolPermissionMode`; do not use generic `commit_dsl_changes` for an Automation.
