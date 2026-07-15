import {
  ExpertAgentHumanRequestSchema,
  type ExecutionEvent,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
  type ExpertAgentUserQuestion,
} from "@pragma/core";

import { asConsoleRecord, readConsoleString } from "./execution-output-accumulator.ts";

export interface ParsedHumanInteraction {
  readonly interactionId: string;
  readonly invocationId: string;
  readonly request: ExpertAgentHumanRequest;
}

export type ConsoleQuestionAnswerResult =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly message: string };

export type ConsoleApprovalAnswerResult =
  | { readonly ok: true; readonly approved: boolean }
  | { readonly ok: false; readonly message: string };

export interface AnsweredUserQuestionResponse {
  readonly kind: "user_question";
  readonly answered: true;
  readonly answers: Readonly<Record<string, string>>;
}

export interface ConsoleToolApprovalResponse {
  readonly kind: "tool_approval";
  readonly approved: boolean;
  readonly reason: string;
}

export function parseHumanInteractionEvent(event: ExecutionEvent): ParsedHumanInteraction {
  if (event.type !== "human.requested") {
    throw new Error(`Expected human.requested event, received ${event.type}.`);
  }
  const payload = asConsoleRecord(event.data);
  const interactionId = readConsoleString(payload, "interactionId");
  if (interactionId === "") throw new Error("human.requested event is missing interactionId.");
  return {
    interactionId,
    invocationId: event.invocationId,
    request: ExpertAgentHumanRequestSchema.parse(payload["request"]),
  };
}

export function findPendingHumanRequestEvents(
  events: readonly ExecutionEvent[],
): readonly ExecutionEvent[] {
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => readConsoleString(asConsoleRecord(event.data), "interactionId"))
      .filter((interactionId) => interactionId !== ""),
  );
  return events.filter(
    (event) =>
      event.type === "human.requested" &&
      !responded.has(readConsoleString(asConsoleRecord(event.data), "interactionId")),
  );
}

export function parseConsoleQuestionAnswer(
  question: ExpertAgentUserQuestion,
  input: string,
): ConsoleQuestionAnswerResult {
  const normalized = input.trim();
  if (normalized === "") return { ok: false, message: "请输入回答后再按回车。" };
  if (question.kind === "text") return { ok: true, answer: normalized };

  const tokens =
    question.kind === "multiple_choice"
      ? normalized
          .split(/[,，]/u)
          .map((token) => token.trim())
          .filter((token) => token !== "")
      : [normalized];
  const selected: string[] = [];
  for (const token of tokens) {
    const option = readSelectedOption(question.options, token);
    if (option === undefined) {
      return {
        ok: false,
        message: `无法识别选项“${token}”；请输入编号或完整选项名称。`,
      };
    }
    if (!selected.includes(option.label)) selected.push(option.label);
  }
  if (question.kind === "single_choice" && selected.length !== 1) {
    return { ok: false, message: "单选题只能选择一个选项。" };
  }
  return { ok: true, answer: selected.join(", ") };
}

export function parseConsoleApprovalAnswer(input: string): ConsoleApprovalAnswerResult {
  const normalized = input.trim().toLocaleLowerCase();
  if (normalized === "y" || normalized === "yes" || normalized === "1") {
    return { ok: true, approved: true };
  }
  if (normalized === "n" || normalized === "no" || normalized === "2") {
    return { ok: true, approved: false };
  }
  return { ok: false, message: "请输入 y/yes 或 n/no。" };
}

export function consoleQuestionInstruction(question: ExpertAgentUserQuestion): string {
  switch (question.kind) {
    case "text":
      return "输入回答后回车；Ctrl+C 可取消整个 Turn。";
    case "single_choice":
      return "输入一个选项编号或名称后回车；Ctrl+C 可取消整个 Turn。";
    case "multiple_choice":
      return "输入多个编号或名称并用逗号分隔；Ctrl+C 可取消整个 Turn。";
  }
}

export function questionsForHumanRequest(
  request: ExpertAgentHumanRequest,
): readonly ExpertAgentUserQuestion[] {
  if (request.kind === "user_question") return request.questions;
  return [
    {
      header: "Tool approval",
      question: `${request.toolName}: ${request.reason ?? "Allow this tool?"}`,
      kind: "single_choice",
      options: [
        { label: "Yes", description: "Allow execution" },
        { label: "No", description: "Reject execution" },
      ],
    },
  ];
}

export function createHumanInteractionResponse(
  request: ExpertAgentHumanRequest,
  answers: Readonly<Record<string, string>>,
  options: {
    readonly approvedReason?: string | undefined;
    readonly rejectedReason?: string | undefined;
  } = {},
): ExpertAgentHumanResponse {
  if (request.kind === "user_question") {
    return createUserQuestionResponse(answers);
  }
  const question = questionsForHumanRequest(request)[0]!;
  const approved = answers[question.question]?.toLocaleLowerCase() === "yes";
  return createToolApprovalResponse(approved, options);
}

export function createUserQuestionResponse(
  answers: Readonly<Record<string, string>>,
): AnsweredUserQuestionResponse {
  return { kind: "user_question", answered: true, answers };
}

export function createToolApprovalResponse(
  approved: boolean,
  options: {
    readonly approvedReason?: string | undefined;
    readonly rejectedReason?: string | undefined;
  } = {},
): ConsoleToolApprovalResponse {
  return {
    kind: "tool_approval",
    approved,
    reason: approved
      ? (options.approvedReason ?? "User approved.")
      : (options.rejectedReason ?? "User rejected."),
  };
}

function readSelectedOption(
  options: ExpertAgentUserQuestion["options"],
  token: string,
): ExpertAgentUserQuestion["options"][number] | undefined {
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }
  const normalized = token.toLocaleLowerCase();
  return options.find((option) => option.label.toLocaleLowerCase() === normalized);
}
