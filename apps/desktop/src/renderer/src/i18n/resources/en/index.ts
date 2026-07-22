import type { TranslationShape } from "../../types.ts";

import { common } from "./common.ts";
import { home } from "./home.ts";
import { settings } from "./settings.ts";
import { missions } from "./missions.ts";
import { studio } from "./studio.ts";

export const en = {
  common,
  home,
  settings,
  missions,
  studio,
} as const;

export type DesktopTranslationResource = TranslationShape<typeof en>;
