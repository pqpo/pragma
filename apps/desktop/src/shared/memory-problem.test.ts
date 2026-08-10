import { describe, expect, it } from "vitest";

import { classifyDesktopMemoryProblem } from "./memory-problem.ts";

describe("classifyDesktopMemoryProblem", () => {
  it.each([
    ["extractor_evidence_ref_invalid", undefined, "invalid_output"],
    ["semantic_evidence_ref_invalid", undefined, "invalid_output"],
    ["semantic_extraction_validation_failed", undefined, "invalid_output"],
    ["semantic_fact_duplicate", "transient-exhausted", "invalid_output"],
    ["semantic_subject_context_missing", "configuration", "dependency"],
    ["memory_extractor_profile_invalid", "configuration", "configuration"],
    ["knowledge_learning_sink_unavailable", undefined, "configuration"],
    ["knowledge_candidate_capacity_exceeded", "capacity", "capacity"],
    ["memory_curator_timeout", "transient-exhausted", "runtime"],
    ["episodic_extraction_failed", "transient-exhausted", "runtime"],
    ["episodic_root_attribution_invalid", "transient-exhausted", "internal"],
    ["knowledge_source_digest_invalid", "transient-exhausted", "internal"],
    ["new_provider_failure", "transient-exhausted", "runtime"],
    ["future_unclassified_failure", "transient-exhausted", "unknown"],
  ] as const)("classifies %s as %s", (technicalCode, failureClass, expected) => {
    expect(classifyDesktopMemoryProblem(technicalCode, failureClass)).toEqual({
      kind: expected,
      technicalCode,
    });
  });
});
