// Exowatt distro: the desktop's link reconciler writes links to the user's other environments
// here. Every endpoint needs `access:write`, the bar for minting credentials on this server.
import {
  AuthAccessWriteScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as PeerEnvironments from "./PeerEnvironments.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "exowattPeerEnvironments",
  Effect.fnUntraced(function* (handlers) {
    const peers = yield* PeerEnvironments.PeerEnvironments;

    return handlers
      .handle(
        "list",
        Effect.fn("environment.exowattPeerEnvironments.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* peers.list.pipe(
            Effect.catch((cause) => failEnvironmentInternal("peer_environments_failed", cause)),
          );
        }),
      )
      .handle(
        "upsert",
        Effect.fn("environment.exowattPeerEnvironments.upsert")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* peers.upsert(args.payload).pipe(
            Effect.catchTags({
              PeerEnvironmentsDisabledError: (error) =>
                Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
              PeerEnvironmentInvalidLinkError: (error) =>
                Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
              PeerEnvironmentsStoreError: (cause) =>
                failEnvironmentInternal("peer_environments_failed", cause),
            }),
          );
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.exowattPeerEnvironments.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          return yield* peers
            .remove(args.params.environmentId)
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("peer_environments_failed", cause)),
            );
        }),
      );
  }),
);
