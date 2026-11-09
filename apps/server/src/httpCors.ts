import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

// Exowatt: the peer-environments routes (PUT upsert, DELETE remove) are called
// cross-origin from the desktop renderer, so the preflight must allow them too.
// These endpoints still require an `access:write` bearer, so widening the allowed
// methods doesn't let an arbitrary origin act without a valid credential.
export const browserApiCorsAllowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;
