import {
  CaretDown,
  Check,
  GitBranch,
  MagnifyingGlass,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { MissionExecutorOption } from "../../../shared/contracts/index.ts";
import { localizeSystemExpertCopy } from "../lib/system-expert-copy.ts";
import { Dialog } from "./Dialog.tsx";

type ExecutorKindFilter = "all" | MissionExecutorOption["kind"];

export function MissionExecutorPicker(props: {
  readonly executors: readonly MissionExecutorOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onTouched?: (() => void) | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
}) {
  const { t } = useTranslation("missions");
  const { t: tStudio } = useTranslation("studio");
  const { t: tCommon } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ExecutorKindFilter>("all");
  const selected = props.executors.find((executor) => executor.ref === props.value);
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const displayCopy = (executor: MissionExecutorOption) =>
    localizeSystemExpertCopy(executor, pragmaCopy);
  const selectedCopy = selected === undefined ? undefined : displayCopy(selected);
  const term = search.trim().toLocaleLowerCase();
  const visibleExecutors = props.executors.filter((executor) => {
    if (kind !== "all" && executor.kind !== kind) return false;
    if (term === "") return true;
    const copy = displayCopy(executor);
    return `${copy.name} ${copy.description} ${executorKindLabel(executor.kind, t)}`
      .toLocaleLowerCase()
      .includes(term);
  });
  const SelectedIcon = selected === undefined ? UsersThree : executorIcon(selected.kind);

  const close = () => {
    setOpen(false);
    setSearch("");
    setKind("all");
    props.onTouched?.();
  };

  return (
    <>
      <button
        className="mission-executor-field-trigger"
        type="button"
        data-automation-field="executor"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        onClick={() => setOpen(true)}
      >
        <SelectedIcon size={18} aria-hidden="true" />
        <span>
          <strong>{selectedCopy?.name ?? t("chooseResource")}</strong>
          <small>
            {selected === undefined
              ? tStudio("automationExecutorEmptyDescription")
              : `${executorKindLabel(selected.kind, t)} · ${selectedCopy?.description ?? ""}`}
          </small>
        </span>
        <CaretDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <Dialog
          className="mission-executor-dialog"
          title={t("chooseMissionExecutor")}
          description={tStudio("automationExecutorPickerDescription")}
          onCancel={close}
          footer={
            <button className="secondary-button" type="button" onClick={close}>
              {t("common:actions.cancel")}
            </button>
          }
        >
          <label className="mission-executor-dialog-search">
            <MagnifyingGlass size={17} aria-hidden="true" />
            <span className="sr-only">{t("searchExecutors")}</span>
            <input
              data-dialog-initial-focus
              value={search}
              placeholder={t("searchExecutors")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div
            className="mission-executor-kind-filter"
            role="group"
            aria-label={t("filterExecutorKind")}
          >
            {(["all", "expert", "team", "flow"] as const).map((candidate) => (
              <button
                className={candidate === kind ? "is-active" : ""}
                type="button"
                aria-pressed={candidate === kind}
                key={candidate}
                onClick={() => setKind(candidate)}
              >
                {candidate === "all" ? t("allKinds") : executorKindLabel(candidate, t)}
              </button>
            ))}
          </div>
          <div className="mission-executor-dialog-results" role="listbox">
            {visibleExecutors.map((executor) => {
              const Icon = executorIcon(executor.kind);
              const isSelected = executor.ref === props.value;
              const copy = displayCopy(executor);
              return (
                <button
                  className={
                    isSelected
                      ? "mission-executor-dialog-row is-selected"
                      : "mission-executor-dialog-row"
                  }
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  key={executor.ref}
                  onClick={() => {
                    props.onChange(executor.ref);
                    close();
                  }}
                >
                  <span className="mission-executor-dialog-icon">
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{copy.name}</strong>
                    <small>{copy.description || executor.ref}</small>
                  </span>
                  <span className="mission-executor-dialog-kind">
                    {executorKindLabel(executor.kind, t)}
                  </span>
                  <Check className="mission-executor-dialog-check" size={15} aria-hidden="true" />
                </button>
              );
            })}
            {visibleExecutors.length === 0 ? (
              <p className="mission-executor-dialog-empty">
                <strong>{t("noExecutors")}</strong>
                <span>{t("tryAnother")}</span>
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function executorIcon(kind: MissionExecutorOption["kind"]) {
  return kind === "expert" ? User : kind === "team" ? UsersThree : GitBranch;
}

function executorKindLabel(
  kind: MissionExecutorOption["kind"],
  t: (key: string) => string,
): string {
  return kind === "expert" ? t("expert") : kind === "team" ? t("expertTeam") : t("flow");
}
