import {expect,it} from "vitest";
import {buildWorld} from "../../src/sim/world.ts";
import {createInitialState,step} from "../../src/sim/step.ts";
import {createPlayerSystems,gameplaySnapshot} from "../../src/sim/player/adapter.ts";
import {DEFAULT_CATALOG} from "../../src/sim/player/catalog.ts";
import {uiProjection} from "../../src/ui/projection.ts";

it("offers a hill vendor purchase that the authoritative economy accepts",()=>{
  const world=buildWorld([]),site=DEFAULT_CATALOG.sites.find(site=>site.kind==="vendor"&&site.wave===2)!;
  const initial=createInitialState(world,42,["p1"],{x:site.x,z:site.z,heading:0});
  initial.players.p1!.car.y=80;
  const view=uiProjection(initial,"p1",null),item=view.vendor!.find(item=>item.available&&!item.owned&&item.priceCents<=view.cashCents)!;
  expect(view.vendorSiteId).toBe(site.id);expect(item).toBeDefined();
  const bought=step(world,initial,{},[{tick:1,kind:"gameplay.command",playerId:"p1",payload:{sequence:1,kind:"buy",targetId:view.vendorSiteId,itemId:item.id}}],createPlayerSystems());
  expect(gameplaySnapshot({state:bought}).economy.players.p1!.ownedItemIds).toContain(item.id);
  initial.players.p1!.car.speed=3.1;
  expect(uiProjection(initial,"p1",null).vendorSiteId).toBeUndefined();
});
