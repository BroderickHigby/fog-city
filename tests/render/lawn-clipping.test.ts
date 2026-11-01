import { describe, expect, it } from "vitest";
import { intersectLawns, subtractLawns, unionLawns, type LawnMultiPolygon, type LawnPoint } from "../../src/render/lawn-clipping.ts";

const square = (x: number, z: number, size: number): LawnPoint[] => [[x,z],[x+size,z],[x+size,z+size],[x,z+size]];
function area(polygons: LawnMultiPolygon): number {
  const ringArea = (ring: LawnPoint[]): number => Math.abs(ring.reduce((sum,a,i)=>{
    const b=ring[(i+1)%ring.length]!;
    return sum+a[0]*b[1]-a[1]*b[0];
  },0))/2;
  return polygons.reduce((sum,rings)=>sum+ringArea(rings[0]!)-rings.slice(1).reduce((n,r)=>n+ringArea(r),0),0);
}

describe("integer lawn clipping",()=>{
  it("retains holes and islands regardless of source ring winding",()=>{
    const outer=square(0,0,20),hole=square(5,5,10),island=square(8,8,4);
    for(const reverse of [false,true]) {
      const subject: LawnMultiPolygon=[[reverse?[...outer].reverse():outer,reverse?hole:[...hole].reverse()],[island]];
      const result=unionLawns(subject);
      expect(result).toHaveLength(2);
      expect(area(result)).toBeCloseTo(400-100+16,6);
      expect(result.some(p=>p.length===2)).toBe(true);
    }
  });

  it("unions duplicate/overlapping lawn records without erasing them",()=>{
    const first=square(0,0,10),second=square(5,0,10);
    expect(area(unionLawns([[first],[first],[second]]))).toBeCloseTo(150,6);
  });

  it("subtracts nearly coincident fractional road edges at real city magnitudes",()=>{
    const subject: LawnMultiPolygon=[[square(2220.2322330677544,-1618.170202667616,20)]];
    const edge: LawnPoint[]=[[2227.5701856598544,-1620],[2227.5701856598545,-1590],[2230.5701856598544,-1590],[2230.5701856598544,-1620]];
    const cut=subtractLawns(subject,[[edge],[edge.map(([x,z])=>[x+1e-11,z-1e-11] as LawnPoint)]]);
    expect(area(cut)).toBeCloseTo(340,2);
    expect(area(intersectLawns(subject,[[edge]]))+area(cut)).toBeCloseTo(400,2);
  });

  it("keeps outer clipping and hole subtraction symmetric at shared cell edges",()=>{
    const subject: LawnMultiPolygon=[[square(-100,-100,100),square(-75,-75,20)]];
    const clip: LawnMultiPolygon=[[square(-50,-100,100)]];
    expect(area(intersectLawns(subject,clip))+area(subtractLawns(subject,clip))).toBeCloseTo(9600,6);
    expect(unionLawns([])).toEqual([]);
    expect(intersectLawns(subject,[])).toEqual([]);
  });
});
