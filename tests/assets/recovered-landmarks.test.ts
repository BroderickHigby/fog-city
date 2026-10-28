import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe,it,expect } from "vitest";
import placements from "../../content/landmarks.json" with { type:"json" };
import recovery from "../../assets/imports/fog-city-landmarks/manifest.json" with { type:"json" };
import { parseLandmarks } from "../../src/render/landmarks.ts";
import { landmarkBlips } from "../../src/ui/landmarks.ts";
import { allPositions,box,loadModel,triangleCount } from "./glb.ts";
import { ROOT,readJson } from "../helpers.ts";

const budget:Record<string,number>={"415-mission":24000,"600-montgomery":16000,"coit-tower":8000,"city-hall":16000,"sutro-tower":12000,"golden-gate-bridge":30000,"bay-bridge-west":30000,"grace-cathedral":12000,"dragon-gate":6000,"mission-dolores":6000,"conservatory-of-flowers":8000,"sutro-baths":6000};
describe("recovered original project landmarks",()=>{
  it("registers all requested priority towers and preserves the modern Palace/Ferry placements",()=>{
    const entries=parseLandmarks(placements);expect(entries.skipped).toEqual([]);
    const blips=landmarkBlips(placements);
    for(const label of ["Coit Tower","Salesforce Tower","Transamerica Pyramid","Palace of Fine Arts","Ferry Building","R-evolution"])expect(blips.some(b=>b.label===label),label).toBe(true);
    expect(entries.entries.find(e=>e.id==="palace-of-fine-arts")!.headingDeg).toBeCloseTo(84.44334179);
    expect(entries.entries.find(e=>e.id==="palace-of-fine-arts")!.replacesBuildingIds).toHaveLength(6);
  });
  it.each(Object.keys(budget))("%s has its exact original site, source bytes and bounded geometry",async id=>{
    const entry=placements.landmarks.find(e=>e.id===id)!;
    const source=readJson<{sites:{id:string;lat:number;lon:number;headingDeg:number;replacesBuildingIds:string[]}[]}>("assets/imports/fog-city-landmarks/source/assets/blender/data/landmark-sites.json").sites.find(e=>e.id===id)!;
    expect([entry.lat,entry.lon,entry.headingDeg]).toEqual([source.lat,source.lon,source.headingDeg]);
    expect([...(entry.replacesBuildingIds??[])].sort()).toEqual([...source.replacesBuildingIds].sort());
    const record=recovery.outputs.find(output=>output.file===`public/${entry.model}`)!,bytes=readFileSync(`${ROOT}/${record.file}`);
    expect(bytes.length).toBe(record.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
    expect(bytes.length).toBeLessThan(1_000_000);const {doc}=await loadModel(entry.model.replace("models/",""));
    expect(triangleCount(doc)).toBeGreaterThan(100);expect(triangleCount(doc)).toBeLessThanOrEqual(budget[id]!);
    const bounds=box(allPositions(doc));expect([...bounds.min,...bounds.max].every(Number.isFinite)).toBe(true);
    const height=bounds.max[1]-Math.max(0,bounds.min[1]);
    if(id==="coit-tower")expect(height).toBeGreaterThan(60);
    if(id==="415-mission")expect(height).toBeGreaterThan(320);
    if(id==="600-montgomery")expect(height).toBeGreaterThan(255);
  });
});
