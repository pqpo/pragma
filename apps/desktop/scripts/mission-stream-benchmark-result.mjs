export function parseMissionStreamBenchmarkResult(line, prefix) {
  const parsed = JSON.parse(line.slice(prefix.length));
  validateMissionStreamBenchmarkResult(parsed);
  return parsed;
}

export function validateMissionStreamBenchmarkResult(value) {
  if (value === null || typeof value !== "object") {
    throw new Error("Mission stream UI benchmark returned a non-object result.");
  }
  if ("error" in value) {
    throw new Error(`Mission stream UI benchmark renderer failed.\n${String(value.error)}`);
  }
  if (typeof value.generatedAt !== "string" || !Array.isArray(value.results)) {
    throw new Error("Mission stream UI benchmark result is missing metadata or scenarios.");
  }
  const expected = new Set(
    [100, 1_000, 5_000].flatMap((entries) => [`static:${entries}`, `streaming:${entries}`]),
  );
  if (value.results.length !== expected.size) {
    throw new Error("Mission stream UI benchmark returned an incomplete scenario set.");
  }
  for (const result of value.results) {
    if (result === null || typeof result !== "object") {
      throw new Error("Mission stream UI benchmark returned an invalid scenario.");
    }
    const key = `${String(result.mode)}:${String(result.entries)}`;
    if (!expected.delete(key)) {
      throw new Error(`Mission stream UI benchmark returned an unexpected scenario: ${key}.`);
    }
    for (const field of [
      "inputToPaintP50Ms",
      "inputToPaintP95Ms",
      "longTaskCount",
      "longTaskMs",
      "streamOperations",
      "samplesWithStreamProgress",
      "outputMutationCount",
      "renderedStreamCharacters",
    ]) {
      if (!Number.isFinite(result[field]) || result[field] < 0) {
        throw new Error(`Mission stream UI benchmark scenario ${key} has invalid ${field}.`);
      }
    }
    if (result.samples !== 40) {
      throw new Error(`Mission stream UI benchmark scenario ${key} has invalid sample count.`);
    }
    if (result.mode === "streaming") {
      if (
        result.streamOperations < result.samples ||
        result.samplesWithStreamProgress !== result.samples ||
        result.renderedStreamCharacters < result.samples
      ) {
        throw new Error(`Mission stream UI benchmark scenario ${key} did not sustain output.`);
      }
      if (result.outputMutationCount < result.samples) {
        throw new Error(`Mission stream UI benchmark scenario ${key} did not render output.`);
      }
    } else if (
      result.streamOperations !== 0 ||
      result.samplesWithStreamProgress !== 0 ||
      result.renderedStreamCharacters !== 0
    ) {
      throw new Error(`Mission stream UI benchmark static scenario ${key} streamed output.`);
    }
  }
  if (expected.size !== 0) {
    throw new Error("Mission stream UI benchmark result omitted expected scenarios.");
  }
}
