function sameSubmission(failed, retry) {
  if (failed.name !== retry.name) return false;
  const left = failed.args;
  const right = retry.args;
  if (left.candidate !== undefined || right.candidate !== undefined)
    return left.candidate === right.candidate && left.part === right.part;
  if (failed.name === "submit_fact")
    return (
      left.predicate === right.predicate &&
      left.value.trim() === right.value.trim() &&
      JSON.stringify([...left.subjects].sort()) === JSON.stringify([...right.subjects].sort())
    );
  if (left.part !== right.part) return false;
  if (left.part === "attempt") return left.description === right.description;
  if (left.part === "recovery") return left.failure === right.failure;
  return ["goal", "summary", "outcome"].includes(left.part);
}

/** A parallel or unrelated successful submission does not prove recovery from the injected error. */
export function assessInjectedEvidenceRecovery(calls, injectedAt) {
  const failed = injectedAt === undefined ? undefined : calls[injectedAt];
  if (!failed || !failed.isError || failed.feedback?.code !== "memory_curator_evidence_ref_invalid")
    return { verified: false, corrections: null };
  const attempts = calls.filter(
    (call) =>
      Number.isSafeInteger(call.sequenceStart) &&
      Number.isSafeInteger(call.sequenceEnd) &&
      call.sequenceStart > failed.sequenceEnd &&
      sameSubmission(failed, call),
  );
  const repairedAt = attempts.findIndex((call) => call.isError === false);
  const corrections = repairedAt < 0 ? null : repairedAt + 1;
  return { verified: corrections !== null && corrections <= 2, corrections };
}
