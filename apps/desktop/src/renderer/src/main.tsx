import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App.tsx";
import {
  DesktopErrorBoundary,
  DesktopFatalError,
  type DesktopFatalErrorCode,
} from "./components/DesktopFatalError.tsx";
import { setDesktopLocale } from "./i18n/index.ts";
import { resolveDesktopStartup } from "./lib/desktop-startup.ts";
import { serializeRendererError } from "./lib/renderer-log.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/index.ts";
import "./styles/index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Desktop renderer root element is missing.");
}
const root = ReactDOM.createRoot(rootElement);

async function start(): Promise<void> {
  const bridge = Reflect.get(window, "pragmaDesktop") as PragmaDesktopAPI | undefined;
  const startup = await resolveDesktopStartup(bridge, window.navigator.languages);
  await setDesktopLocale(startup.locale);

  if ("errorCode" in startup) {
    renderFatalError(startup.errorCode);
    return;
  }
  if (startup.settingsError !== undefined) {
    bridge?.reportRendererLog({
      level: "warn",
      event: "renderer.settings_load_failed",
      message: "Desktop settings could not be loaded; using the system locale.",
      ...serializeRendererError(startup.settingsError),
    });
  }

  root.render(
    <React.StrictMode>
      <DesktopErrorBoundary>
        <App />
      </DesktopErrorBoundary>
    </React.StrictMode>,
  );
}

function renderFatalError(code: DesktopFatalErrorCode): void {
  root.render(
    <React.StrictMode>
      <DesktopFatalError code={code} />
    </React.StrictMode>,
  );
}

void start().catch(async (error: unknown) => {
  const bridge = Reflect.get(window, "pragmaDesktop") as PragmaDesktopAPI | undefined;
  bridge?.reportRendererLog({
    level: "error",
    event: "renderer.startup_failed",
    message: "Desktop renderer startup failed.",
    ...serializeRendererError(error),
  });
  try {
    await setDesktopLocale("en");
  } catch (localeError) {
    bridge?.reportRendererLog({
      level: "error",
      event: "renderer.fallback_locale_failed",
      message: "Desktop fallback locale could not be loaded.",
      ...serializeRendererError(localeError),
    });
  }
  renderFatalError("RENDERER_STARTUP_FAILURE");
});
