import { ShieldCheck } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { DesktopToolPermissionMode } from "../../../shared/contracts/index.ts";

const MODES: readonly DesktopToolPermissionMode[] = [
  "request-approval",
  "auto-approve",
  "full-access",
];

export function ToolPermissionSelect(props: {
  readonly value: DesktopToolPermissionMode;
  readonly onChange?: ((value: DesktopToolPermissionMode) => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  const { t } = useTranslation("settings");
  return (
    <label className="tool-permission-select" title={props.title}>
      <ShieldCheck size={16} aria-hidden="true" />
      <select
        aria-label={t("general.toolPermissions")}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange?.(event.target.value as DesktopToolPermissionMode)}
      >
        {MODES.map((mode) => (
          <option value={mode} key={mode}>
            {t(`general.toolPermissionModes.${mode}.label`)}
          </option>
        ))}
      </select>
    </label>
  );
}
