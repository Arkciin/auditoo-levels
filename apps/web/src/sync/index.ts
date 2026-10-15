/**
 * Client-side sync engine: offline-first, optimistic, synced with the server by push/pull.
 * See `sync-client.ts` for the model and its guarantees.
 */
export { createBrowserSyncClient } from "./browser";
export {
  describeMutation,
  describeMutationError,
  describePendingMutations,
  describeRejection,
  quote,
  withRooms,
} from "./describe";
export {
  SyncProvider,
  type SyncProviderProps,
  useMutate,
  useSyncClient,
  useSyncState,
  useSyncStatus,
  useView,
} from "./react";
export {
  isLevelLive,
  isSpaceLive,
  type LevelStructure,
  type PropertySummary,
  selectProperties,
  selectProperty,
  selectStructure,
} from "./selectors";
export {
  DEFAULT_DATABASE_NAME,
  type MutationDraft,
  type OpenSyncStorageOptions,
  openSyncStorage,
  StorageClosedError,
  type StoredState,
  type SyncStorage,
} from "./storage";
export {
  DEFAULT_CHANNEL_NAME,
  MAX_RECENT_REJECTIONS,
  type Rejection,
  SyncClient,
  type SyncClientOptions,
  type SyncState,
  type SyncStatus,
} from "./sync-client";
export {
  createHttpTransport,
  HttpError,
  type HttpTransportOptions,
  NetworkError,
  ProtocolError,
  type RequestOptions,
  type Transport,
} from "./transport";
