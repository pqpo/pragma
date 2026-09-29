export type SteerNotDispatchedReason = "no_active_turn" | "target_changed" | "runtime_unsupported";

/** A steer known not to have been injected, including explicit Runtime rejection. Safe to retry. */
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
