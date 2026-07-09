---
name: claude-code-review
description: Delegate code review of current uncommitted repository changes to Claude Code with `claude -p`, wait up to 10 minutes, then independently verify each finding and fix real issues. Use when the user asks to have Claude Code review a diff, audit uncommitted changes, perform CR/code review, or turn Claude Code review feedback into verified fixes.
---

# Claude Code Review

## Workflow

1. Inspect the local change scope before invoking Claude Code:
   - Run `git status --short`.
   - Run `git diff --stat`.
   - Run `git diff --name-only`.
   - Note untracked files that are relevant to the review.

2. Ask Claude Code to review the current uncommitted changes. The prompt must tell Claude Code:
   - Read the repository context and all uncommitted changes, including untracked files.
   - Do not modify files.
   - Focus on real bugs, behavior regressions, boundary violations, security issues, type/test gaps, project instruction conflicts, and architectural or design problems that the current change surface exposes.
   - Return findings with file path, location, why it is a problem, and suggested fix.
   - Avoid generic advice and unsupported speculation.

3. Run `claude -p` with a 10 minute timeout. On macOS, prefer a shell loop because `timeout` may not exist:

```bash
PROMPT=$(cat <<'EOF'
You are a senior TypeScript/Node.js code reviewer. Review all current uncommitted changes in this repository, including git diff and untracked files. Read the relevant repository context and project instructions. Do not modify files.

Use the current diff as the entry point, but do not limit yourself to only regressions introduced by this edit. If the change surface reveals a real problem in the same code path, abstraction, or boundary, call it out even if it predates the current diff.

Return:
1. Findings ordered by severity, each with file path, line or code location, issue description, why it can fail, and suggested fix.
2. If there are no real blocking issues, say so explicitly.
3. Do not include generic suggestions or issues without evidence.
EOF
)
claude -p "$PROMPT" &
pid=$!
end=$((SECONDS + 600))
while kill -0 "$pid" 2>/dev/null; do
  if [ "$SECONDS" -ge "$end" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    echo "CLAUDE_REVIEW_TIMEOUT_AFTER_600_SECONDS"
    exit 124
  fi
  sleep 5
done
wait "$pid"
```

4. While Claude Code runs, wait for completion unless it exceeds 10 minutes. Do not interrupt early just because it is slow.

5. After Claude Code returns, independently verify each finding:
   - Read the referenced code and surrounding tests.
   - Decide whether the finding is a real issue, a deliberate project decision, a harmless cleanup suggestion, or a false positive.
   - Use architecture rationality, simplicity, and long-term maintainability as part of the verification standard, not only narrow regression analysis.
   - Fix all real issues.
   - Do not fix false positives or broad style preferences unless they uncover a concrete defect, dead capability, misleading API surface, or unnecessary structural complexity.

6. When deciding fix scope:
   - Prefer removing dead abstractions, no-op configuration, migration leftovers, or misleading API surface rather than preserving them.
   - If a finding points to a wider but clearly bounded problem in the same subsystem, fix the whole problem instead of applying the smallest local patch.
   - Keep the solution aligned with repository architecture rules and avoid speculative refactors outside the affected area.

7. After edits, run validation scaled to the touched surface:
   - Run focused tests for directly affected packages/files first.
   - Run `pnpm check` for repository-wide lint, typecheck, and tests.
   - Run `pnpm build` if package exports, app entry points, runtime loading, or build-sensitive files changed.

8. Summarize:
   - Whether Claude Code completed or timed out.
   - Which findings were accepted and fixed.
   - Which findings were rejected and why.
   - Whether any accepted fixes went beyond the immediate diff and why that broader scope was justified.
   - Validation commands and results.

## Guardrails

- Never let Claude Code modify files during the review pass.
- Never blindly apply Claude Code findings; verify them against the codebase first.
- Preserve unrelated dirty worktree changes.
- If a finding conflicts with project instructions such as `AGENTS.md`, prefer the project instructions and explain the decision.
- Favor correctness, clarity, and durable architecture over preserving questionable existing structure.
- If `claude` is unavailable, report the blocker and do not fabricate a Claude Code review.
