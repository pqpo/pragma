import { ShieldCheck } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type { DesktopToolPermissionMode } from "../../../shared/contracts/index.ts";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu.tsx";

const MODES: readonly DesktopToolPermissionMode[] = [
  "request-approval",
  "auto-approve",
  "full-access",
];

export function ToolPermissionSelect(props: {
  readonly className?: string | undefined;
  readonly value: DesktopToolPermissionMode;
  readonly onChange?: ((value: DesktopToolPermissionMode) => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  const { t } = useTranslation("settings");
  const options: readonly SelectMenuOption<DesktopToolPermissionMode>[] = MODES.map((mode) => ({
    value: mode,
    label: t(`general.toolPermissionModes.${mode}.label`),
  }));
  return (
    <SelectMenu
      ariaLabel={t("general.toolPermissions")}
      align="end"
      className={["tool-permission-select", props.className].filter(Boolean).join(" ")}
      disabled={props.disabled}
      icon={<ShieldCheck size={16} aria-hidden="true" />}
      options={options}
      title={props.title}
      value={props.value}
      onChange={(value) => props.onChange?.(value)}
    />
  );
}
