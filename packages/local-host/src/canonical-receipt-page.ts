import {
  RuntimeUsageObservedSchema,
  type CanonicalEventPage,
  type CanonicalEventReadItem,
} from "@pragma/core";
import { ExecutionEventSchema } from "@pragma/shared";

/** Receipt custody needs accounting/terminal facts, not tool output or conversation bodies.
 * Invalid sources remain intact for durable quarantine. The original feed is unchanged.
 */
export function canonicalReceiptPage(
  page: CanonicalEventPage,
  terminal: boolean,
): CanonicalEventPage {
  const items: CanonicalEventReadItem[] = [];
  for (const item of page.items) {
    if (item.kind !== "event") {
      items.push(item);
      continue;
    }
    if (item.event.topic !== "pragma.execution.event.committed") continue;
    const parsed = ExecutionEventSchema.safeParse(item.event.payload);
    if (!parsed.success) {
      items.push(item);
      continue;
    }
    const event = parsed.data;
    let data: unknown;
    if (event.type === "runtime.usage.observed") {
      const usage = RuntimeUsageObservedSchema.safeParse(event.data);
      data = usage.success ? usage.data : event.data;
    } else if (
      terminal &&
      [
        "execution.succeeded",
        "execution.failed",
        "execution.cancelled",
        "execution.interrupted",
      ].includes(event.type)
    ) {
      data = null;
    } else continue;
    items.push({ ...item, event: { ...item.event, relatedRefs: [], payload: { ...event, data } } });
  }
  return { items, nextCursor: page.nextCursor };
}
