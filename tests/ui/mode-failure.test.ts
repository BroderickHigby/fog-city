import {expect,it} from "vitest";
import {modeFailureText} from "../../src/ui/modes.ts";
import {uiText} from "../../src/content/ui.ts";
it("explains a missing arena refill without exposing internal error messages",()=>{
  const missing=Object.assign(new Error("internal geometry detail"),{reason:"refill"});
  expect(modeFailureText(missing,uiText)).toBe("Move near a hydrant or fountain and try again.");
  expect(modeFailureText(new Error("internal path"),uiText)).toBe(uiText("ui.common.error"));
});
