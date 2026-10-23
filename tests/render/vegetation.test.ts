import {describe,it,expect} from 'vitest';
import {treeGeometry} from '../../src/render/vegetation.ts';
describe('HD foliage',()=>{for(const conifer of [false,true])it(`builds bounded instancable ${conifer?'cypress':'broadleaf'} with foliage and branch materials`,()=>{const g=treeGeometry(conifer);expect(g.groups).toHaveLength(2);expect(g.getAttribute('position').count/3).toBeGreaterThan(350);expect(g.boundingBox!.min.y).toBeGreaterThan(-.01);expect(g.boundingBox!.max.y).toBeLessThan(1.15);for(const x of g.getAttribute('normal').array)expect(Number.isFinite(x)).toBe(true);const second=treeGeometry(conifer);expect(Array.from(g.getAttribute('position').array)).toEqual(Array.from(second.getAttribute('position').array));g.dispose();second.dispose();});});
it('spreads leaves vertically through the crown instead of a narrow horizontal band',()=>{
 for(const conifer of [false,true]){
  const g=treeGeometry(conifer),p=g.getAttribute('position'),group=g.groups[1]!;let low=Infinity,high=-Infinity;
  for(let i=group.start;i<group.start+group.count;i++){low=Math.min(low,p.getY(i));high=Math.max(high,p.getY(i));}
  expect(high-low).toBeGreaterThan(conifer?.6:.4);g.dispose();
 }
});
