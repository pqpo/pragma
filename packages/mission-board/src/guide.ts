export const MISSION_BOARD_GUIDE_ID = "GUIDE.md";

export const MISSION_BOARD_GUIDE = `# Mission Board

This is a persistent whiteboard scoped to the current Mission. Use the existing Context tools to list, read, search, add, edit, and delete items.

## Conventions

- \`plan.md\`: the current plan and phases.
- \`todos.md\`: actionable work, owners, and completion state.
- \`progress.md\`: concise checkpoints useful across restarts.
- \`decisions.md\`: durable decisions and their rationale.
- \`handoffs/<topic>.md\`: context another Expert needs to continue work.
- \`system/outputs/\`: Runtime-managed large invocation outputs. Do not edit these unless explicitly required.

These paths are conventions, not special data types. Create only the items useful to the Mission.

Use \`mission-board\` for information that every Expert in the Mission may read. Use \`mission-board-private\` for notes that must remain isolated to the current Runtime Context. Private content must not be copied to shared items, handoffs, Memory, or exports without an explicit decision to broaden visibility.

For edits, read the item first and pass its revision or etag as the expected value. On a conflict, read the latest item, reconcile, and retry. Keep entries concise and update existing entries instead of creating duplicate status documents.

Workspace artifacts remain workspace paths. Record a controlled relative path on the board when another Expert needs the artifact; the board does not copy workspace files.
`;
