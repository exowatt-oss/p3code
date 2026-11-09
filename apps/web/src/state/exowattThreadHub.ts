import { createExowattThreadHubEnvironmentAtoms } from "@t3tools/client-runtime/state/exowatt-thread-hub";

import { connectionAtomRuntime } from "../connection/runtime";

export const exowattThreadHubEnvironment =
  createExowattThreadHubEnvironmentAtoms(connectionAtomRuntime);
