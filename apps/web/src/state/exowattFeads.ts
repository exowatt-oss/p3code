import { createExowattFeadsEnvironmentAtoms } from "@t3tools/client-runtime/state/exowatt-feads";

import { connectionAtomRuntime } from "../connection/runtime";

export const exowattFeadsEnvironment = createExowattFeadsEnvironmentAtoms(connectionAtomRuntime);
