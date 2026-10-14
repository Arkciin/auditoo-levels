/**
 * React bindings of the sync engine: a context for the client and hooks reading its state with
 * `useSyncExternalStore` (tear-free under concurrent rendering).
 */
import type { Snapshot } from "@repo/shared";
import { createContext, type ReactNode, use, useMemo, useSyncExternalStore } from "react";
import type { SyncClient, SyncState, SyncStatus } from "./sync-client";

const SyncClientContext = createContext<SyncClient | null>(null);

/** Props of {@link SyncProvider}. */
export interface SyncProviderProps {
  readonly client: SyncClient;
  readonly children?: ReactNode;
}

/** Makes `client` available to the hooks below. */
export function SyncProvider({ client, children }: SyncProviderProps) {
  return <SyncClientContext value={client}>{children}</SyncClientContext>;
}

/** The client provided by the closest {@link SyncProvider}. */
export function useSyncClient(): SyncClient {
  const client = use(SyncClientContext);
  if (!client) throw new Error("useSyncClient must be used inside a <SyncProvider>");
  return client;
}

/** The whole state; re-renders on every change (prefer the narrower hooks). */
export function useSyncState(): SyncState {
  const client = useSyncClient();
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}

/** Sync health only: does not re-render when just the data changes. */
export function useSyncStatus(): SyncStatus {
  const client = useSyncClient();
  const getStatus = () => client.getState().status;
  return useSyncExternalStore(client.subscribe, getStatus, getStatus);
}

/**
 * Derives data from the view, re-rendering only when the result changes. The result is cached
 * per view, so it is stable as long as the view is; selectors returning new objects should be
 * memoized per snapshot, like those of `selectors.ts`:
 *
 * ```tsx
 * const structure = useView((view) => selectStructure(view, propertyId));
 * ```
 */
export function useView<T>(selector: (view: Snapshot) => T): T {
  const client = useSyncClient();
  const getSelection = useMemo(() => {
    let cache: { readonly view: Snapshot; readonly selection: T } | undefined;
    return () => {
      const { view } = client.getState();
      if (cache?.view !== view) cache = { view, selection: selector(view) };
      return cache.selection;
    };
  }, [client, selector]);
  return useSyncExternalStore(client.subscribe, getSelection, getSelection);
}

/** `client.mutate`, already bound: `const mutate = useMutate(); await mutate("renameSpace", …)`. */
export function useMutate(): SyncClient["mutate"] {
  return useSyncClient().mutate;
}
