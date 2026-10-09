# Mission operations

- `pragma manage mission list`: filter by statuses, executorRef, updatedAfter or query; follow
  nextCursor with unchanged filters. `get` takes missionId and returns the Mission summary/goal.
- `create`: pass goal, exact executorRef, absolute workspaceId and optional contextStoreIds.
  Use ready knowledge store IDs, not DSL ContextStore refs. The result identifies the created Mission
  and execution; use that identity for subsequent queries, not a guessed name. Creation starts work.
- `work list`: pass missionId and optional kinds/statuses/query. `work get` takes missionId and
  workItemId from that page; task details are distinct from raw execution events.
- `send`: pass missionId and content after the user requests that follow-up. It uses the existing
  Mission admission/queue mechanism. Inspect the actual result; accepted input may be queued.
- `interrupt`: pass missionId. Interruption keeps history and does not delete the Mission.

Example: save this JSON to a workspace file, then invoke
`pragma manage mission create --input request.json --format json`:

```json
{
  "goal": "Review the release notes",
  "executorRef": "expert:1h2j3k4m5n6p7q8r",
  "workspaceId": "/absolute/workspace"
}
```

Do not manufacture refs, target IDs or controller state. Resolve target/revision conflicts by
reading current state before a new request. Keep the same request UUID when retrieving an
uncertain result; a new UUID can create a second Mission. The older user CLI commands such as
`pragma mission watch` are separate user entrypoints; do not use them to bypass Execution grants.
