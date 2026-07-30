import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { serializeRendererError } from "../lib/renderer-log.ts";

export type DesktopFatalErrorCode =
  | "DESKTOP_BRIDGE_UNAVAILABLE"
  | "DESKTOP_COMPONENT_VERSION_MISMATCH"
  | "RENDERER_STARTUP_FAILURE";

export function DesktopFatalError(props: {
  readonly code: DesktopFatalErrorCode;
  readonly onReload?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const copyKey = {
    DESKTOP_BRIDGE_UNAVAILABLE: "startupFailure.bridge",
    DESKTOP_COMPONENT_VERSION_MISMATCH: "startupFailure.version",
    RENDERER_STARTUP_FAILURE: "startupFailure.renderer",
  }[props.code];
  const reload = props.onReload ?? (() => window.location.reload());

  return (
    <main className="desktop-fatal-error" role="alert">
      <div className="window-drag-region" aria-hidden="true" />
      <section className="desktop-fatal-error-card">
        <div className="desktop-fatal-error-mark" aria-hidden="true">
          P
        </div>
        <p className="desktop-fatal-error-eyebrow">{t("startupFailure.eyebrow")}</p>
        <h1>{t(`${copyKey}.title`)}</h1>
        <p className="desktop-fatal-error-description">{t(`${copyKey}.description`)}</p>
        <p className="desktop-fatal-error-hint">{t("startupFailure.logHint")}</p>
        <code>{t("startupFailure.diagnosticCode", { code: props.code })}</code>
        <button className="primary-button" type="button" onClick={reload}>
          {t("startupFailure.reload")}
        </button>
      </section>
    </main>
  );
}

interface DesktopErrorBoundaryProps {
  readonly children: ReactNode;
}

interface DesktopErrorBoundaryState {
  readonly failed: boolean;
}

export class DesktopErrorBoundary extends Component<
  DesktopErrorBoundaryProps,
  DesktopErrorBoundaryState
> {
  override readonly state: DesktopErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): DesktopErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    window.pragmaDesktop?.reportRendererLog({
      level: "error",
      event: "renderer.crashed",
      message: "Desktop renderer crashed.",
      ...serializeRendererError(error, info.componentStack ?? undefined),
    });
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <DesktopFatalError code="RENDERER_STARTUP_FAILURE" />;
    }
    return this.props.children;
  }
}
