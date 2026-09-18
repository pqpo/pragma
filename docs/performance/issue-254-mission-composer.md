# Issue 254 Mission Composer performance record

Date: 2026-09-18

## Method

Run:

```bash
pnpm --filter @pragma/desktop benchmark:composer
```

The benchmark bundles React and the real `MissionChatComposer` with
`process.env.NODE_ENV="production"`, then runs it in Electron Chromium with background throttling
disabled. Each data point contains 40 fixed-length controlled-input updates and waits for two
animation frames so the sample includes the next paint opportunity.

Two modes use the same production bundle and message DOM:

- `coupled`: controlled draft state lives beside the conversation, modeling the pre-fix ownership
  boundary. Each input rerenders the page and walks the loaded conversation tree.
- `isolated`: the real post-fix `MissionChatComposer` owns draft state. The conversation is a
  sibling and must not receive an input-driven page render.

This is a controlled architecture comparison, not a flamegraph captured from a user's historical
Desktop session. It intentionally does not claim that the modeled `coupled` result is an exact
replay of `main@c3c99a27`.

## Environment

- macOS/Darwin 25.6.0, x64
- Intel Core i7-9750H 2.60 GHz, 12 logical CPUs
- 16 GiB RAM
- Electron 43.2.0 / Chromium 150.0.7871.129
- Offscreen Chromium window, 1200 × 900, background throttling disabled

## Results

| Loaded blocks | Mode     | input→paint p50 | input→paint p95 | ≥50 ms samples | Long tasks | Page renders | Conversation mutations | Layout reads / total time |
| ------------: | -------- | --------------: | --------------: | -------------: | ---------: | -----------: | ---------------------: | ------------------------: |
|           100 | coupled  |         33.3 ms |         34.4 ms |              0 |          0 |           41 |                      0 |              40 / 13.1 ms |
|           100 | isolated |         33.3 ms |         34.9 ms |              0 |          0 |            1 |                      0 |               40 / 8.0 ms |
|         1,000 | coupled  |         33.3 ms |         34.5 ms |              0 |          0 |           41 |                      0 |              40 / 10.7 ms |
|         1,000 | isolated |         33.1 ms |         34.6 ms |              0 |          0 |            1 |                      0 |              40 / 13.9 ms |
|         5,000 | coupled  |         33.3 ms |         35.2 ms |              0 |          0 |           41 |                      0 |               40 / 8.1 ms |
|         5,000 | isolated |         33.3 ms |         34.1 ms |              0 |          0 |            1 |                      0 |               40 / 5.5 ms |

The two-frame sampling floor dominates latency on this machine, so the important regression signal
is structural: isolated input produces one initial page render and zero conversation mutations at
all three scales, while the coupled model renders the page 41 times. Long-task observation starts
after initial list construction, so initial-load cost is not mixed into input measurements.

The Composer performs one scheduled height read per committed input. The total layout-read timing
is diagnostic rather than a stable cross-machine threshold; the regression guard is the fixed
one-read-per-input count and the absence of conversation work.

## Draft durability boundary

Draft writes are debounced by 400 ms and stored under a per-Mission key. Mission switches,
`pagehide`, normal component disposal, and normal application exit flush the pending text draft.
Send and explicit clear cancel the pending write before storing an empty migration tombstone, so a
late timer cannot resurrect submitted text. Completing or deleting a Mission physically removes
both its v2 key and any legacy v1 entry.

A renderer or process crash can still lose at most the unflushed debounce window; browser storage
does not provide a synchronous crash-commit guarantee. Staged attachments are process-owned: they
are transferred between mounted Mission composers in memory and are discarded on page/application
exit when no live Composer can own them. Recovery snapshots are capped at eight inactive Missions;
eviction releases their staged attachments. A late failed send may restore only into an empty
Composer. If the user has already entered a newer draft, that input wins and the older staged
attachments are released instead of overwriting the active Composer.
