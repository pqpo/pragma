import { Brain, Robot } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { DesktopRuntimeModel, MissionModelOverride } from "../../../shared/desktop-api.ts";

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

  return (
    <>
      <label className="mission-compact-select mission-model-select">
        <Robot size={16} aria-hidden="true" />
        <select
          aria-label={t("modelOverride")}
          value={valueKey}
          disabled={props.loading || props.disabled}
          onChange={(event) => {
            const option = props.models.find(
              (model) => modelOptionKey(model.provider.id, model.id) === event.target.value,
            );
            props.onChange(
              option === undefined
                ? undefined
                : { providerId: option.provider.id, modelId: option.id },
            );
          }}
        >
          <option value="">{defaultModelLabel}</option>
          {props.models.map((model) => (
            <option
              key={modelOptionKey(model.provider.id, model.id)}
              value={modelOptionKey(model.provider.id, model.id)}
            >
              {model.provider.displayName} · {model.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="mission-compact-select mission-thinking-select">
        <Brain size={16} aria-hidden="true" />
        <select
          aria-label={t("thinkingDepth")}
          value={props.value?.thinkingLevel ?? ""}
          disabled={props.disabled || props.value === undefined || thinkingLevels.length === 0}
          onChange={(event) => {
            if (props.value === undefined) return;
            const thinkingLevel = event.target.value;
            props.onChange({
              providerId: props.value.providerId,
              modelId: props.value.modelId,
              ...(thinkingLevel === "" ? {} : { thinkingLevel }),
            });
          }}
        >
          <option value="">{defaultThinkingOptionLabel}</option>
          {thinkingLevels.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function modelOptionKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}
