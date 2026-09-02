"use client";

import type { HealthResponse } from "@pragma/shared";
import { useEffect, useState } from "react";

import { getServerHealth } from "./server-health.ts";

export function HealthPanel() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getServerHealth()
      .then((response) => {
        if (!cancelled) {
          setHealth(response);
        }
      })
      .catch((unknownError: unknown) => {
        if (!cancelled) {
          setError(unknownError instanceof Error ? unknownError.message : "Unknown health error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return <p className="health healthError">Server health unavailable: {error}</p>;
  }

  return (
    <p className="health">
      Server health: <strong>{health?.status ?? "loading"}</strong>
    </p>
  );
}
