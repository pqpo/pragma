import type { MailboxMessage } from "@expertmesh/shared";

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

  return {
    async publish<TPayload>(message: MailboxMessage<TPayload>) {
      const deliveries = subscriptions
        .filter((subscription) => subscription.active && matchesFilter(subscription.filter, message))
        .map(async (subscription) => {
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
        });

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
