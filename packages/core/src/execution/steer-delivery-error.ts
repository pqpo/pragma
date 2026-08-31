export type SteerNotDispatchedReason = "no_active_turn" | "target_changed" | "runtime_unsupported";

/** A steer rejected before the Runtime adapter was invoked. It is safe to retain and retry. */
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
