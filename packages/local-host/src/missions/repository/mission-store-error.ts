export class MissionStoreError extends Error {
  constructor(
    readonly code:
      | "mission_not_found"
      | "mission_active"
      | "unsupported_schema"
      | "timeline_invalid"
      | "projection_invalid"
      | "message_conflict"
      | "config_invalid",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MissionStoreError";
  }
}

/** Attachment files or their journal have committed and need storage replay. */
export class MissionAttachmentWritePendingError extends Error {
  constructor(options: ErrorOptions) {
    super("Mission attachment write is pending durable replay.", options);
    this.name = "MissionAttachmentWritePendingError";
  }
}
