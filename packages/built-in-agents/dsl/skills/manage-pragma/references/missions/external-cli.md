# External public CLI workflows

Use this reference only when the user requests public CLI automation and the shell action is authorized.
Inside the current Execution, keep using `pragma manage` and its grants. The public CLI does not grant
permission to bypass that channel or approve a HumanTask.

- Find tasks with `pragma mission list --query TEXT --workspace CANONICAL_PATH`; keep all filters when
  following nextCursor. CURSOR_EXPIRED means refresh the list, not edit or shorten the cursor.
- `mission get --view summary|result` includes the title in semantic v2. `--recent-input` is the latest
  durable input and may still be queued. Check the execution/queue state before deciding what ran.
- Set `--interactive never`; choose `--json --output-view compact` or `--format jsonl --output-view compact`.
  CLI v3 command status and the Mission result status are separate. Complete results appear once.
- `--wait-timeout SECONDS` bounds waiting after a durable receipt. Expiry returns accepted/exit 0 and
  waitExpired, preserving the task and continuation. Reuse the request UUID for an identical retry.
  Explicit interrupt is cancellation. Do not terminate an owner process to simulate stopping a watcher.
- input_required includes interaction identity, questions, options and submission values. Use the
  actual response format; `--answers-json` is the complete response object. Existing question text is
  the answers key. Never invent question IDs or approve a choice without user authorization.
- A content reference is a preview plus a recovery address, not the final result. Follow its exact
  mission/source/id/fingerprint with `mission get --view content`, using nextStart as a byte offset.
  Concatenate JSON content in order; parse utf8-json only when complete. Changed content expires;
  consumed queue entries or removed content report NOT_FOUND.
- Read Board ranges with `--start BYTE --max-bytes BYTES`; --offset is the older size alias. Text
  exposes partial ranges, while JSON content is suitable for exact reconstruction.
- Use executor describe for required input and a template. Full complex Schema is available through
  `describe --json --output-view full`. Templates require replacing placeholders and validation.

Use exact IDs/refs from discovery, preserve receipts, and read the installed subcommand help.
