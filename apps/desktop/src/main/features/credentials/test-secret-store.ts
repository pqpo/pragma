import { createSecretStore, type OsKeychain, type OsKeychainHealth } from "@pragma/local-host";

export class TestKeychain implements OsKeychain {
  readonly entries = new Map<string, Uint8Array>();
  health: OsKeychainHealth = { status: "ready", backend: "macos-keychain" };
  async inspect(): Promise<OsKeychainHealth> { return this.health; }
  async get(service: string, account: string): Promise<Uint8Array | null> { return this.entries.get(`${service}:${account}`) ?? null; }
  async set(service: string, account: string, value: Uint8Array): Promise<void> { this.entries.set(`${service}:${account}`, Uint8Array.from(value)); }
  async delete(service: string, account: string): Promise<void> { this.entries.delete(`${service}:${account}`); }
}

export function createTestSecretStore(root: string, keychain = new TestKeychain()) {
  return { keychain, secretStore: createSecretStore({ root, keychain }) };
}
