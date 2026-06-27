export interface DatabaseClient {
  readonly kind: "database-client";
}

export const createDatabaseClient = (): DatabaseClient => ({
  kind: "database-client",
});
