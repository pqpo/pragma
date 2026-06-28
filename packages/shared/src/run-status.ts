export const RunStatus = {
  Pending: "PENDING",
  Running: "RUNNING",
  Succeeded: "SUCCEEDED",
  Failed: "FAILED",
  Cancelled: "CANCELLED"
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];
