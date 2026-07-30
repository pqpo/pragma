import claudeIcon from "@lobehub/icons-static-svg/icons/claude-color.svg";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import { TerminalWindow } from "@phosphor-icons/react";

import type { DesktopRuntimeAvailability } from "../../../shared/contracts/index.ts";
import pragmaIcon from "../assets/pragma-icon.png";
import qoderIcon from "../assets/qoder.svg";

type RuntimeLogoIdentity = Pick<DesktopRuntimeAvailability, "id" | "kind" | "adapter">;

export function RuntimeLogo({
  runtime,
  className,
}: {
  readonly runtime: RuntimeLogoIdentity;
  readonly className?: string;
}) {
  const icon = runtimeBrandLogo(runtime);
  const classes = className ? `runtime-logo ${className}` : "runtime-logo";

  return icon ? (
    <img className={classes} src={icon} alt="" aria-hidden="true" draggable={false} />
  ) : (
    <TerminalWindow className={classes} aria-hidden="true" />
  );
}

export function hasRuntimeBrandLogo(runtime: RuntimeLogoIdentity): boolean {
  return runtimeBrandLogo(runtime) !== undefined;
}

function runtimeBrandLogo(runtime: RuntimeLogoIdentity): string | undefined {
  if (
    runtime.id === "pi" ||
    runtime.kind === "cloud-pi-agent" ||
    runtime.adapter?.id === "pragma.runtime.pi"
  ) {
    return pragmaIcon;
  }
  if (
    runtime.id === "codex" ||
    runtime.kind === "codex-local" ||
    runtime.adapter?.id === "pragma.runtime.codex"
  ) {
    return openaiIcon;
  }
  if (
    runtime.id === "claude-code" ||
    runtime.kind === "claude-code-local" ||
    runtime.adapter?.id === "pragma.runtime.claude-code"
  ) {
    return claudeIcon;
  }
  if (
    runtime.id === "qodercli" ||
    runtime.kind === "qodercli-local" ||
    runtime.adapter?.id === "pragma.runtime.qodercli"
  ) {
    return qoderIcon;
  }
  return undefined;
}
