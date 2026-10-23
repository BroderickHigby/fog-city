import {describe,expect,it} from "vitest";
import {MemorySaveBackend,SaveStore,assertProgressionDocument,type SaveBackend,type ProgressionDocument} from "../../src/save/store.ts";
const progress:ProgressionDocument={wallet:{cashCents:200000,settledModeIds:["round-1"]},progression:{rank:1,xp:0},missions:{completedIds:[]}};
const validate=(data:ProgressionDocument)=>data;
describe("progression save boundary",()=>{
  it("roundtrips three slots independently and preserves payout deduplication",async()=>{
    const store=new SaveStore({backends:[new MemorySaveBackend()],contentHash:"bundle-1",validate,now:()=>10});
    await store.save(0,progress);await store.save(2,{wallet:{cashCents:10}});
    expect((await store.load(0))?.data).toEqual(progress);expect((await store.load(1))).toBeNull();expect((await store.load(2))?.data).toEqual({wallet:{cashCents:10}});
  });
  it("rejects whole simulations, prototype keys, nonfinite numbers and excessive text",()=>{
    expect(()=>assertProgressionDocument({players:{},ext:{}})).toThrow();expect(()=>assertProgressionDocument(JSON.parse('{"profile":{"__proto__":{}}}'))).toThrow();
    expect(()=>assertProgressionDocument({wallet:{cashCents:NaN}})).toThrow();expect(()=>assertProgressionDocument({profile:{name:"x".repeat(300)}})).toThrow();
  });
  it("requires confirmation before importing and leaves an existing save untouched on corruption",async()=>{
    const store=new SaveStore({backends:[new MemorySaveBackend()],contentHash:"bundle-1",validate,now:()=>10});await store.save(0,progress);
    const text=await store.export(0);expect(await store.import(1,text,()=>false)).toBe(false);expect(await store.load(1)).toBeNull();
    await expect(store.import(0,text.replace("200000","200001"),()=>true)).rejects.toThrow("checksum");expect((await store.load(0))?.data).toEqual(progress);
  });
  it("falls back during private-page outages and chooses newer offline progress",async()=>{
    const cloud=new MemorySaveBackend(),cache=new MemorySaveBackend();let clock=10;
    const online=new SaveStore({backends:[cloud,cache],contentHash:"bundle-1",validate,now:()=>clock});await online.save("auto",progress);
    const offline:SaveBackend={name:"page",read:key=>cloud.read(key),write:async()=>{throw new Error("offline");},remove:async()=>{}};
    clock=20;const store=new SaveStore({backends:[offline,cache],contentHash:"bundle-1",validate,now:()=>clock});
    expect((await store.save("auto",{wallet:{cashCents:99}})).localOnly).toBe(true);expect((await store.load("auto"))?.data).toEqual({wallet:{cashCents:99}});
  });
  it("runs the domain validator before saving",async()=>{
    const backend=new MemorySaveBackend();const store=new SaveStore({backends:[backend],contentHash:"bundle-1",validate:()=>{throw new Error("unknown catalog id");}});
    await expect(store.save(0,progress)).rejects.toThrow("unknown catalog id");expect(await backend.read("fog-city.progression.0")).toBeNull();
  });
});
