export { MissionV3Schema } from "./schemas/v3.ts";
export { MissionV4Schema } from "./schemas/v4.ts";
export { MissionV5Schema } from "./schemas/v5.ts";
export { MissionV6Schema } from "./schemas/v6.ts";
export { MissionV7Schema } from "./schemas/v7.ts";
export { MissionV8Schema } from "./schemas/v8.ts";
export { MissionV9Schema } from "./schemas/v9.ts";
export { missionV3ToV4Step } from "./steps/v3-to-v4.ts";
export { missionV4ToV5Step } from "./steps/v4-to-v5.ts";
export { missionV5ToV6Step } from "./steps/v5-to-v6.ts";
export { missionV6ToV7Step } from "./steps/v6-to-v7.ts";
export { missionV7ToV8Step } from "./steps/v7-to-v8.ts";
export { missionV8ToV9Step } from "./steps/v8-to-v9.ts";
export { missionV9ToV10Step } from "./steps/v9-to-v10.ts";

import { missionV3ToV4Step } from "./steps/v3-to-v4.ts";
import { missionV4ToV5Step } from "./steps/v4-to-v5.ts";
import { missionV5ToV6Step } from "./steps/v5-to-v6.ts";
import { missionV6ToV7Step } from "./steps/v6-to-v7.ts";
import { missionV7ToV8Step } from "./steps/v7-to-v8.ts";
import { missionV8ToV9Step } from "./steps/v8-to-v9.ts";
import { missionV9ToV10Step } from "./steps/v9-to-v10.ts";

export const MISSION_STORAGE_MIGRATIONS = [
  missionV3ToV4Step,
  missionV4ToV5Step,
  missionV5ToV6Step,
  missionV6ToV7Step,
  missionV7ToV8Step,
  missionV8ToV9Step,
  missionV9ToV10Step,
] as const;
