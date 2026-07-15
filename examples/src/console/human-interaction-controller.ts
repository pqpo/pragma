import type {
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
  ExpertAgentUserQuestion,
} from "@pragma/core";

import {
  createHumanInteractionResponse,
  questionsForHumanRequest,
} from "./human-interaction-parser.ts";

export interface QueuedConsoleInteraction {
  readonly interactionId: string;
  readonly invocationId: string;
  readonly request: ExpertAgentHumanRequest;
  readonly questions: readonly ExpertAgentUserQuestion[];
  readonly answers: Record<string, string>;
  questionIndex: number;
  optionIndex: number;
  selectedOptions: Set<number>;
  completion?: CompletedConsoleInteraction | undefined;
}

export interface CompletedConsoleInteraction {
  readonly interactionId: string;
  readonly invocationId: string;
  readonly response: ExpertAgentHumanResponse;
}

export class HumanInteractionQueue {
  private readonly items: QueuedConsoleInteraction[] = [];

  get active(): QueuedConsoleInteraction | undefined {
    return this.items[0];
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(input: {
    readonly interactionId: string;
    readonly invocationId: string;
    readonly request: ExpertAgentHumanRequest;
  }): void {
    if (this.items.some((item) => item.interactionId === input.interactionId)) return;
    this.items.push({
      ...input,
      questions: questionsForHumanRequest(input.request),
      answers: {},
      questionIndex: 0,
      optionIndex: 0,
      selectedOptions: new Set(),
    });
  }

  remove(interactionId: string): string | undefined {
    const index = this.items.findIndex((item) => item.interactionId === interactionId);
    if (index < 0) return undefined;
    return this.items.splice(index, 1)[0]?.invocationId;
  }

  moveOption(direction: 1 | -1): void {
    const active = this.active;
    const question = active?.questions[active.questionIndex];
    if (active === undefined || question === undefined || question.options.length === 0) return;
    active.optionIndex =
      (active.optionIndex + direction + question.options.length) % question.options.length;
  }

  selectNumber(number: number): void {
    const active = this.active;
    const question = active?.questions[active.questionIndex];
    if (
      active === undefined ||
      question === undefined ||
      number < 1 ||
      number > question.options.length
    ) {
      return;
    }
    active.optionIndex = number - 1;
  }

  toggleOption(): void {
    const active = this.active;
    const question = active?.questions[active.questionIndex];
    if (active === undefined || question?.kind !== "multiple_choice") return;
    if (active.selectedOptions.has(active.optionIndex)) {
      active.selectedOptions.delete(active.optionIndex);
    } else {
      active.selectedOptions.add(active.optionIndex);
    }
  }

  submit(text = ""): CompletedConsoleInteraction | string | undefined {
    const active = this.active;
    if (active?.completion !== undefined) return active.completion;
    const question = active?.questions[active.questionIndex];
    if (active === undefined || question === undefined) return undefined;

    const answer = readInteractionAnswer(active, question, text);
    if (typeof answer !== "string") return answer.message;
    active.answers[question.question] = answer;
    active.questionIndex += 1;
    active.optionIndex = 0;
    active.selectedOptions.clear();
    if (active.questionIndex < active.questions.length) return undefined;

    active.completion = {
      interactionId: active.interactionId,
      invocationId: active.invocationId,
      response: createHumanInteractionResponse(active.request, active.answers),
    };
    return active.completion;
  }
}

function readInteractionAnswer(
  interaction: QueuedConsoleInteraction,
  question: ExpertAgentUserQuestion,
  text: string,
): string | { readonly message: string } {
  if (question.kind === "text") {
    const answer = text.trim();
    return answer === "" ? { message: "请输入回答后再提交。" } : answer;
  }
  if (question.kind === "multiple_choice") {
    const indexes = [...interaction.selectedOptions].sort((left, right) => left - right);
    return indexes.length === 0
      ? { message: "请至少选择一个选项。" }
      : indexes.map((index) => question.options[index]!.label).join(", ");
  }
  const answer = question.options[interaction.optionIndex]?.label;
  return answer === undefined || answer === "" ? { message: "请选择一个选项。" } : answer;
}
