import { Hand, ShieldCheck, ShieldWarning, TerminalWindow } from "@phosphor-icons/react";
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
  readonly detailed?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  const { t } = useTranslation("settings");
  const options: readonly SelectMenuOption<DesktopToolPermissionMode>[] = MODES.map((mode) => ({
    value: mode,
    label: t(`general.toolPermissionModes.${mode}.label`),
    ...(props.detailed
      ? {
          description: t(`general.toolPermissionModes.${mode}.description`),
          icon: permissionModeIcon(mode, 24),
          className: mode === "full-access" ? "is-full-access" : undefined,
        }
      : {}),
  }));
  return (
    <SelectMenu
      ariaLabel={t("general.toolPermissions")}
      align={props.detailed ? "start" : "end"}
      className={[
        "tool-permission-select",
        props.detailed ? "is-detailed" : "",
        props.value === "full-access" ? "is-full-access" : "",
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={props.disabled}
      icon={
        props.detailed ? (
          permissionModeIcon(props.value, 18)
        ) : (
          <ShieldCheck size={16} aria-hidden="true" />
        )
      }
      menuClassName={props.detailed ? "tool-permission-menu" : undefined}
      menuMinWidth={props.detailed ? 360 : undefined}
      options={options}
      placement={props.detailed ? "top" : undefined}
      title={props.title}
      value={props.value}
      onChange={(value) => props.onChange?.(value)}
    />
  );
}

function permissionModeIcon(mode: DesktopToolPermissionMode, size: number) {
  const iconProps = { size, "aria-hidden": true } as const;
  switch (mode) {
    case "request-approval":
      return <Hand {...iconProps} />;
    case "auto-approve":
      return <TerminalWindow {...iconProps} />;
    case "full-access":
      return <ShieldWarning {...iconProps} />;
  }
}
