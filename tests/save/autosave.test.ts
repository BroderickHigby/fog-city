import {expect,it,vi} from "vitest";
import {Autosave} from "../../src/save/autosave.ts";
import {SaveStore,type SaveBackend} from "../../src/save/store.ts";
it("preserves the existing autosave at boot and saves the latest coalesced checkpoint",async()=>{
  let release:(()=>void)|undefined;
  const gate=new Promise<void>(resolve=>{release=resolve;});const writes:string[]=[];
  const backend:SaveBackend={name:"slow",read:async()=>null,remove:async()=>{},write:async(_key,value)=>{writes.push(value);if(writes.length===1)await gate;}};
  let cash=1;
  const store=new SaveStore({backends:[backend],contentHash:"test",validate:value=>value,now:()=>cash});
  const autosave=new Autosave(store,()=>({wallet:{cashCents:cash}}));
  autosave.observe(1,"");expect(writes).toHaveLength(0);
  autosave.observe(2,"mission-1");await vi.waitFor(()=>expect(writes).toHaveLength(1));
  cash=2;autosave.observe(3,"mission-2");release?.();
  await vi.waitFor(()=>expect(writes).toHaveLength(2));expect(JSON.parse(writes[1]!).data.wallet.cashCents).toBe(2);
});
