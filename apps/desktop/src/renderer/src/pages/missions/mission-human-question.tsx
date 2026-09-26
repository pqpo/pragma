import { useState } from "react";
import { CaretLeft, CaretRight, CheckCircle, Plus, StopCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { type HumanInteractionResponse } from "@pragma/shared";
import { type MissionHumanInteraction } from "../../../../shared/contracts/index.ts";
import { formatInteractionData } from "./mission-page-utils.ts";

export type MissionHumanQuestion = NonNullable<
  MissionHumanInteraction["request"]["questions"]
>[number];

export function MissionHumanComposer(props: {
  readonly interaction: MissionHumanInteraction;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly customAnswers: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly questionNotes: Readonly<Record<string, string>>;
  readonly questionIndex: number;
  readonly interactionPosition: { readonly current: number; readonly total: number };
  readonly responding: boolean;
  readonly interruptible: boolean;
  readonly interrupting: boolean;
  readonly onQuestionIndex: (index: number) => void;
  readonly onAnswer: (question: string, value: string | readonly string[]) => void;
  readonly onCustomAnswer: (question: string, value: string) => void;
  readonly onNotes: (value: string) => void;
  readonly onQuestionNote: (question: string, value: string) => void;
  readonly onRespond: (response: HumanInteractionResponse) => void;
  readonly onInterrupt: () => void;
}) {
  const { t } = useTranslation("missions");
  const [visibleQuestionNotes, setVisibleQuestionNotes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const request = props.interaction.request;
  const questions = request.questions ?? [];
  const index = Math.min(props.questionIndex, Math.max(questions.length - 1, 0));
  const question = questions[index];
  const answer = question === undefined ? undefined : props.answers[question.question];
  const customAnswer = question === undefined ? "" : (props.customAnswers[question.question] ?? "");
  const questionNote = question === undefined ? "" : (props.questionNotes[question.question] ?? "");
  const questionNoteVisible =
    question !== undefined && (visibleQuestionNotes.has(question.question) || questionNote !== "");
  const isLastQuestion = index === questions.length - 1;
  const currentAnswerValid =
    question !== undefined &&
    hasValidMissionHumanAnswer(question, props.answers, props.customAnswers);
  const heading =
    question?.question ?? request.title ?? t("humanInputRequired", { ns: "missions" });
  const helperText =
    question === undefined
      ? (request.prompt ?? t("humanReview", { ns: "missions" }))
      : request.prompt === undefined || request.prompt === question.question
        ? undefined
        : request.prompt;

  return (
    <section className="mission-human-composer" aria-labelledby="mission-human-title">
      <header>
        <div className="mission-human-heading">
          {question === undefined ? (
            <small>
              {t("userInputPosition", {
                ns: "missions",
                current: props.interactionPosition.current,
                total: props.interactionPosition.total,
              })}
            </small>
          ) : (
            <small>{question.header}</small>
          )}
          <strong id="mission-human-title">{heading}</strong>
          {helperText === undefined ? null : <p>{helperText}</p>}
        </div>
        <div className="mission-human-header-actions">
          {request.kind !== "approval" && question !== undefined && questions.length > 1 ? (
            <div
              className="mission-human-question-navigation"
              aria-label={t("questionNavigation", { ns: "missions" })}
            >
              <button
                type="button"
                aria-label={t("previousQuestion", { ns: "missions" })}
                title={t("previousQuestion", { ns: "missions" })}
                disabled={index === 0 || props.responding}
                onClick={() => props.onQuestionIndex(index - 1)}
              >
                <CaretLeft size={16} aria-hidden="true" />
              </button>
              <span aria-live="polite">
                {t("questionProgress", {
                  ns: "missions",
                  current: index + 1,
                  total: questions.length,
                })}
              </span>
              <button
                type="button"
                aria-label={t("nextQuestion", { ns: "missions" })}
                title={t("nextQuestion", { ns: "missions" })}
                disabled={index === questions.length - 1 || props.responding}
                onClick={() => props.onQuestionIndex(index + 1)}
              >
                <CaretRight size={16} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <button
            className="mission-human-interrupt"
            type="button"
            aria-label={t("interrupt", { ns: "missions" })}
            title={t("interrupt", { ns: "missions" })}
            disabled={!props.interruptible || props.interrupting}
            onClick={props.onInterrupt}
          >
            <StopCircle size={20} weight="fill" aria-hidden="true" />
          </button>
        </div>
      </header>
      {request.kind === "approval" ? (
        <>
          {request.data === undefined ? null : <pre>{formatInteractionData(request.data)}</pre>}
          <textarea
            value={props.notes}
            onChange={(event) => props.onNotes(event.target.value)}
            placeholder={t("optionalNotes", { ns: "missions" })}
          />
          <footer>
            <button
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: false,
                  decision: "rejected",
                  notes: props.notes,
                })
              }
            >
              {t("reject", { ns: "missions" })}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: true,
                  decision: "approved",
                  notes: props.notes,
                })
              }
            >
              {props.responding
                ? t("submitting", { ns: "missions" })
                : t("approveContinue", { ns: "missions" })}
            </button>
          </footer>
        </>
      ) : question === undefined ? (
        <footer>
          <button
            className="primary-button"
            type="button"
            disabled={props.responding}
            onClick={() => props.onRespond({ notes: props.notes })}
          >
            {t("continue", { ns: "missions" })}
          </button>
        </footer>
      ) : (
        <>
          <div className="mission-human-question">
            <HumanQuestionInput
              question={question}
              answer={answer}
              customAnswer={customAnswer}
              onAnswer={(value) => props.onAnswer(question.question, value)}
              onCustomAnswer={(value) => props.onCustomAnswer(question.question, value)}
            />
          </div>
          {questionNoteVisible ? (
            <textarea
              value={questionNote}
              onChange={(event) => props.onQuestionNote(question.question, event.target.value)}
              placeholder={t("optionalNotes", { ns: "missions" })}
            />
          ) : null}
          <footer>
            {questionNoteVisible ? null : (
              <button
                className="mission-human-add-note"
                type="button"
                disabled={props.responding}
                onClick={() =>
                  setVisibleQuestionNotes((current) => new Set([...current, question.question]))
                }
              >
                <Plus size={16} aria-hidden="true" />
                {t("addNote", { ns: "missions" })}
              </button>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={!currentAnswerValid || props.responding}
              onClick={() => {
                if (!isLastQuestion) {
                  props.onQuestionIndex(index + 1);
                  return;
                }
                const notes = formatMissionHumanQuestionNotes(questions, props.questionNotes);
                props.onRespond({
                  answers: mergeMissionHumanAnswers(props.answers, props.customAnswers),
                  ...(notes === "" ? {} : { notes }),
                });
              }}
            >
              {props.responding
                ? t("submitting", { ns: "missions" })
                : isLastQuestion
                  ? t("confirmContinue", { ns: "missions" })
                  : t("nextQuestion", { ns: "missions" })}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function HumanQuestionInput(props: {
  readonly question: MissionHumanQuestion;
  readonly answer: string | readonly string[] | undefined;
  readonly customAnswer: string;
  readonly onAnswer: (value: string | readonly string[]) => void;
  readonly onCustomAnswer: (value: string) => void;
}) {
  const { t } = useTranslation("missions");
  if (props.question.kind === "text") {
    return (
      <textarea
        value={typeof props.answer === "string" ? props.answer : ""}
        onChange={(event) => props.onAnswer(event.target.value)}
        aria-labelledby="mission-human-title"
        autoFocus
      />
    );
  }
  if (props.question.kind === "single_choice") {
    return (
      <>
        <div className="mission-human-options">
          {props.question.options.map((option) => {
            const selected = props.answer === option.label;
            return (
              <button
                className={selected ? "is-selected" : ""}
                type="button"
                aria-pressed={selected}
                key={option.label}
                onClick={() => props.onAnswer(option.label)}
              >
                <span className="mission-human-option-copy">
                  <strong>{option.label}</strong>
                  {option.description === "" ? null : <small>{option.description}</small>}
                </span>
                {selected ? (
                  <CheckCircle
                    className="mission-human-option-state"
                    size={18}
                    weight="fill"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        <HumanCustomAnswerInput
          value={props.customAnswer}
          onChange={props.onCustomAnswer}
          label={t("customAnswer")}
          placeholder={t("customAnswerPlaceholder")}
        />
      </>
    );
  }
  const selected = Array.isArray(props.answer) ? props.answer : [];
  return (
    <>
      <div className="mission-human-options is-multiple">
        {props.question.options.map((option) => {
          const optionSelected = selected.includes(option.label);
          return (
            <label className={optionSelected ? "is-selected" : ""} key={option.label}>
              <input
                type="checkbox"
                checked={optionSelected}
                onChange={(event) =>
                  props.onAnswer(
                    event.target.checked
                      ? [...selected, option.label]
                      : selected.filter((value) => value !== option.label),
                  )
                }
              />
              <span className="mission-human-option-copy">
                <strong>{option.label}</strong>
                {option.description === "" ? null : <small>{option.description}</small>}
              </span>
            </label>
          );
        })}
      </div>
      <HumanCustomAnswerInput
        value={props.customAnswer}
        onChange={props.onCustomAnswer}
        label={t("customAnswer")}
        placeholder={t("customAnswerPlaceholder")}
      />
    </>
  );
}

function HumanCustomAnswerInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder: string;
}) {
  return (
    <label className="mission-human-custom-answer">
      <span>{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
      />
    </label>
  );
}

function humanAnswerValid(
  question: MissionHumanQuestion,
  answer: string | readonly string[] | undefined,
  customAnswer: string | undefined,
): boolean {
  if (question.kind !== "text" && customAnswer !== undefined && customAnswer.trim() !== "") {
    return true;
  }
  if (question.kind === "multiple_choice") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" && answer.trim() !== "";
}

export function hasValidMissionHumanAnswers(
  questions: readonly MissionHumanQuestion[],
  answers: Readonly<Record<string, string | readonly string[]>>,
  customAnswers: Readonly<Record<string, string>>,
): boolean {
  return questions.every((question) =>
    hasValidMissionHumanAnswer(question, answers, customAnswers),
  );
}

export function hasValidMissionHumanAnswer(
  question: MissionHumanQuestion,
  answers: Readonly<Record<string, string | readonly string[]>>,
  customAnswers: Readonly<Record<string, string>>,
): boolean {
  return humanAnswerValid(question, answers[question.question], customAnswers[question.question]);
}

export function mergeMissionHumanAnswers(
  answers: Readonly<Record<string, string | readonly string[]>>,
  customAnswers: Readonly<Record<string, string>>,
): Record<string, string | readonly string[]> {
  const merged = { ...answers };
  for (const [question, customAnswer] of Object.entries(customAnswers)) {
    if (customAnswer.trim() !== "") merged[question] = customAnswer;
  }
  return merged;
}

export function formatMissionHumanQuestionNotes(
  questions: readonly MissionHumanQuestion[],
  notes: Readonly<Record<string, string>>,
): string {
  return questions
    .flatMap((question) => {
      const note = notes[question.question]?.trim();
      return note === undefined || note === "" ? [] : [`${question.question}\n${note}`];
    })
    .join("\n\n");
}
