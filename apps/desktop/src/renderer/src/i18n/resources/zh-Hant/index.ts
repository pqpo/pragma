import type { DesktopTranslationResource } from "../en/index.ts";

import { common } from "./common.ts";
import { home } from "./home.ts";
import { settings } from "./settings.ts";
import { missions } from "./missions.ts";
import { studio } from "./studio.ts";
import { usage } from "./usage.ts";

export const zhHant = {
  common,
  home,
  settings,
  missions,
  studio,
  usage,
} satisfies DesktopTranslationResource;
