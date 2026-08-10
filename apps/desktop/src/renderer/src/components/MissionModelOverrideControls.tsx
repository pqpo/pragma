import { Brain, Robot } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { DesktopRuntimeModel, MissionModelOverride } from "../../../shared/contracts/index.ts";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu.tsx";

export function MissionModelOverrideControls(props: {
  readonly models: readonly DesktopRuntimeModel[];
  readonly loading?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly value?: MissionModelOverride | undefined;
  readonly defaultValue?: MissionModelOverride | undefined;
  readonly onChange: (value: MissionModelOverride | undefined) => void;
}) {
  const { t } = useTranslation("missions");
  const valueKey =
    props.value === undefined ? "" : modelOptionKey(props.value.providerId, props.value.modelId);
  const selected = props.models.find(
    (model) => modelOptionKey(model.provider.id, model.id) === valueKey,
  );
  const defaultModel = props.models.find(
    (model) =>
      model.provider.id === props.defaultValue?.providerId &&
      model.id === props.defaultValue.modelId,
  );
  const effectiveModel = selected ?? defaultModel;
  const thinkingLevels = effectiveModel?.thinking?.supportedLevels ?? [];
  const defaultThinkingLevel =
    props.value === undefined
      ? props.defaultValue?.thinkingLevel
      : effectiveModel?.thinking?.defaultLevel;
  const defaultThinkingLabel = thinkingLevels.find(
    (level) => level.value === defaultThinkingLevel,
  )?.label;
  const defaultModelLabel =
    defaultModel === undefined
      ? t("defaultModel")
      : t("defaultValue", {
          value: `${defaultModel.provider.displayName} · ${defaultModel.displayName}`,
        });
  const defaultThinkingOptionLabel =
    defaultThinkingLabel === undefined
      ? t("defaultThinkingDepth")
      : t("defaultValue", { value: defaultThinkingLabel });
  const modelOptions: readonly SelectMenuOption[] = [
    { value: "", label: defaultModelLabel },
    ...props.models.map((model) => ({
      value: modelOptionKey(model.provider.id, model.id),
      label: `${model.provider.displayName} · ${model.displayName}`,
    })),
  ];
  const thinkingOptions: readonly SelectMenuOption[] = [
    { value: "", label: defaultThinkingOptionLabel },
    ...thinkingLevels.map((level) => ({ value: level.value, label: level.label })),
  ];

  return (
    <>
      <SelectMenu
        ariaLabel={t("modelOverride")}
        className="mission-compact-select mission-model-select"
        disabled={props.loading || props.disabled}
        icon={<Robot size={16} aria-hidden="true" />}
        animateOverflowingOptions
        options={modelOptions}
        value={valueKey}
        onChange={(nextValue) => {
          const option = props.models.find(
            (model) => modelOptionKey(model.provider.id, model.id) === nextValue,
          );
          props.onChange(
            option === undefined
              ? undefined
              : { providerId: option.provider.id, modelId: option.id },
          );
        }}
      />
      <SelectMenu
        ariaLabel={t("thinkingDepth")}
        className="mission-compact-select mission-thinking-select"
        disabled={props.disabled || props.value === undefined || thinkingLevels.length === 0}
        icon={<Brain size={16} aria-hidden="true" />}
        options={thinkingOptions}
        value={props.value?.thinkingLevel ?? ""}
        onChange={(thinkingLevel) => {
          if (props.value === undefined) return;
          props.onChange({
            providerId: props.value.providerId,
            modelId: props.value.modelId,
            ...(thinkingLevel === "" ? {} : { thinkingLevel }),
          });
        }}
      />
    </>
  );
}

function modelOptionKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}
