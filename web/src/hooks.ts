import { useEffect, useState } from "react";
import type { SyncClient, SyncSnapshot } from "./lib/sync";

export function useSync(client: SyncClient | null): SyncSnapshot | null {
  const [snap, setSnap] = useState<SyncSnapshot | null>(null);
  useEffect(() => {
    if (!client) return;
    return client.subscribe(setSnap);
  }, [client]);
  return snap;
}
