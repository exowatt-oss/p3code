import { expect, it } from "vite-plus/test";
import { PRIVACY_POLICY_URL } from "./legalLinks";

it("does not attach T3 Tools' policy to an unconfigured P3 source build", () => {
  expect(PRIVACY_POLICY_URL).toBeNull();
});
