import { createExowattConnectorsEnvironmentAtoms } from "@t3tools/client-runtime/state/exowatt-connectors";

import { connectionAtomRuntime } from "../connection/runtime";

export const exowattConnectorsEnvironment =
  createExowattConnectorsEnvironmentAtoms(connectionAtomRuntime);
