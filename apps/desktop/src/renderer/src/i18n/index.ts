import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import type { DesktopResolvedLocale } from "../../../shared/contracts/index.ts";
import { localeDisplayNames } from "./locale-metadata.ts";
import { en, zhHans, zhHant } from "./resources.ts";

export { localeDisplayNames };

void i18n.use(initReactI18next).init({
  resources: {
    en,
    "zh-Hans": zhHans,
    "zh-Hant": zhHant,
  },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "zh-Hans", "zh-Hant"],
  defaultNS: "common",
  ns: ["common", "home", "missions", "studio", "settings", "usage"],
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export async function setDesktopLocale(locale: DesktopResolvedLocale): Promise<void> {
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = i18n.dir(locale);
}

export { i18n };
