import { HumanInteractionRequestEnvelopeSchema } from "@pragma/shared/integration";
import { shellArgument } from "../commands/utils.ts";

/** Pure presentation of the Host's already-redacted interaction envelope. */
export function renderInteractionText(value: unknown, missionId?: string): string {
  const parsed = HumanInteractionRequestEnvelopeSchema.safeParse(value);
  if (!parsed.success)
    return `Input required; question details unavailable.\nNEXT: pragma mission get ${shellArgument(missionId ?? "<MISSION_ID>")} --view result --query-version 2\n`;
  const envelope = parsed.data;
  const request = envelope.interaction;
  const lines = [
    `INPUT REQUIRED: ${request.kind}`,
    `MISSION ID: ${envelope.missionId}`,
    `EXECUTION: ${envelope.executionId}`,
    `INTERACTION ID: ${envelope.interactionId}`,
    ...(request.title === undefined ? [] : [`TITLE: ${request.title}`]),
    ...(request.prompt === undefined ? [] : [`PROMPT: ${request.prompt}`]),
  ];
  const optionsText = (
    options: readonly { label: string; value?: string | undefined; description: string }[],
  ) =>
    options.map(
      (option) =>
        `OPTION: ${option.label}; submit=${JSON.stringify(option.value ?? option.label)}${option.description ? `; ${option.description}` : ""}`,
    );
  lines.push(...optionsText(request.options ?? []));
  for (const question of request.questions ?? []) {
    lines.push(
      `QUESTION: ${question.question}`,
      `HEADER: ${question.header}`,
      `ANSWER KEY: ${JSON.stringify(question.question)} (${question.kind})`,
      ...optionsText(question.options),
    );
  }
  if (request.kind === "approval") {
    lines.push(
      "RESPONSE FORMAT: response.json contains approved (boolean) and decision (string). Submit only an explicitly authorized decision.",
    );
  } else {
    const answers = Object.fromEntries(
      (request.questions ?? []).map((question) => [
        question.question,
        question.kind === "multiple_choice" ? ["<choice-value>"] : "<answer-or-choice-value>",
      ]),
    );
    lines.push(
      `RESPONSE FORMAT: ${JSON.stringify({ answers, ...(["manual_intervention", "review_gate"].includes(request.kind) ? { notes: "<notes>" } : {}) })}`,
    );
    if ((request.questions?.length ?? 0) === 0)
      lines.push(
        "For a single response use --answer TEXT or --choice VALUE (repeat --choice for multiple values), replacing --answers-json.",
      );
  }
  lines.push(
    `NEXT: pragma mission respond ${shellArgument(envelope.missionId)} --interaction ${shellArgument(envelope.interactionId)} --answers-json response.json --interactive never`,
  );
  return `${lines.join("\n")}\n`;
}
