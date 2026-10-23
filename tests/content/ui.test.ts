import { describe,expect,it } from "vitest";
import { UI_COPY,uiText } from "../../src/content/ui.ts";

describe("shared UI copy",()=>{
  it("covers the shipped HUD, controls and later-wave interfaces",()=>{
    for(const key of ["ui.brand","ui.hud.water","ui.hud.scanConfidence","ui.phone.map","ui.phone.botBounty","ui.vendor.buy","ui.signup.label","ui.text.blocked","ui.save.export","ui.lobby.join","ui.match.report","ui.royale.phase","ui.hide.tasks","ui.vibes.vote"])expect(uiText(key,{confidence:98,phase:1})).not.toBe("");
    expect(Object.isFrozen(UI_COPY)).toBe(true);
  });
  it("substitutes only named parameters and keeps text as text",()=>{
    expect(uiText("ui.hud.scanConfidence",{confidence:98})).toBe("98% confidence");
    expect(uiText("ui.vendor.requires",{item:"<b>Tank I</b>"})).toBe("Requires <b>Tank I</b>.");
    expect(()=>uiText("ui.not.present")).toThrow(/Unknown/);
    expect(()=>uiText("ui.hud.scanConfidence")).toThrow(/parameter/);
    expect(()=>uiText("ui.hud.scanConfidence",{confidence:NaN})).toThrow(/parameter/);
  });
});
