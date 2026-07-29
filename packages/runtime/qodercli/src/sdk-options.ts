import {
  accessToken,
  accessTokenFromEnv,
  qodercliAuth,
  type AuthOptions,
} from "@qoder-ai/qoder-agent-sdk";

import type { QoderCliRuntimeAdapterOptions } from "./types.ts";

export function resolveQoderAuth(options: QoderCliRuntimeAdapterOptions): AuthOptions {
  if (options.auth?.type === "access-token") return accessToken(options.auth.token);
  if (options.auth?.type === "access-token-env") {
    return accessTokenFromEnv(options.auth.envVar);
  }
  if (options.auth?.type === "qodercli") return qodercliAuth();

  const token = options.env?.["QODER_PERSONAL_ACCESS_TOKEN"];
  return token !== undefined && token.trim() !== ""
    ? accessTokenFromEnv()
    : qodercliAuth();
}
