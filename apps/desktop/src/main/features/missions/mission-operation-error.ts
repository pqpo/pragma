export class MissionOperationError extends Error {
  readonly code = "mission_operation_in_progress";

  constructor() {
    super("Wait for the current mission operation to finish.");
    this.name = "MissionOperationError";
  }
}
