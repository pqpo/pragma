import { Entry } from "@napi-rs/keyring";

import type { OsKeychain, OsKeychainHealth } from "./secret-store.ts";

/**
 * Node/Electron Main adapter backed by keyring-rs through N-API.  It deliberately
 * contains no shell fallback: a missing or inaccessible OS keychain is a hard,
 * diagnosable condition rather than an invitation to write a key to disk.
 */
export function createNativeOsKeychain(): OsKeychain {
  const backend = platformBackend();
  return {
    async inspect(): Promise<OsKeychainHealth> {
      if (backend === undefined) {
        return {
          status: "unavailable",
          backend: "unsupported",
          reasonCode: "PLATFORM_UNSUPPORTED",
        };
      }
      try {
        // A real read probes the backend without creating or changing a credential.
        // Entry construction alone only loads N-API and cannot detect a locked keychain.
        new Entry("com.pqpo.pragma.secret-store.probe", "availability").getSecret();
        return { status: "ready", backend };
      } catch (error) {
        return classifyKeychainError(error, backend);
      }
    },
    async get(service, account) {
      const available = await this.inspect();
      if (available.status !== "ready") throw new OsKeychainError(available);
      try {
        const secret = new Entry(service, account).getSecret();
        return secret === null ? null : Uint8Array.from(secret);
      } catch (error) {
        throw new OsKeychainError(classifyKeychainError(error, backend));
      }
    },
    async set(service, account, value) {
      const available = await this.inspect();
      if (available.status !== "ready") throw new OsKeychainError(available);
      try {
        new Entry(service, account).setSecret(value);
      } catch (error) {
        throw new OsKeychainError(classifyKeychainError(error, backend));
      }
    },
    async delete(service, account) {
      const available = await this.inspect();
      if (available.status !== "ready") throw new OsKeychainError(available);
      try {
        new Entry(service, account).deleteCredential();
      } catch (error) {
        throw new OsKeychainError(classifyKeychainError(error, backend));
      }
    },
  };
}

function platformBackend(): Exclude<OsKeychainHealth["backend"], "unsupported"> | undefined {
  if (process.platform === "darwin") return "macos-keychain";
  if (process.platform === "win32") return "windows-credential-manager";
  return undefined;
}

function classifyKeychainError(
  error: unknown,
  backend: Exclude<OsKeychainHealth["backend"], "unsupported"> | undefined,
): OsKeychainHealth {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const selectedBackend = backend ?? "unsupported";
  if (/lock|denied|cancel|interaction|permission|auth/.test(message)) {
    return { status: "locked", backend: selectedBackend, reasonCode: "KEYCHAIN_ACCESS_DENIED" };
  }
  return {
    status: "unavailable",
    backend: selectedBackend,
    reasonCode: "KEYCHAIN_BACKEND_UNAVAILABLE",
  };
}

export class OsKeychainError extends Error {
  constructor(readonly health: OsKeychainHealth) {
    super(`OS keychain is ${health.status} (${health.reasonCode ?? "UNKNOWN"}).`);
    this.name = "OsKeychainError";
  }
}
