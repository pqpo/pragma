import { useState } from "react";
import { useTranslation } from "react-i18next";

export const FLOW_TIMEOUT_UNITS = ["seconds", "minutes", "hours", "days"] as const;
export type FlowTimeoutUnit = (typeof FLOW_TIMEOUT_UNITS)[number];

const FLOW_TIMEOUT_UNIT_MILLISECONDS: Readonly<Record<FlowTimeoutUnit, number>> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const FLOW_TIMEOUT_UNIT_LABELS = {
  seconds: "flowTimeoutSeconds",
  minutes: "flowTimeoutMinutes",
  hours: "flowTimeoutHours",
  days: "flowTimeoutDays",
} as const;

export function FlowTimeoutField(props: {
  readonly timeoutMs: number | undefined;
  readonly onChange: (timeoutMs: number | undefined) => void;
}) {
  const { t } = useTranslation("studio");
  const [unit, setUnit] = useState<FlowTimeoutUnit>(() => flowTimeoutUnit(props.timeoutMs));
  const timeoutMs = props.timeoutMs;
  const neverExpires = timeoutMs === undefined;

  return (
    <div className="flow-inspector-field flow-timeout-field">
      <span>{t("flowTimeout")}</span>
      {timeoutMs === undefined ? null : (
        <div className="flow-timeout-control">
          <input
            type="number"
            min={1}
            step="any"
            aria-label={t("flowTimeoutValue")}
            value={flowTimeoutValue(timeoutMs, unit)}
            onChange={(event) => {
              const timeoutMs = flowTimeoutMilliseconds(Number(event.target.value), unit);
              if (timeoutMs !== undefined) props.onChange(timeoutMs);
            }}
          />
          <select
            aria-label={t("flowTimeoutUnit")}
            value={unit}
            onChange={(event) => {
              const nextUnit = event.target.value as FlowTimeoutUnit;
              const nextTimeoutMs = flowTimeoutMilliseconds(
                flowTimeoutValue(timeoutMs, unit),
                nextUnit,
              );
              setUnit(nextUnit);
              if (nextTimeoutMs !== undefined) props.onChange(nextTimeoutMs);
            }}
          >
            {FLOW_TIMEOUT_UNITS.map((option) => (
              <option key={option} value={option}>
                {t(FLOW_TIMEOUT_UNIT_LABELS[option])}
              </option>
            ))}
          </select>
        </div>
      )}
      <label className="flow-timeout-never">
        <input
          type="checkbox"
          checked={neverExpires}
          onChange={(event) =>
            props.onChange(event.target.checked ? undefined : FLOW_TIMEOUT_UNIT_MILLISECONDS[unit])
          }
        />
        <span>{t("flowNeverExpires")}</span>
      </label>
    </div>
  );
}

export function flowTimeoutUnit(timeoutMs: number | undefined): FlowTimeoutUnit {
  if (timeoutMs === undefined) return "hours";
  for (const unit of ["days", "hours", "minutes"] as const) {
    if (
      timeoutMs >= FLOW_TIMEOUT_UNIT_MILLISECONDS[unit] &&
      timeoutMs % FLOW_TIMEOUT_UNIT_MILLISECONDS[unit] === 0
    ) {
      return unit;
    }
  }
  return "seconds";
}

export function flowTimeoutValue(timeoutMs: number, unit: FlowTimeoutUnit): number {
  return timeoutMs / FLOW_TIMEOUT_UNIT_MILLISECONDS[unit];
}

export function flowTimeoutMilliseconds(value: number, unit: FlowTimeoutUnit): number | undefined {
  if (!Number.isFinite(value) || value < 1) return undefined;
  const timeoutMs = Math.round(value * FLOW_TIMEOUT_UNIT_MILLISECONDS[unit]);
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}
