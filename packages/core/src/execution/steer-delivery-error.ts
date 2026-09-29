import type { PromptRequest } from "@pragma/shared";

export type SteerNotDispatchedReason = "no_active_turn" | "target_changed" | "runtime_unsupported";

/** A steer known not to have been delivered, including a verified rollback. Safe to retain and retry. */
export class SteerNotDispatchedError extends Error {
  constructor(
    readonly reason: SteerNotDispatchedReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SteerNotDispatchedError";
  }
}

/** The Runtime call started but its delivery result could not be confirmed. */
export class SteerDeliveryUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SteerDeliveryUncertainError";
  }
}

export function hasUnresolvedSteerDelivery(prompts: readonly PromptRequest[]): boolean {
  return prompts.some(
    (prompt) =>
      prompt.status !== "cancelled" &&
      (prompt.deliveryAttempt?.state === "dispatching" ||
        prompt.deliveryAttempt?.state === "uncertain"),
  );
}
export function hasUncertainSteerDelivery(prompts: readonly PromptRequest[]): boolean {
  return prompts.some(
    (prompt) => prompt.status !== "cancelled" && prompt.deliveryAttempt?.state === "uncertain",
  );
}
