import { assert, describe, it } from "@effect/vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ExowattChunkLoadRecovery,
  isChunkLoadError,
  restartAfterChunkLoadFailure,
} from "./ExowattChunkLoadRecovery";

describe("ExowattChunkLoadRecovery", () => {
  it("renders one restart action instead of a broken route", () => {
    const html = renderToStaticMarkup(createElement(ExowattChunkLoadRecovery));

    assert.include(html, "P3 was updated. Restart to continue.");
    assert.include(html, "Restart P3");
    assert.include(html, 'role="alert"');
  });

  it("recognizes browser and bundler lazy-chunk failures", () => {
    assert.isTrue(
      isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: chunk.js")),
    );
    assert.isTrue(isChunkLoadError(new Error("Loading chunk 417 failed.")));
    assert.isTrue(isChunkLoadError(new Error("ChunkLoadError")));
    assert.isFalse(isChunkLoadError(new Error("The project could not be loaded.")));
  });

  it("restarts the desktop shell when available", async () => {
    let restarted = false;
    let reloaded = false;

    await restartAfterChunkLoadFailure({
      restartApplication: async () => {
        restarted = true;
      },
      reload: () => {
        reloaded = true;
      },
    });

    assert.isTrue(restarted);
    assert.isFalse(reloaded);
  });

  it("reloads when the desktop restart bridge is unavailable or fails", async () => {
    let reloadCount = 0;
    const reload = () => {
      reloadCount += 1;
    };

    await restartAfterChunkLoadFailure({ reload });
    await restartAfterChunkLoadFailure({
      restartApplication: async () => {
        throw new Error("old desktop shell");
      },
      reload,
    });

    assert.equal(reloadCount, 2);
  });
});
