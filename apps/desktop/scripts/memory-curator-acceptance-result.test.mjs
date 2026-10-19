import assert from "node:assert/strict";
import { test } from "node:test";
import { assessInjectedEvidenceRecovery } from "./memory-curator-acceptance-result.mjs";

const args = { predicate: "user.preference.language", value: "zh-Hans", subjects: ["user"] };
const failed = {
  name: "submit_fact",
  args,
  isError: true,
  feedback: { code: "memory_curator_evidence_ref_invalid" },
  sequenceStart: 0,
  sequenceEnd: 2,
};
const success = { name: "submit_fact", args, isError: false, sequenceStart: 3, sequenceEnd: 4 };
test("requires the intended injection to fail and a later retry of the same fact", () => {
  assert.equal(assessInjectedEvidenceRecovery([], undefined).verified, false);
  assert.equal(
    assessInjectedEvidenceRecovery([{ ...failed, isError: false }, success], 0).verified,
    false,
  );
  assert.equal(
    assessInjectedEvidenceRecovery(
      [{ ...failed, feedback: { code: "memory_curator_arguments_invalid" } }, success],
      0,
    ).verified,
    false,
  );
  assert.equal(
    assessInjectedEvidenceRecovery(
      [
        failed,
        { ...success, args: { ...args, predicate: "user.preference.theme", value: "dark" } },
      ],
      0,
    ).verified,
    false,
  );
  assert.equal(
    assessInjectedEvidenceRecovery([failed, { ...success, sequenceStart: 1 }], 0).verified,
    false,
  );
  assert.deepEqual(assessInjectedEvidenceRecovery([failed, success], 0), {
    verified: true,
    corrections: 1,
  });
});
test("counts matching correction attempts and rejects a third resubmission", () => {
  const retry = { ...failed, sequenceStart: 3, sequenceEnd: 4 };
  const fixed = { ...success, sequenceStart: 5, sequenceEnd: 6 };
  assert.deepEqual(assessInjectedEvidenceRecovery([failed, retry, fixed], 0), {
    verified: true,
    corrections: 2,
  });
  assert.deepEqual(
    assessInjectedEvidenceRecovery(
      [
        failed,
        retry,
        { ...retry, sequenceStart: 5, sequenceEnd: 6 },
        { ...fixed, sequenceStart: 7, sequenceEnd: 8 },
      ],
      0,
    ),
    { verified: false, corrections: 3 },
  );
});
test("matches unique episode slots or the original attempt/recovery identity", () => {
  const check = (args, retry) =>
    assessInjectedEvidenceRecovery(
      [
        { ...failed, name: "submit_episode_part", args },
        { ...success, name: "submit_episode_part", args: retry },
      ],
      0,
    ).verified;
  assert.equal(
    check({ part: "goal", text: "original" }, { part: "goal", text: "corrected" }),
    true,
  );
  assert.equal(check({ part: "goal" }, { part: "summary" }), false);
  assert.equal(
    check({ part: "attempt", description: "first" }, { part: "attempt", description: "second" }),
    false,
  );
  assert.equal(
    check({ part: "recovery", failure: "first" }, { part: "recovery", failure: "second" }),
    false,
  );
  assert.equal(
    check(
      { part: "attempt", candidate: "attempt:a" },
      { part: "attempt", candidate: "attempt:a", description: "corrected" },
    ),
    true,
  );
  assert.equal(
    check({ part: "attempt", candidate: "attempt:a" }, { part: "attempt", candidate: "attempt:b" }),
    false,
  );
});
