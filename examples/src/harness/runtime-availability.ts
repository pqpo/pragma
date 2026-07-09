import type { RuntimeAdapter } from "@pragma/core";

export async function exitIfRuntimeUnavailable(runtime: RuntimeAdapter): Promise<void> {
  const availability = await runtime.canUse();

  if (availability.usable) {
    return;
  }

  console.log("Runtime unavailable:");
  console.log(`- runtime: ${runtime.descriptor.displayName} (${runtime.descriptor.id})`);
  console.log(`- reason: ${availability.reason ?? "unknown"}`);
  process.exit(1);
}
