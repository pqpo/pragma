import { CalendarBlank, CaretLeft, CaretRight, Clock } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Dialog } from "./Dialog.tsx";
import { SelectMenu } from "./SelectMenu.tsx";

type PickerMode = "date-time" | "time";

export function DateTimePicker(props: {
  readonly label: string;
  readonly value: string;
  readonly mode?: PickerMode | undefined;
  readonly optional?: boolean | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly dataField?: string | undefined;
  readonly onTouched?: (() => void) | undefined;
  readonly onChange: (value: string) => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const { t: tCommon } = useTranslation("common");
  const mode = props.mode ?? "date-time";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => pickerDate(props.value, mode));
  const [month, setMonth] = useState(() => monthStart(pickerDate(props.value, mode)));
  const days = useMemo(() => calendarDays(month), [month]);
  const hourOptions = useMemo(
    () =>
      Array.from({ length: 24 }, (_, hour) => twoDigits(hour)).map((value) => ({
        value,
        label: value,
      })),
    [],
  );
  const minuteOptions = useMemo(
    () =>
      Array.from({ length: 60 }, (_, minute) => twoDigits(minute)).map((value) => ({
        value,
        label: value,
      })),
    [],
  );

  const begin = () => {
    const next = pickerDate(props.value, mode);
    setDraft(next);
    setMonth(monthStart(next));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    props.onTouched?.();
  };
  const commit = () => {
    props.onChange(mode === "time" ? formatTime(draft) : formatDateTime(draft));
    close();
  };
  const moveCalendarFocus = (day: Date, offset: number) => {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
    setDraft(copyDate(draft, next));
    setMonth(monthStart(next));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-calendar-date="${formatDate(next)}"]`)?.focus();
      });
    });
  };

  return (
    <>
      <button
        className="date-time-picker-trigger"
        type="button"
        data-automation-field={props.dataField}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        onClick={begin}
      >
        {mode === "time" ? (
          <Clock size={16} aria-hidden="true" />
        ) : (
          <CalendarBlank size={16} aria-hidden="true" />
        )}
        <span className={props.value === "" ? "is-placeholder" : ""}>
          {props.value === ""
            ? mode === "time"
              ? t("selectTime")
              : t("selectDateTime")
            : formatDisplay(props.value, mode, i18n.language)}
        </span>
      </button>
      {open ? (
        <Dialog
          className={mode === "time" ? "date-time-dialog is-time-only" : "date-time-dialog"}
          title={props.label}
          onCancel={close}
          footer={
            <>
              {props.optional ? (
                <button
                  className="secondary-button date-time-clear"
                  type="button"
                  onClick={() => {
                    props.onChange("");
                    close();
                  }}
                >
                  {tCommon("actions.clear")}
                </button>
              ) : null}
              <button className="secondary-button" type="button" onClick={close}>
                {tCommon("actions.cancel")}
              </button>
              <button className="primary-button" type="button" onClick={commit}>
                {tCommon("actions.done")}
              </button>
            </>
          }
        >
          {mode === "date-time" ? (
            <div className="date-time-calendar">
              <header>
                <button
                  type="button"
                  aria-label={t("previousMonth")}
                  onClick={() => setMonth(addMonths(month, -1))}
                >
                  <CaretLeft size={17} aria-hidden="true" />
                </button>
                <strong>{formatMonth(month, i18n.language)}</strong>
                <button
                  type="button"
                  aria-label={t("nextMonth")}
                  onClick={() => setMonth(addMonths(month, 1))}
                >
                  <CaretRight size={17} aria-hidden="true" />
                </button>
              </header>
              <div className="date-time-weekdays" aria-hidden="true">
                {weekdayLabels(i18n.language).map((label, index) => (
                  <span key={`${index}-${label}`}>{label}</span>
                ))}
              </div>
              <div className="date-time-days">
                {days.map((day) => {
                  const selected = sameDate(day, draft);
                  return (
                    <button
                      className={[
                        day.getMonth() === month.getMonth() ? "" : "is-outside",
                        selected ? "is-selected" : "",
                        sameDate(day, new Date()) ? "is-today" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      type="button"
                      data-dialog-initial-focus={selected || undefined}
                      data-calendar-date={formatDate(day)}
                      aria-pressed={selected}
                      aria-label={new Intl.DateTimeFormat(i18n.language, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      }).format(day)}
                      key={formatDate(day)}
                      onClick={() => {
                        setDraft(copyDate(draft, day));
                        setMonth(monthStart(day));
                      }}
                      onKeyDown={(event) => {
                        const offset =
                          event.key === "ArrowRight"
                            ? 1
                            : event.key === "ArrowLeft"
                              ? -1
                              : event.key === "ArrowDown"
                                ? 7
                                : event.key === "ArrowUp"
                                  ? -7
                                  : undefined;
                        if (offset === undefined) return;
                        event.preventDefault();
                        moveCalendarFocus(day, offset);
                      }}
                    >
                      {day.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="date-time-clock" aria-label={t("time")}>
            <div>
              <span>{t("hour")}</span>
              <SelectMenu
                ariaLabel={t("hour")}
                className="form-select"
                portal={false}
                value={twoDigits(draft.getHours())}
                options={hourOptions}
                onChange={(hour) => setDraft(withTime(draft, Number(hour), draft.getMinutes()))}
              />
            </div>
            <span aria-hidden="true">:</span>
            <div>
              <span>{t("minute")}</span>
              <SelectMenu
                ariaLabel={t("minute")}
                className="form-select"
                portal={false}
                value={twoDigits(draft.getMinutes())}
                options={minuteOptions}
                onChange={(minute) => setDraft(withTime(draft, draft.getHours(), Number(minute)))}
              />
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function pickerDate(value: string, mode: PickerMode): Date {
  if (mode === "time") {
    const match = /^(\d{2}):(\d{2})$/u.exec(value);
    const result = new Date();
    result.setSeconds(0, 0);
    result.setHours(Number(match?.[1] ?? 9), Number(match?.[2] ?? 0));
    return result;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) {
    const result = new Date();
    result.setSeconds(0, 0);
    return result;
  }
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function calendarDays(month: Date): readonly Date[] {
  const firstWeekday = (month.getDay() + 6) % 7;
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - firstWeekday);
  return Array.from(
    { length: 42 },
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
}

function weekdayLabels(locale: string): readonly string[] {
  const monday = new Date(2024, 0, 1);
  return Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index),
    ),
  );
}

function formatDisplay(value: string, mode: PickerMode, locale: string): string {
  const date = pickerDate(value, mode);
  return new Intl.DateTimeFormat(
    locale,
    mode === "time"
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        },
  ).format(date);
}

function formatMonth(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(value);
}

function formatDateTime(value: Date): string {
  return `${formatDate(value)}T${formatTime(value)}`;
}

function formatDate(value: Date): string {
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`;
}

function formatTime(value: Date): string {
  return `${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function addMonths(value: Date, amount: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1);
}

function sameDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function copyDate(time: Date, date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.getHours(),
    time.getMinutes(),
  );
}

function withTime(value: Date, hour: number, minute: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), hour, minute);
}
