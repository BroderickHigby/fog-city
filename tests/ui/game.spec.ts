import {test,expect} from "@playwright/test";
import type {} from "../../src/debug.ts";

test("SF scene mounts the gameplay HUD, drives, opens phone, exits and sprays",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/?world=sf&gfx=default&radius=300&pr=1");
  await page.waitForFunction(()=>window.__fogcity?.ready,{},{timeout:150000});
  await expect(page.getByRole("button",{name:"Open phone"})).toBeVisible();
  await expect(page.locator(".fc-stat")).toHaveCount(5);
  await page.screenshot({path:"test-results/sf-hud.png"});
  const before=await page.evaluate(()=>window.__fogcity!.state().players.p1!.car);
  await page.keyboard.down("KeyW");
  // Hold W until the car has really moved (not a frame count: SwiftShader may give only a few ticks).
  await expect.poll(async()=>page.evaluate(([x,z])=>{const c=window.__fogcity!.state().players.p1!.car;return Math.hypot(c.x-x!,c.z-z!);},[before.x,before.z]),{timeout:30000}).toBeGreaterThan(.05);
  await page.keyboard.up("KeyW");await page.keyboard.down("Space");
  await expect.poll(async()=>page.evaluate(()=>Math.abs(window.__fogcity!.state().players.p1!.car.speed)),{timeout:30000}).toBeLessThan(2);
  await page.keyboard.up("Space");
  const after=await page.evaluate(()=>window.__fogcity!.state().players.p1!.car);
  expect(Math.hypot(after.x-before.x,after.z-before.z)).toBeGreaterThan(.01);
  await page.getByRole("button",{name:"Open phone"}).click();await page.getByRole("button",{name:"Map",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();await page.screenshot({path:"test-results/sf-phone.png"});await page.keyboard.press("Escape");
  await page.keyboard.press("KeyF");await expect.poll(async()=>page.evaluate(()=>window.__fogcity!.state().players.p1!.mode),{timeout:30000}).toBe("foot");
  const water=await page.evaluate(()=>window.__fogcity!.state().ext.combat?.players.p1?.water??0);expect(water).toBeGreaterThan(0);
  // Water is unlimited (2026-10-23): holding spray fires real particles and the tank never drops.
  await page.keyboard.down("KeyE");await expect.poll(async()=>page.evaluate(()=>(window.__fogcity!.state().ext.combat?.projectiles??[]).filter(p=>p.kind==="water"&&p.ownerId==="p1").length),{timeout:30000}).toBeGreaterThan(0);
  expect(await page.evaluate(()=>window.__fogcity!.state().ext.combat?.players.p1?.water)).toBe(water);await expect(page.locator(".fc-cluster")).toContainText("∞");
  await page.screenshot({path:"test-results/sf-spray.png"});await page.keyboard.up("KeyE");
  expect(errors).toEqual([]);
});
