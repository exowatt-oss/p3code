import { createExowattThreadIconsEnvironmentAtoms } from "@t3tools/client-runtime/state/exowatt-thread-icons";

import { connectionAtomRuntime } from "../connection/runtime";

export const exowattThreadIconsEnvironment =
  createExowattThreadIconsEnvironmentAtoms(connectionAtomRuntime);
