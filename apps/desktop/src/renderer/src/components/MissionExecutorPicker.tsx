import { CaretDown, GitBranch, User, UsersThree } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { MissionExecutorOption } from "../../../shared/contracts/index.ts";
import { localizeSystemExpertCopy } from "../lib/system-expert-copy.ts";
import { ExpertAvatar } from "./ExpertAvatar.tsx";
import {
  PragmaResourcePickerDialog,
  type PragmaResourcePickerItem,
} from "./PragmaResourcePickerDialog.tsx";

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
  const selected = props.executors.find((executor) => executor.ref === props.value);
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const displayCopy = (executor: MissionExecutorOption) =>
    localizeSystemExpertCopy(executor, pragmaCopy);
  const selectedCopy = selected === undefined ? undefined : displayCopy(selected);
  const SelectedIcon = selected === undefined ? UsersThree : executorIcon(selected.kind);
  const pickerItems: readonly PragmaResourcePickerItem[] = props.executors.map((executor) => {
    const copy = displayCopy(executor);
    return {
      ref: executor.ref,
      name: copy.name,
      description: copy.description,
      kind: executor.kind,
      avatarId: executor.kind === "flow" ? undefined : executor.avatarId,
      searchTerms: [executor.ref, executorKindLabel(executor.kind, t)],
    };
  });

  const close = () => {
    setOpen(false);
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
        {selected !== undefined && selected.kind !== "flow" ? (
          <ExpertAvatar avatarId={selected.avatarId} team={selected.kind === "team"} size="xs" />
        ) : (
          <SelectedIcon size={18} aria-hidden="true" />
        )}
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
        <PragmaResourcePickerDialog
          title={t("chooseMissionExecutor")}
          description={tStudio("automationExecutorPickerDescription")}
          items={pickerItems}
          selectedRefs={props.value === "" ? [] : [props.value]}
          selectionMode="single"
          searchPlaceholder={t("searchExecutors")}
          footerHint={tStudio("changesImmediate")}
          onSelectedRefsChange={(refs) => props.onChange(refs[0] ?? "")}
          onClose={close}
        />
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
