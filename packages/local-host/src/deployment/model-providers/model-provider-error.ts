export class ModelProviderStoreError extends Error {
  constructor(
    readonly code:
      | "config_invalid"
      | "migration_required"
      | "provider_not_found"
      | "secret_unavailable"
      | "invalid_base_url"
      | "connection_changed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelProviderStoreError";
  }
}
