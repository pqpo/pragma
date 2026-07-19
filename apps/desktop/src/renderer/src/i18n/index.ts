import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import type { DesktopResolvedLocale } from "../../../shared/desktop-api.ts";
import { en, zhHans, zhHant } from "./resources.ts";

export const localeDisplayNames: Record<DesktopResolvedLocale, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};

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
  ns: ["common", "home", "missions", "studio", "settings"],
  initImmediate: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  showSupportNotice: false,
});

export async function setDesktopLocale(locale: DesktopResolvedLocale): Promise<void> {
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = i18n.dir(locale);
}

export { i18n };
