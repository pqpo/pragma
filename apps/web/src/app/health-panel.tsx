"use client";

import { useEffect, useState } from "react";
import { ServerClient, type ExpertMeshClient, type HealthResponse } from "@expertmesh/sdk";

const client: ExpertMeshClient = new ServerClient();

export function HealthPanel() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    client
      .getHealth()
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
