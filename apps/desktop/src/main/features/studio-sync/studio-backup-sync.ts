export type BackupSourceConfiguration = {
  readonly remote: string;
  readonly branch?: string | undefined;
};

export type BackupProviderHead<Repository> = {
  readonly revision?: string | undefined;
  readonly reference?: string | undefined;
  readonly repository: Repository;
};

export interface StudioBackupProvider<Repository, PublishExtension extends object = object> {
  readHead(): Promise<BackupProviderHead<Repository>>;
  publish(
    input: {
      readonly expectedRevision?: string | undefined;
      readonly repository: Repository;
      readonly message: string;
    } & PublishExtension,
  ): Promise<
    | { readonly status: "published"; readonly revision: string }
    | { readonly status: "head_changed" }
  >;
}

/** A provider revision is only meaningful inside this stable source identity. */
export function backupSourceKey(configuration: BackupSourceConfiguration): string {
  return JSON.stringify([
    canonicalBackupRemote(configuration.remote),
    configuration.branch ?? null,
  ]);
}

export function canonicalBackupRemote(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export function sourceChanged(
  storedSourceKey: string | undefined,
  configuration: BackupSourceConfiguration,
): boolean {
  return storedSourceKey !== backupSourceKey(configuration);
}

export function resolvedReferenceChanged(
  storedReference: string | undefined,
  currentReference: string | undefined,
): boolean {
  return (
    storedReference !== undefined &&
    currentReference !== undefined &&
    storedReference !== currentReference
  );
}
