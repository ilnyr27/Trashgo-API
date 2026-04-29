// SSE client registry — maps userId to a set of write functions
type SSEWriter = (event: { type: string;[key: string]: unknown }) => void;

const clients = new Map<string, Set<SSEWriter>>();

export function addClient(userId: string, writer: SSEWriter): () => void {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(writer);
  return () => {
    clients.get(userId)?.delete(writer);
    if (clients.get(userId)?.size === 0) clients.delete(userId);
  };
}

export function emitToUser(userId: string, event: { type: string;[key: string]: unknown }) {
  const writers = clients.get(userId);
  if (!writers || writers.size === 0) return;
  for (const write of writers) {
    try { write(event); } catch { /* ignore disconnected */ }
  }
}

export function connectedCount(): number {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return total;
}
