import type { DesktopMemoryProblem } from "./contracts/index.ts";

const INVALID_OUTPUT_CODES = new Set([
  "extractor_evidence_ref_invalid",
  "semantic_subject_ref_invalid",
  "semantic_evidence_ref_invalid",
  "semantic_review_time_invalid",
  "semantic_expiry_time_invalid",
  "semantic_fact_duplicate",
  "semantic_replacement_target_invalid",
  "memory_curator_output_missing",
]);

const INTERNAL_CODES = new Set([
  "episodic_root_attribution_invalid",
  "semantic_root_attribution_invalid",
  "episodic_extraction_job_invalid",
  "semantic_extraction_job_invalid",
  "memory_pipeline_iteration_failed",
  "canonical_event_handoff_quarantined",
  "canonical_event_delivery_failed",
  "knowledge_job_state_invalid",
  "knowledge_source_digest_invalid",
  "skill_job_state_invalid",
  "skill_source_digest_invalid",
  "memory_extraction_job_action_invalid",
  "module_consume_failed",
  "payload_schema_invalid",
]);

export function classifyDesktopMemoryProblem(
  technicalCode: string,
  failureClass?: string | undefined,
): DesktopMemoryProblem {
  const code = technicalCode.toLowerCase();
  if (code === "semantic_subject_context_missing") {
    return { kind: "dependency", technicalCode };
  }
  if (failureClass === "capacity" || code.includes("capacity")) {
    return { kind: "capacity", technicalCode };
  }
  if (
    INVALID_OUTPUT_CODES.has(code) ||
    code.endsWith("_extraction_validation_failed") ||
    code.includes("output_invalid")
  ) {
    return { kind: "invalid_output", technicalCode };
  }
  if (
    failureClass === "configuration" ||
    code.includes("configuration") ||
    code.includes("profile") ||
    code.includes("unavailable")
  ) {
    return { kind: "configuration", technicalCode };
  }
  if (
    code.includes("curator") ||
    code.includes("runtime") ||
    code.includes("provider") ||
    code.includes("timeout") ||
    code.includes("rate_limit") ||
    code.includes("network") ||
    code.includes("temporarily") ||
    /^(?:episodic|semantic|knowledge|skill)_extraction_failed$/u.test(code)
  ) {
    return { kind: "runtime", technicalCode };
  }
  if (INTERNAL_CODES.has(code) || code.includes("job_invalid")) {
    return { kind: "internal", technicalCode };
  }
  return { kind: "unknown", technicalCode };
}
