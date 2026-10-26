import {test,expect} from "@playwright/test";
test.beforeEach(async({page})=>{await page.goto("/tests/ui/fixture.html");});
test("compass follows heading and the clearly labelled map opens without hiding below app tiles",async({page})=>{
  await expect(page.getByRole("img",{name:"Compass: N · 000°",exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const w=window as unknown as {view:import("../../src/ui/types.ts").UiView;ui:{update(v:import("../../src/ui/types.ts").UiView):void}};
    w.ui.update({...w.view,heading:Math.PI/2});
  });
  await expect(page.getByRole("img",{name:"Compass: E · 090°",exact:true})).toBeVisible();
  const open=page.getByRole("button",{name:"Open map (M)",exact:true});await open.click();
  await expect(page.getByRole("dialog",{name:"Map",exact:true})).toBeVisible();
  await expect(page.locator(".fc-phone-apps")).toBeHidden();
  const map=page.getByRole("application",{name:"Map",exact:true});await expect(map).toBeVisible();
  const rect=await map.boundingBox();expect(rect!.height).toBeGreaterThan(250);expect(Math.abs(rect!.height-rect!.width)).toBeLessThan(2);
  expect(rect!.y+rect!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole("button",{name:"Phone apps",exact:true}).click();await expect(page.locator(".fc-phone-apps")).toBeVisible();
  await page.keyboard.press("Escape");await expect(open).toBeFocused();
  await page.keyboard.press("KeyM");await expect(map).toBeVisible();await page.keyboard.press("KeyM");await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("expanded map fits the real game canvas styles on desktop",async({page})=>{
  await page.setViewportSize({width:960,height:600});
  await page.getByRole("button",{name:"Open map (M)",exact:true}).click();
  const box=await page.getByRole("application",{name:"Map",exact:true}).boundingBox();
  expect(box!.width).toBeGreaterThan(300);expect(Math.abs(box!.width-box!.height)).toBeLessThan(2);
  expect(box!.y+box!.height).toBeLessThanOrEqual(600);
});
test("compass and map stay on screen in short touch landscape",async({page})=>{
  await page.setViewportSize({width:667,height:375});
  for(const selector of [".fc-compass",".fc-minimap"]){const box=await page.locator(selector).boundingBox();expect(box).not.toBeNull();expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.y+box!.height).toBeLessThanOrEqual(375);expect(box!.x+box!.width).toBeLessThanOrEqual(667);}
  await page.getByRole("button",{name:"Open map (M)",exact:true}).click();await expect(page.getByRole("application",{name:"Map",exact:true})).toBeVisible();
});
test("gamepad can reach map zoom controls after the map header",async({page})=>{
  await page.evaluate(()=>{const pad={connected:true,axes:[0,0],buttons:Array.from({length:16},()=>({pressed:false,value:0}))};Object.assign(window,{padHarness:pad});Object.defineProperty(navigator,"getGamepads",{configurable:true,value:()=>[pad]});});
  await page.getByRole("button",{name:"Open map (M)",exact:true}).click();await page.getByRole("button",{name:"Phone apps",exact:true}).focus();
  const down=async()=>{for(const pressed of [true,false])await page.evaluate(async value=>{const w=window as unknown as {padHarness:{buttons:{pressed:boolean;value:number}[]}};w.padHarness.buttons[13]={pressed:value,value:value?1:0};await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));},pressed);};
  await down();await expect(page.getByRole("button",{name:"Close",exact:true})).toBeFocused();
  await down();await expect(page.getByRole("button",{name:"Zoom map in",exact:true})).toBeFocused();
});
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
test("the SF map supports keyboard navigation, center activation and focus after waypoint updates",async({page})=>{
  await page.keyboard.press("KeyM");
  const map=page.getByRole("application",{name:"Map",exact:true});await expect(map).toBeVisible();await map.focus();
  await map.press("ArrowRight");await map.press("+");await map.press("Enter");
  expect(await page.evaluate(()=>(window as unknown as {waypoints:unknown[]}).waypoints)).toEqual([{x:80,z:0}]);
  await page.evaluate(()=>{
    const w=window as unknown as {view:import("../../src/ui/types.ts").UiView;ui:{update(view:import("../../src/ui/types.ts").UiView):void}};
    w.ui.update({...w.view,map:{...w.view.map!,waypoint:{x:80,z:0}}});
  });
  await expect(map).toBeFocused();await map.press("ArrowDown");
  await map.evaluate(element=>(element as HTMLElement).click());
  const points=await page.evaluate(()=>(window as unknown as {waypoints:Array<{x:number;z:number}>}).waypoints);
  expect(points).toHaveLength(2);expect(points[1]!.x).toBe(80);expect(points[1]!.z).toBeCloseTo(400/1.5*.2);
  expect(await page.evaluate(()=>(window as unknown as {ui:{sampleInput():unknown}}).ui.sampleInput())).toEqual({throttle:0,steer:0,brake:0,actions:0});
  await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button",{name:"Map (M)",exact:true}).click();await expect(map).toBeVisible();
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
