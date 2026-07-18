import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App.tsx";
import { setDesktopLocale } from "./i18n/index.ts";
import "./styles.css";

async function start(): Promise<void> {
  try {
    const settings = await window.pragmaDesktop.getDesktopSettings();
    await setDesktopLocale(settings.resolvedLocale);
  } catch {
    await setDesktopLocale("en");
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
