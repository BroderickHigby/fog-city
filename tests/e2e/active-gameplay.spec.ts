import {test,expect} from '@playwright/test';
import {bootWorld} from './fixtures.ts';
import type {} from '../../src/debug.ts';

test('mouse aim drives the recorded spray direction and audio requires a gesture',async({page})=>{
 const errors=await bootWorld(page,'dev','&gfx=default&pr=0.5');
 await page.keyboard.press('KeyF');await page.waitForFunction(()=>window.__fogcity!.state().players.p1?.mode==='foot');
 await page.getByRole('button',{name:'Start Hot Desk'}).click();
 await page.waitForFunction(()=>!!window.__fogcity!.state().ext.combat);
 await page.mouse.move(430,260);await page.mouse.down();await page.mouse.move(570,200,{steps:8});await page.mouse.up();
 await page.keyboard.down('KeyE');
 await page.waitForFunction(()=>window.__fogcity!.state().ext.combat!.projectiles.some(p=>Math.abs(p.vx)>1&&p.vy>0),null,{timeout:15000});
 await page.keyboard.up('KeyE');
 await expect(page.locator('#combat-feedback')).toBeVisible();
 await page.getByRole('button',{name:/Neon Tide/}).click();await expect(page.locator('#radio')).toContainText('Radio on');
 expect(errors).toEqual([]);
});

test('a checkpoint restores completed missions without restoring active combat',async({page})=>{
 const errors=await bootWorld(page,'dev','&gfx=default&pr=0.5');
 await page.evaluate(async()=>{
  const source='/src/save/checkpoints.ts';const module=await import(/* @vite-ignore */ source);
  const store=new module.BrowserSaveStore();
  await store.save('dev',{version:1,simVersion:window.__fogcity!.state().version,contentId:module.CHECKPOINT_CONTENT,world:'dev',completed:['hot-desk'],cash:500,unlocks:['safehouse:fidi-desk']});
 });
 await page.reload();await page.waitForFunction(()=>window.__fogcity?.ready);
 await expect(page.getByRole('button',{name:/Next: Spill/})).toBeVisible();
 await expect(page.locator('#checkpoint-status')).toContainText('restored');
 const state=await page.evaluate(()=>window.__fogcity!.state());
 expect(state.ext.combat?.projectiles??[]).toEqual([]);
 expect(state.ext.combat?.players.p1?.water??8).toBe(8);
 expect((state.ext.missions as unknown as {players:{p1:{cash:number;threat:number;completed:string[]}}}).players.p1).toMatchObject({cash:500,threat:0,completed:['hot-desk']});
 expect(errors).toEqual([]);
});

test('blocked browser storage does not prevent play',async({page})=>{
 await page.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Storage disabled','SecurityError');}}));
 const errors=await bootWorld(page,'dev','&gfx=default&pr=0.5');
 await expect(page.locator('#checkpoint-status')).toContainText('Local saving unavailable');
 await page.getByRole('button',{name:'Start Hot Desk'}).click();
 await page.waitForFunction(()=>!!window.__fogcity!.state().ext.missions);
 expect(errors).toEqual([]);
});
