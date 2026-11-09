import * as NodeModule from "node:module";

// A Node single executable cannot import file-backed ESM packages from beside
// its embedded module graph. fff-node remains on disk because it loads a native
// binary, so the SEA bundle aliases the normal ESM import to this require shim.
const { FileFinder } = NodeModule.createRequire(import.meta.url)(
  "@ff-labs/fff-node",
) as typeof import("@ff-labs/fff-node");

export { FileFinder };
