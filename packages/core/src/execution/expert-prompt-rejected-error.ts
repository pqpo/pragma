/** A prompt was explicitly rejected before an acceptance transaction could commit. */
export class ExpertPromptRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExpertPromptRejectedError";
  }
}
