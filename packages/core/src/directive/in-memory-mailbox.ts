import type { MailboxMessage } from "@pragma/shared";

import type {
  Mailbox,
  MailboxDeliveryContext,
  MailboxMessageHandler,
  MailboxSubscription,
  MailboxSubscriptionFilter,
} from "./types.ts";

interface SubscriptionEntry {
  readonly filter: MailboxSubscriptionFilter;
  readonly handler: MailboxMessageHandler;
  active: boolean;
}

export function createInMemoryMailbox(): Mailbox {
  const subscriptions: SubscriptionEntry[] = [];
  const consumerGroupOffsets = new Map<string, number>();

  return {
    async publish<TPayload>(message: MailboxMessage<TPayload>) {
      const matchingSubscriptions = subscriptions.filter(
        (subscription) => subscription.active && matchesFilter(subscription.filter, message),
      );
      const deliveries = selectDeliveries(matchingSubscriptions, consumerGroupOffsets).map(
        async (subscription) => {
          let acknowledged = false;
          const context: MailboxDeliveryContext = {
            ack: async () => {
              acknowledged = true;
            },
          };

          await subscription.handler(message, context);

          if (!acknowledged) {
            await context.ack();
          }
        },
      );

      await Promise.all(deliveries);
    },

    async subscribe(filter, handler): Promise<MailboxSubscription> {
      const entry: SubscriptionEntry = {
        filter,
        handler,
        active: true,
      };
      subscriptions.push(entry);

      return {
        async unsubscribe() {
          entry.active = false;
        },
      };
    },
  };
}

function selectDeliveries(
  subscriptions: readonly SubscriptionEntry[],
  consumerGroupOffsets: Map<string, number>,
): readonly SubscriptionEntry[] {
  const deliveries: SubscriptionEntry[] = [];
  const grouped = new Map<string, SubscriptionEntry[]>();

  for (const subscription of subscriptions) {
    const consumerGroup = subscription.filter.consumerGroup;

    if (consumerGroup === undefined) {
      deliveries.push(subscription);
      continue;
    }

    grouped.set(consumerGroup, [...(grouped.get(consumerGroup) ?? []), subscription]);
  }

  for (const [consumerGroup, candidates] of grouped) {
    const offset = consumerGroupOffsets.get(consumerGroup) ?? 0;
    const selectedIndex = offset % candidates.length;
    const selected = candidates[selectedIndex];

    if (selected !== undefined) {
      deliveries.push(selected);
      consumerGroupOffsets.set(consumerGroup, offset + 1);
    }
  }

  return deliveries;
}

function matchesFilter(filter: MailboxSubscriptionFilter, message: MailboxMessage): boolean {
  if (filter.workflowRunId !== undefined && filter.workflowRunId !== message.workflowRunId) {
    return false;
  }

  if (filter.taskRunId !== undefined && filter.taskRunId !== message.taskRunId) {
    return false;
  }

  if (filter.types !== undefined && !filter.types.includes(message.type)) {
    return false;
  }

  return true;
}
