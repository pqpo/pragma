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
  ) {
    super(message);
    this.name = "MissionStoreError";
  }
}
