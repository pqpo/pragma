export interface SignalPort {
  onInterrupt(handler: () => void): () => void;
}

export function createProcessSignalPort(): SignalPort {
  return {
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
  };
}
