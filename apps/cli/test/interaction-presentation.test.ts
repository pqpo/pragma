import { describe, expect, it } from "vitest";
import { renderInteractionText } from "../src/presenters/interaction.ts";
import {
  presentRunOutcome,
  presentSuccess,
  renderWatchEventText,
} from "../src/presenters/index.ts";

const missionId = "11111111-1111-4111-8111-111111111111";
const envelope = {
  schemaVersion: "pragma.human-interaction/v1",
  kind: "request",
  missionId,
  executionId: missionId,
  interactionId: "question 'one'",
  interaction: {
    kind: "question",
    prompt: "Choose deployment",
    questions: [
      {
        header: "Region",
        question: "Which region?",
        kind: "single_choice",
        options: [{ label: "West", value: "us-west", description: "Western region" }],
      },
    ],
  },
};

describe("interaction presentation", () => {
  it("preserves questions and submission values in run/get/watch text", () => {
    const outputs: string[] = [];
    const input = {
      io: { writeStdout: (s: string) => outputs.push(s), writeStderr: () => {} },
      format: "text" as const,
      command: "mission.get",
      requestId: missionId,
      cliVersion: "test",
      startedAt: new Date(),
    };
    presentRunOutcome(input, { status: "input_required", missionId, interaction: envelope });
    presentSuccess(input, {
      schemaVersion: "pragma.mission-result/v2",
      missionId,
      title: "Deploy",
      status: "waiting",
      available: false,
      interaction: envelope,
    });
    outputs.push(renderWatchEventText({ type: "human.interaction.requested", data: envelope }));
    for (const output of outputs) {
      expect(output).toContain("Which region?");
      expect(output).toContain('submit="us-west"');
      expect(output).toContain('ANSWER KEY: "Which region?"');
      expect(output).toContain("--answers-json response.json --interactive never");
      expect(output).toContain("'question '\\''one'\\''' ");
    }
  });
  it("offers a read-only recovery query for incomplete data", () => {
    expect(renderInteractionText(undefined, missionId)).toContain(
      `pragma mission get ${missionId} --view result`,
    );
  });
  it("does not invent an approval decision", () => {
    const output = renderInteractionText({
      ...envelope,
      interaction: { kind: "approval", prompt: "Allow write?" },
    });
    expect(output).toContain("approved (boolean)");
    expect(output).toContain("explicitly authorized");
    expect(output).not.toContain('"approved":true');
  });
});
