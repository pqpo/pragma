import { describe, expect, it } from "vitest";

interface BenchmarkResultModule {
  readonly parseMissionStreamBenchmarkResult: (stdout: string, prefix: string) => unknown;
  readonly validateMissionStreamBenchmarkResult: (value: unknown) => void;
}

// Use a computed URL because the benchmark helper is deliberately executable plain ESM.
const benchmarkResultModuleUrl = new URL(
  "../../../../../scripts/mission-stream-benchmark-result.mjs",
  import.meta.url,
);
const { parseMissionStreamBenchmarkResult, validateMissionStreamBenchmarkResult } = (await import(
  benchmarkResultModuleUrl.href
)) as BenchmarkResultModule;

const scenario = (mode: "static" | "streaming", entries: number) => ({
  mode,
  entries,
  samples: 40,
  streamOperations: mode === "streaming" ? 80 : 0,
  samplesWithStreamProgress: mode === "streaming" ? 40 : 0,
  inputToPaintP50Ms: 33.3,
  inputToPaintP95Ms: 34.7,
  longTaskCount: 0,
  longTaskMs: 0,
  outputMutationCount: mode === "streaming" ? 80 : 0,
  renderedStreamCharacters: mode === "streaming" ? 80 : 0,
});

const completeResult = () => ({
  generatedAt: "2026-09-18T00:00:00.000Z",
  results: [100, 1_000, 5_000].flatMap((entries) => [
    scenario("static", entries),
    scenario("streaming", entries),
  ]),
});

describe("Mission stream benchmark result", () => {
  it("rejects renderer errors carried by the normal result prefix", () => {
    expect(() =>
      parseMissionStreamBenchmarkResult('PREFIX:{"error":"render failed"}', "PREFIX:"),
    ).toThrow("renderer failed");
  });

  it("rejects missing scenarios, samples, and rendered output", () => {
    expect(() =>
      validateMissionStreamBenchmarkResult({ ...completeResult(), results: [] }),
    ).toThrow("incomplete scenario set");
    const missingSamples = completeResult();
    missingSamples.results[0]!.samples = 39;
    expect(() => validateMissionStreamBenchmarkResult(missingSamples)).toThrow(
      "invalid sample count",
    );
    const missingOutput = completeResult();
    missingOutput.results[1]!.outputMutationCount = 0;
    expect(() => validateMissionStreamBenchmarkResult(missingOutput)).toThrow(
      "did not render output",
    );
    const stalledOutput = completeResult();
    stalledOutput.results[1]!.streamOperations = 1;
    stalledOutput.results[1]!.samplesWithStreamProgress = 1;
    stalledOutput.results[1]!.renderedStreamCharacters = 1;
    stalledOutput.results[1]!.outputMutationCount = 1;
    expect(() => validateMissionStreamBenchmarkResult(stalledOutput)).toThrow(
      "did not sustain output",
    );
  });

  it("accepts the complete six-scenario result", () => {
    expect(() => validateMissionStreamBenchmarkResult(completeResult())).not.toThrow();
  });
});
