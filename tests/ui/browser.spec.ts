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
test("IndexedDB preserves progression across a page reload",async({page})=>{
  await page.evaluate(async()=>{
    const path="/src/save/index.ts",module=await import(path);
    const backend=new module.IndexedDbSaveBackend(indexedDB,"fog-city-browser-save-test");
    const store=new module.SaveStore({backends:[backend],contentHash:"test-bundle",validate:(value:unknown)=>value});
    await store.save(0,{wallet:{cashCents:12345,settledModeIds:["round-1"]}});await backend.close();
  });
  await page.reload();
  const data=await page.evaluate(async()=>{
    const path="/src/save/index.ts",module=await import(path);
    const backend=new module.IndexedDbSaveBackend(indexedDB,"fog-city-browser-save-test");
    const store=new module.SaveStore({backends:[backend],contentHash:"test-bundle",validate:(value:unknown)=>value});
    const saved=await store.load(0);await backend.close();return saved?.data;
  });
  expect(data).toEqual({wallet:{cashCents:12345,settledModeIds:["round-1"]}});
});

test("gamepad opens the phone and selects an authored startup answer without leaking held input",async({page})=>{
  await page.evaluate(()=>{
    const pad={connected:true,axes:[0,0],buttons:Array.from({length:16},()=>({pressed:false,value:0}))};
    Object.assign(window,{padHarness:pad});Object.defineProperty(navigator,"getGamepads",{configurable:true,value:()=>[pad]});
  });
  const pad=async(indices:number[])=>page.evaluate(async pressed=>{
    const value=(window as unknown as {padHarness:{buttons:{pressed:boolean;value:number}[]}}).padHarness;
    value.buttons.forEach((button,index)=>{button.pressed=pressed.includes(index);button.value=button.pressed?1:0;});
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  },indices);
  await pad([9]);await expect(page.getByRole("dialog")).toBeVisible();await pad([]);
  await pad([9]);await expect(page.getByRole("dialog")).toHaveCount(0);await pad([]);
  await page.evaluate(()=>(window as unknown as {ui:{showStartup():void}}).ui.showStartup());
  await pad([13]);await expect(page.getByRole("button",{name:"Start building"})).toBeFocused();await pad([]);
  await pad([13]);await expect(page.getByRole("button",{name:"Something with robots"})).toBeFocused();await pad([]);
  await pad([0]);await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {events:{payload:{kind:string}}[]}).events.at(-1)?.payload.kind)).toBe("startup-define");
  expect(await page.evaluate(()=>(window as unknown as {ui:{sampleInput():{actions:number}}}).ui.sampleInput().actions)).toBe(0);
  await pad([]);await page.evaluate(()=>(window as unknown as {ui:{sampleInput():unknown}}).ui.sampleInput());
  await pad([0]);expect(await page.evaluate(()=>(window as unknown as {ui:{sampleInput():{actions:number}}}).ui.sampleInput().actions)).not.toBe(0);
});

test("an active mission dialog can be reopened after dismissal",async({page})=>{
  await page.evaluate(()=>{
    const host=window as unknown as {view:object;ui:{update(value:unknown):void}};
    host.ui.update({...host.view,interaction:{id:"signup-step",title:"Your desk",detail:"Choose a startup",startup:true,choices:[]}});
  });
  await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".fc-objective").getByRole("button",{name:"Continue"}).click();await expect(page.getByRole("textbox")).toBeVisible();
  await page.keyboard.press("Escape");await page.getByRole("button",{name:"Open phone"}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Continue",exact:true}).click();await expect(page.getByRole("textbox")).toBeVisible();
});

test("the autosave slot can be explicitly recovered from save settings",async({page})=>{
  await page.evaluate(async()=>{
    const savePath="/src/save/index.ts",panelPath="/src/ui/save-panel.ts",copyPath="/src/content/ui.ts";
    const [{SaveStore,MemorySaveBackend},{mountSavePanel},{uiText}]=await Promise.all([import(savePath),import(panelPath),import(copyPath)]);
    const store=new SaveStore({backends:[new MemorySaveBackend()],contentHash:"test",validate:(value:unknown)=>value});
    await store.save("auto",{wallet:{cashCents:321}});
    const panel=mountSavePanel(document,uiText,{store,capture:()=>({wallet:{cashCents:0}}),restore:(data:unknown)=>Object.assign(window,{recoveredSave:data})});
    panel.element.style.cssText="position:fixed;inset:0;z-index:100;background:white;overflow:auto;pointer-events:auto";document.body.append(panel.element);
  });
  const auto=page.locator(".fc-save-panel [data-slot='auto']");await expect(auto).toBeVisible();
  await expect(auto.getByRole("button",{name:"Save progress",exact:true})).toHaveCount(0);
  await auto.getByRole("button",{name:"Load progress",exact:true}).click();await page.getByRole("button",{name:"Confirm",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {recoveredSave?:unknown}).recoveredSave)).toEqual({wallet:{cashCents:321}});
});
