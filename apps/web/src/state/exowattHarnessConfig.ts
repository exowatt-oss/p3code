import { createExowattHarnessConfigEnvironmentAtoms } from "@t3tools/client-runtime/state/exowatt-harness-config";

import { connectionAtomRuntime } from "../connection/runtime";

export const exowattHarnessConfigEnvironment =
  createExowattHarnessConfigEnvironmentAtoms(connectionAtomRuntime);
