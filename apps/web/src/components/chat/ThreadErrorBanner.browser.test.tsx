import "../../index.css";

import { expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

const expandButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Show full error" || button.textContent === "Show less",
  ) ?? null;

// exowatt: #72 long gateway/model errors stay readable in full instead of being clamped for good.
it("offers to expand long errors instead of clamping them for good", async () => {
  const longError = `Phi model request failed (exowatt/fable): 400: ${"tools.0.custom.strict: Extra inputs are not permitted. ".repeat(6)}`;
  await using screen = await render(<ThreadErrorBanner error={longError} />);
  const { container } = screen;

  const button = expandButton(container);
  expect(button).not.toBeNull();
  expect(button?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".line-clamp-3")?.textContent).toBe(longError);

  await act(() => button?.click());
  expect(expandButton(container)?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".line-clamp-3")).toBeNull();
  expect(container.textContent).toContain(longError);

  await screen.rerender(<ThreadErrorBanner error="Aborted" />);
  expect(expandButton(container)).toBeNull();
});
