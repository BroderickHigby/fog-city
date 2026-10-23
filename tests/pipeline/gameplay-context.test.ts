import {expect,it} from 'vitest';
import {gameplayLand,gameplayMetadata} from '../../pipeline/lib/gameplay-context.ts';
it('uses owning tiles, not neighbouring heightfield interpolation, at outer seams',()=>{
 const land=gameplayLand([{ix:0,iz:0}],500,{heightAt:()=>2,waterAt:()=>false},[]);
 expect(land(499.99,100)).toBe(true);expect(land(500,100)).toBe(false);expect(land(-0.01,100)).toBe(false);expect(land(NaN,100)).toBe(false);
});
it('rejects water and footprints across index cells',()=>{
 const land=gameplayLand([{ix:0,iz:0}],500,{heightAt:()=>2,waterAt:x=>x===10},[{footprint:[[40,40],[80,40],[80,80],[40,80]]}]);
 expect(land(10,10)).toBe(false);expect(land(60,60)).toBe(false);expect(land(90,90)).toBe(true);
});
it('rejects inland lake samples while retaining nearby dry anchors',()=>{
 const field={x0:0,z0:0,cellSizeM:10,nx:3,nz:3,heights:Array(9).fill(5),water:Array(9).fill(0)};
 const land=gameplayLand([{ix:0,iz:0}],500,{heightAt:()=>5,waterAt:()=>false,field:()=>field},[],new Map([['t0_0',[0,0,0,0,1,0,0,0,0]]]));
 expect(land(10,10)).toBe(false);expect(land(1,1)).toBe(true);
});
it('orders both metadata paths identically and preserves unrelated report values',()=>{
 const initial={layers:{transit:'muni.json',signals:'signals.json',gameplay:'old.json'},counts:{transitStops:42,signals:3,gameplayRefills:0}};
 const result=gameplayMetadata(initial.layers,initial.counts,{refills:[1,2],anchors:[1]});
 expect(Object.keys(result.layers)).toEqual(['transit','gameplay','signals']);
 expect(Object.keys(result.counts)).toEqual(['transitStops','gameplayRefills','gameplayAnchors','signals']);
 expect(result.counts).toMatchObject({transitStops:42,signals:3,gameplayRefills:2,gameplayAnchors:1});
 expect(gameplayMetadata(result.layers,result.counts,{refills:[1,2],anchors:[1]})).toEqual(result);
 expect(initial.layers.gameplay).toBe('old.json');
});
