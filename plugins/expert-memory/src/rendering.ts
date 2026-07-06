import type { ExpertAgentStoredContextItem } from "@pragma/core";

import {
  RUNS_EVIDENCE_PREFIX,
  SESSIONS_EVIDENCE_PREFIX,
  SKILLS_PREFIX,
  MARKDOWN_EXTENSION,
  JSON_EXTENSION,
} from "./constants.ts";
import type { MemoryRunEvidence, MemorySessionEvidence } from "./schema.ts";
import {
  dedupeStrings,
  extractLastUpdatedSessions,
  extractSectionBullets,
  firstOrDefault,
  humanizeSkillId,
  renderBullets,
  sanitizeIdSegment,
  trimCharacters,
  trimUtf8,
} from "./utils.ts";

export function renderSummaryIndex(
  skills: readonly ExpertAgentStoredContextItem[],
  maxBytes: number,
): string {
  const sortedSkills = [...skills].sort((left, right) => left.id.localeCompare(right.id));
  const skillBullets = sortedSkills.map((skill) => `- ${humanizeSkillId(skill.id)} -> ${skill.id}`);
  const pitfalls = dedupeStrings(
    sortedSkills.flatMap((skill) => extractSectionBullets(skill.content, "Common Failure Modes")),
  );
  const approaches = dedupeStrings(
    sortedSkills.flatMap((skill) => extractSectionBullets(skill.content, "Recommended Approach")),
  );
  const recentLessons = dedupeStrings(
    sortedSkills.flatMap((skill) =>
      extractSectionBullets(skill.content, "Lessons Confirmed By Past Tasks"),
    ),
  );
  const content = [
    "# Memory Index",
    "",
    "## Memory Index",
    ...renderBullets(skillBullets, "No skill cards available yet."),
    "",
    "## Key Skills To Read First",
    ...renderBullets(skillBullets.slice(0, 5), "No prioritized skills yet."),
    "",
    "## Frequent Pitfalls",
    ...renderBullets(pitfalls.slice(0, 6), "No frequent pitfalls recorded."),
    "",
    "## Preferred Approaches",
    ...renderBullets(approaches.slice(0, 6), "No preferred approaches recorded."),
    "",
    "## Recently Reinforced Lessons",
    ...renderBullets(recentLessons.slice(0, 6), "No reinforced lessons recorded."),
    "",
  ].join("\n");

  return trimUtf8(content, maxBytes);
}

export function renderTaskSummary(evidence: MemoryRunEvidence): string {
  const successTools = evidence.tools
    .filter((tool) => tool.status === "completed")
    .map((tool) => `Used ${tool.toolName} successfully.`);
  const failedTools = evidence.tools
    .filter((tool) => tool.status === "failed")
    .map((tool) => `${tool.toolName} failed${tool.errorMessage === undefined ? "." : `: ${tool.errorMessage}`}`);
  const recommendedFixes = evidence.tools
    .filter((tool) => tool.status === "failed")
    .map((tool) => `When ${tool.toolName} fails, prefer the validated recovery path before retrying blindly.`);

  return [
    "# Task Summary",
    "",
    "## Task",
    evidence.query,
    "",
    "## Actions Taken",
    ...renderBullets(
      [
        ...successTools,
        ...failedTools,
        evidence.outputExcerpt === undefined ? undefined : "Captured the final output for future reuse.",
      ].filter((value): value is string => value !== undefined),
      "No significant actions were captured.",
    ),
    "",
    "## Result",
    summarizeRunResult(evidence),
    "",
    "## What Went Well",
    ...renderBullets(
      evidence.status === "succeeded"
        ? [
            "A usable final result was produced.",
            ...(successTools.length > 0 ? ["The successful path is now reusable."] : []),
          ]
        : ["The failure was captured clearly enough to learn from it."],
      "No positive outcomes were identified.",
    ),
    "",
    "## What Went Poorly",
    ...renderBullets(
      failedTools.length > 0 ? failedTools : ["No major problems were captured."],
      "No major problems were captured.",
    ),
    "",
    "## Mistakes / False Paths",
    ...renderBullets(
      failedTools.length > 0 ? failedTools : ["No clear false path was recorded."],
      "No clear false path was recorded.",
    ),
    "",
    "## Lessons Learned",
    ...renderBullets(
      evidence.lessons.length > 0 ? evidence.lessons : deriveLessonsFromEvidence(evidence),
      "No reusable lesson was extracted.",
    ),
    "",
    "## Recommended Fix Next Time",
    ...renderBullets(
      recommendedFixes.length > 0 ? recommendedFixes : deriveDefaultFixes(evidence),
      "Reuse the validated path from this task before trying broad retries.",
    ),
    "",
    "## Evidence References",
    ...renderBullets(
      [
        `${RUNS_EVIDENCE_PREFIX}${evidence.runId}${JSON_EXTENSION}`,
        `session:${evidence.sessionId}`,
        ...(evidence.runtimeSessionId === undefined
          ? []
          : [`runtime-session:${evidence.runtimeSessionId}`]),
      ],
      "No evidence references recorded.",
    ),
    "",
  ].join("\n");
}

export function renderSessionSummary(
  sessionEvidence: MemorySessionEvidence,
  runEvidence: readonly MemoryRunEvidence[],
): string {
  const successfulPatterns = dedupeStrings(
    runEvidence.flatMap((run) =>
      run.tools
        .filter((tool) => tool.status === "completed")
        .map((tool) => `Use ${tool.toolName} on similar tasks.`),
    ),
  );
  const repeatedMistakes = dedupeStrings(
    runEvidence.flatMap((run) =>
      run.tools
        .filter((tool) => tool.status === "failed")
        .map((tool) => `${tool.toolName} was a repeated failure path.`),
    ),
  );
  const candidateUpdates = dedupeStrings(
    runEvidence.flatMap((run) => deriveLessonsFromEvidence(run)),
  );

  return [
    "# Session Summary",
    "",
    "## Session Goal",
    summarizeSessionGoal(runEvidence),
    "",
    "## Tasks Completed",
    ...renderBullets(
      runEvidence.map((run) => `${run.runId}: ${summarizeRunResult(run)}`),
      "No task summaries were available.",
    ),
    "",
    "## Successful Patterns",
    ...renderBullets(successfulPatterns, "No stable successful pattern was identified."),
    "",
    "## Repeated Mistakes",
    ...renderBullets(repeatedMistakes, "No repeated mistake was identified."),
    "",
    "## Important Failures And Recovery Paths",
    ...renderBullets(
      runEvidence
        .filter((run) => run.status !== "succeeded" || run.tools.some((tool) => tool.status === "failed"))
        .map((run) => formatFailureAndRecovery(run)),
      "No important failure or recovery path was captured.",
    ),
    "",
    "## Reusable Lessons",
    ...renderBullets(candidateUpdates, "No reusable lesson was extracted."),
    "",
    "## Candidate Skill Updates",
    ...renderBullets(
      candidateUpdates.map((lesson) => `${humanizeSkillId(deriveSkillId(runEvidence))}: ${lesson}`),
      "No skill update candidate was identified.",
    ),
    "",
    "## Evidence References",
    ...renderBullets(
      [
        `${SESSIONS_EVIDENCE_PREFIX}${sessionEvidence.sessionId}${JSON_EXTENSION}`,
        ...runEvidence.map((run) => `${RUNS_EVIDENCE_PREFIX}${run.runId}${JSON_EXTENSION}`),
      ],
      "No evidence references recorded.",
    ),
    "",
  ].join("\n");
}

export function mergeSkillContent(
  existingContent: string | undefined,
  sessionEvidence: MemorySessionEvidence,
  runEvidence: readonly MemoryRunEvidence[],
): string {
  const scope = humanizeSkillId(deriveSkillId(runEvidence));
  const recommendedApproach = dedupeStrings([
    ...extractSectionBullets(existingContent ?? "", "Recommended Approach"),
    ...runEvidence.flatMap((run) =>
      run.tools
        .filter((tool) => tool.status === "completed")
        .map((tool) => `Prefer ${tool.toolName} when solving this class of problem.`),
    ),
  ]);
  const failureModes = dedupeStrings([
    ...extractSectionBullets(existingContent ?? "", "Common Failure Modes"),
    ...runEvidence.flatMap((run) =>
      run.tools
        .filter((tool) => tool.status === "failed")
        .map((tool) => `${tool.toolName} can fail if retried without a clearer path.`),
    ),
  ]);
  const recovery = dedupeStrings([
    ...extractSectionBullets(existingContent ?? "", "Recovery Playbook"),
    ...runEvidence.flatMap((run) => deriveDefaultFixes(run)),
  ]);
  const goodPractices = dedupeStrings([
    ...extractSectionBullets(existingContent ?? "", "Good Practices"),
    ...runEvidence.flatMap((run) => derivePositivePractices(run)),
  ]);
  const antiPatterns = dedupeStrings([
    ...extractSectionBullets(existingContent ?? "", "Anti-Patterns"),
    ...runEvidence.flatMap((run) => deriveAntiPatterns(run)),
  ]);
  const lessons = dedupeStrings([
    ...extractSectionBullets(existingContent ?? "", "Lessons Confirmed By Past Tasks"),
    ...runEvidence.flatMap((run) => deriveLessonsFromEvidence(run)),
  ]);
  const sessions = dedupeStrings([
    sessionEvidence.sessionId,
    ...extractLastUpdatedSessions(existingContent),
  ]);

  return [
    "# Skill Card",
    "",
    "## Skill Scope",
    scope,
    "",
    "## When To Use",
    firstOrDefault(
      extractSectionBullets(existingContent ?? "", "When To Use"),
      `Use this skill when the task resembles: ${summarizeSessionGoal(runEvidence)}.`,
    ),
    "",
    "## Recommended Approach",
    ...renderBullets(recommendedApproach, "No recommended approach has been recorded yet."),
    "",
    "## Common Failure Modes",
    ...renderBullets(failureModes, "No common failure mode has been recorded yet."),
    "",
    "## Recovery Playbook",
    ...renderBullets(recovery, "No recovery playbook has been recorded yet."),
    "",
    "## Good Practices",
    ...renderBullets(goodPractices, "No good practice has been recorded yet."),
    "",
    "## Anti-Patterns",
    ...renderBullets(antiPatterns, "No anti-pattern has been recorded yet."),
    "",
    "## Lessons Confirmed By Past Tasks",
    ...renderBullets(lessons, "No confirmed lesson has been recorded yet."),
    "",
    "## Last Updated From Sessions",
    ...renderBullets(sessions, "No source session has been recorded yet."),
    "",
  ].join("\n");
}

export function summarizeRunResult(evidence: MemoryRunEvidence): string {
  if (evidence.status === "succeeded") {
    return evidence.outputExcerpt === undefined
      ? "Succeeded with a usable result."
      : `Succeeded. ${evidence.outputExcerpt}`;
  }

  if (evidence.status === "cancelled") {
    return "The task was cancelled before completion.";
  }

  return evidence.errorMessage === undefined
    ? "The task failed without a captured error message."
    : `Failed. ${evidence.errorMessage}`;
}

export function summarizeSessionGoal(runEvidence: readonly MemoryRunEvidence[]): string {
  const firstQuery = runEvidence[0]?.query ?? "No task goal was captured.";
  return trimCharacters(firstQuery, 180);
}

export function formatFailureAndRecovery(run: MemoryRunEvidence): string {
  const failure =
    run.errorMessage ??
    firstOrDefault(
      run.tools
        .filter((tool) => tool.status === "failed")
        .map((tool) => tool.errorMessage ?? `${tool.toolName} failed.`),
      "A failure path was captured.",
    );
  const fix = firstOrDefault(
    deriveDefaultFixes(run),
    "Retry only after choosing a more targeted recovery path.",
  );
  return `${run.runId}: ${failure} Recovery: ${fix}`;
}

export function deriveLessonsFromEvidence(evidence: MemoryRunEvidence): readonly string[] {
  const lessons = [
    ...(evidence.tools.some((tool) => tool.status === "completed")
      ? ["Reuse the successful tool path instead of rediscovering it from scratch."]
      : []),
    ...(evidence.tools.some((tool) => tool.status === "failed")
      ? [
          "When a tool path fails, switch to the validated recovery path instead of repeating the same attempt.",
        ]
      : []),
    ...(evidence.status === "failed"
      ? ["Capture the failure reason clearly so the next run can avoid the same mistake."]
      : []),
  ];

  return dedupeStrings(lessons);
}

export function deriveDefaultFixes(evidence: MemoryRunEvidence): readonly string[] {
  if (evidence.tools.some((tool) => tool.status === "failed")) {
    return [
      "Inspect the failed tool path first, then move to the successful path that produced a cleaner result.",
    ];
  }

  if (evidence.status === "failed") {
    return ["Tighten the approach and validate assumptions earlier in the task."];
  }

  return ["Start from the successful path recorded here before exploring alternatives."];
}

export function derivePositivePractices(evidence: MemoryRunEvidence): readonly string[] {
  const practices = evidence.tools
    .filter((tool) => tool.status === "completed")
    .map((tool) => `Use ${tool.toolName} deliberately once the task direction is clear.`);

  return practices.length === 0
    ? ["Record the successful path when the task finishes well."]
    : practices;
}

export function deriveAntiPatterns(evidence: MemoryRunEvidence): readonly string[] {
  const patterns = evidence.tools
    .filter((tool) => tool.status === "failed")
    .map((tool) => `Do not keep retrying ${tool.toolName} without changing the approach.`);

  return patterns.length === 0
    ? ["Do not treat a one-off success as universal without evidence."]
    : patterns;
}

export function deriveSkillId(runEvidence: readonly MemoryRunEvidence[]): string {
  const text = runEvidence.map((run) => run.query).join(" ").toLowerCase();
  const tokens = text
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  const chosen = dedupeStrings(tokens).slice(0, 4);
  return sanitizeIdSegment(
    (chosen.length === 0 ? "general-memory-skill" : chosen.join("-")).toLowerCase(),
  );
}

const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "into",
  "about",
  "should",
  "could",
  "would",
  "there",
  "their",
  "task",
  "session",
  "please",
  "implement",
  "continue",
]);

export function skillIdToContextId(skillId: string): string {
  return `${SKILLS_PREFIX}${skillId}${MARKDOWN_EXTENSION}`;
}
