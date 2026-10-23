import {test,expect} from "@playwright/test";
test.beforeEach(async({page})=>{await page.goto("/tests/ui/fixture.html");});
test("mobile phone, vendor and startup form remain usable and isolate gameplay",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await expect(page.getByRole("button",{name:"Open phone"})).toBeVisible();
  await page.getByRole("button",{name:"Open phone"}).click();
  await page.getByRole("button",{name:"Map",exact:true}).click();
  await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByRole("button",{name:"Hidden robot"})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button",{name:"Counter",exact:true}).click();
  await expect(page.getByRole("button",{name:"Buy",exact:true}).nth(1)).toBeDisabled();
  await page.getByRole("button",{name:"Buy",exact:true}).first().click();
  expect(await page.evaluate(()=>(window as unknown as {events:unknown[]}).events)).toMatchObject([{kind:"gameplay.command",payload:{kind:"buy",itemId:"nozzle",sequence:1}}]);
  await page.keyboard.press("Escape");await page.evaluate(()=>(window as unknown as {ui:{showStartup():void}}).ui.showStartup());
  const entry=page.getByRole("textbox");await entry.fill("w".repeat(150)+" I want to kill myself");await page.getByRole("button",{name:"Start building"}).click();
  await expect(page.locator(".fc-text-feedback")).not.toBeEmpty();
  expect(await page.evaluate(()=>(window as unknown as {events:unknown[]}).events.length)).toBe(1);
  await entry.fill("water delivery");await entry.press("KeyW");
  expect(await page.evaluate(()=>(window as unknown as {ui:{sampleInput():unknown}}).ui.sampleInput())).toEqual({throttle:0,steer:0,brake:0,actions:0});
  await page.getByRole("button",{name:"Start building"}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {events:unknown[]}).events.length)).toBe(2);expect(errors).toEqual([]);
});
test("disposed UI releases input and removes its modal",async({page})=>{
  await page.keyboard.down("KeyW");expect(await page.evaluate(()=>(window as unknown as {ui:{sampleInput():{throttle:number}}}).ui.sampleInput().throttle)).toBe(1);
  await page.evaluate(()=>(window as unknown as {ui:{dispose():void}}).ui.dispose());await expect(page.locator(".fc-ui")).toHaveCount(0);
});
