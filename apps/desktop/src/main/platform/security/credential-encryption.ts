export interface CredentialEncryption {
  readonly isAvailable: () => boolean;
  readonly encrypt: (plainText: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
}
