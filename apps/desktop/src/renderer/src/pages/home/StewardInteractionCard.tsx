import { ArrowLeft, ArrowRight, Check, X } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { HumanInteractionResponse } from "@pragma/shared";

import type { StewardInteraction } from "../../../../shared/desktop-api.ts";

type StewardQuestion = NonNullable<StewardInteraction["request"]["questions"]>[number];
type StewardAnswer = string | readonly string[];

export function StewardInteractionCard(props: {
  readonly interaction: StewardInteraction;
  readonly responding: boolean;
  readonly onRespond: (response: HumanInteractionResponse) => void;
}) {
  const { t } = useTranslation("home");
  const request = props.interaction.request;
  const questions = request.questions ?? [];
  const [answers, setAnswers] = useState<Readonly<Record<string, StewardAnswer>>>({});
  const [notes, setNotes] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const index = Math.min(questionIndex, Math.max(questions.length - 1, 0));
  const question = questions[index];
  const answer = question === undefined ? undefined : answers[question.question];
  const answerValid = question === undefined ? true : stewardAnswerValid(question, answer);

  const setAnswer = (questionText: string, value: StewardAnswer) => {
    setAnswers((current) => ({ ...current, [questionText]: value }));
  };

  return (
    <article
      className="steward-interaction"
      aria-labelledby={`steward-${props.interaction.interactionId}`}
    >
      <header>
        <small>
          {request.kind === "approval"
            ? t("interaction.approvalRequired")
            : t("interaction.inputNeeded")}
        </small>
        <strong id={`steward-${props.interaction.interactionId}`}>
          {request.title ?? t("interaction.defaultTitle")}
        </strong>
        {request.prompt === undefined ? null : <p>{request.prompt}</p>}
      </header>

      {request.kind === "approval" ? (
        <>
          {request.data === undefined ? null : <pre>{JSON.stringify(request.data, null, 2)}</pre>}
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={t("interaction.optionalNotes")}
            aria-label={t("interaction.optionalApprovalNotes")}
          />
          <footer>
            <button
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: false,
                  decision: "rejected",
                  notes: notes || undefined,
                })
              }
            >
              <X size={15} /> {t("interaction.reject")}
            </button>
            <button
              className="is-primary"
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({ approved: true, decision: "approved", notes: notes || undefined })
              }
            >
              <Check size={15} />
              {props.responding ? t("interaction.submitting") : t("interaction.approve")}
            </button>
          </footer>
        </>
      ) : question === undefined ? (
        <footer>
          <button
            className="is-primary"
            type="button"
            disabled={props.responding}
            onClick={() => props.onRespond({ notes: notes || undefined })}
          >
            {t("interaction.continue")}
          </button>
        </footer>
      ) : (
        <>
          <section className="steward-question">
            <small>
              {t("interaction.questionPosition", {
                current: index + 1,
                total: questions.length,
                header: question.header,
              })}
            </small>
            <strong>{question.question}</strong>
            <StewardQuestionInput question={question} answer={answer} onAnswer={setAnswer} />
          </section>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={t("interaction.optionalNotes")}
            aria-label={t("interaction.optionalResponseNotes")}
          />
          <footer>
            <button
              type="button"
              disabled={index === 0 || props.responding}
              onClick={() => setQuestionIndex(index - 1)}
            >
              <ArrowLeft size={15} /> {t("interaction.back")}
            </button>
            {index < questions.length - 1 ? (
              <button
                className="is-primary"
                type="button"
                disabled={!answerValid || props.responding}
                onClick={() => setQuestionIndex(index + 1)}
              >
                {t("interaction.next")} <ArrowRight size={15} />
              </button>
            ) : (
              <button
                className="is-primary"
                type="button"
                disabled={!answerValid || props.responding}
                onClick={() => props.onRespond({ answers, notes: notes || undefined })}
              >
                {props.responding ? t("interaction.submitting") : t("interaction.submitResponse")}
              </button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}

function StewardQuestionInput(props: {
  readonly question: StewardQuestion;
  readonly answer: StewardAnswer | undefined;
  readonly onAnswer: (question: string, value: StewardAnswer) => void;
}) {
  if (props.question.kind === "text") {
    return (
      <textarea
        value={typeof props.answer === "string" ? props.answer : ""}
        onChange={(event) => props.onAnswer(props.question.question, event.target.value)}
        aria-label={props.question.question}
        autoFocus
      />
    );
  }
  if (props.question.kind === "single_choice") {
    return (
      <div className="steward-question-options">
        {props.question.options.map((option) => (
          <button
            className={props.answer === option.label ? "is-selected" : ""}
            type="button"
            key={option.label}
            onClick={() => props.onAnswer(props.question.question, option.label)}
          >
            <strong>{option.label}</strong>
            {option.description === "" ? null : <small>{option.description}</small>}
          </button>
        ))}
      </div>
    );
  }
  const selected = Array.isArray(props.answer) ? props.answer : [];
  return (
    <div className="steward-question-options is-multiple">
      {props.question.options.map((option) => (
        <label key={option.label}>
          <input
            type="checkbox"
            checked={selected.includes(option.label)}
            onChange={(event) =>
              props.onAnswer(
                props.question.question,
                event.target.checked
                  ? [...selected, option.label]
                  : selected.filter((value) => value !== option.label),
              )
            }
          />
          <span>
            <strong>{option.label}</strong>
            {option.description === "" ? null : <small>{option.description}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function stewardAnswerValid(
  question: StewardQuestion,
  answer: StewardAnswer | undefined,
): boolean {
  if (question.kind === "multiple_choice") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" && answer.trim() !== "";
}
