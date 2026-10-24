import { AutomationBindingSchema } from "../../../../../shared/contracts/automations.ts";
import { AutomationBindingV2Schema } from "../schemas/v2.ts";
export const automationBindingV2ToV3Step = {
  fromVersion: "pragma.automation-binding/v2",
  toVersion: "pragma.automation-binding/v3",
  migrate(input: unknown) {
    const { toolPermissionMode: _retiredMode, ...binding } = AutomationBindingV2Schema.parse(input);
    void _retiredMode;
    return AutomationBindingSchema.parse({
      ...binding,
      schemaVersion: "pragma.automation-binding/v3",
    });
  },
} as const;
