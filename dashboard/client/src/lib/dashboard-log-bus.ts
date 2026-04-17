type BatchHandler = (lines: string[], replay: boolean) => void;

const handlers = new Set<BatchHandler>();

export function subscribeDashboardLogBatches(handler: BatchHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitDashboardLogBatch(lines: string[], replay = false): void {
  handlers.forEach((h) => {
    try {
      h(lines, replay);
    } catch {
      // ignore subscriber errors
    }
  });
}
