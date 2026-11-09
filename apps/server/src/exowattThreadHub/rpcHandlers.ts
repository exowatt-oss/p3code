/**
 * Exowatt: the thread Hub overlay's WebSocket RPC handlers, kept next to the
 * store so `ws.ts` only wraps them in its observers and tests can serve them
 * through `RpcTest` without the whole socket layer.
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { ExowattThreadHubStore } from "./ExowattThreadHubStore.ts";

export const makeThreadHubRpcHandlers = (store: ExowattThreadHubStore["Service"]) => ({
  [WS_METHODS.exowattThreadHubGet]: store.get,
  [WS_METHODS.exowattThreadHubSubscribe]: store.subscribe,
  [WS_METHODS.exowattThreadHubUpsert]: store.upsert,
  [WS_METHODS.exowattThreadHubDelete]: store.delete,
});
