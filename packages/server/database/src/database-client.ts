export interface DatabaseClient {
  readonly kind: "placeholder";
}

export const createDatabaseClient = (): DatabaseClient => ({
  kind: "placeholder"
});
