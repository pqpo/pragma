import { useEffect, useRef, useState } from "react";
import { createNavigationAttentionMonitor } from "./navigation-attention-monitor.ts";
import { emptyNavigationAttention } from "./navigation-attention.ts";

export function useNavigationAttention(missionsActive: boolean, memoryEnabled: boolean) {
  const activity = useRef({ missionsActive, memoryEnabled });
  activity.current = { missionsActive, memoryEnabled };
  const monitor = useRef<ReturnType<typeof createNavigationAttentionMonitor> | undefined>(
    undefined,
  );
  const [attention, setAttention] = useState(emptyNavigationAttention);

  useEffect(() => {
    const api = window.pragmaDesktop;
    if (api === undefined) return;
    const instance = createNavigationAttentionMonitor(api, {
      storage: window.localStorage,
      events: window,
      missionsActive: () => activity.current.missionsActive,
      memoryEnabled: () => activity.current.memoryEnabled,
      onChange: setAttention,
    });
    monitor.current = instance;
    return () => {
      instance.dispose();
      monitor.current = undefined;
    };
  }, []);

  useEffect(() => {
    void monitor.current?.refresh();
  }, [memoryEnabled]);

  return { ...attention, memory: memoryEnabled && attention.memory };
}
