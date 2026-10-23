import {describe,it,expect} from 'vitest';
import {CHECKPOINT_CONTENT,readCheckpoint,checkpointOf,restoreCheckpoint} from '../../src/save/checkpoints.ts';
import {CAMPAIGN_MISSIONS} from '../../src/content/catalog.ts';
import {SIM_VERSION} from '../../src/sim/contract.ts';
import {buildWorld,createInitialState} from '../../src/sim/index.ts';
import {campaignOf} from '../../src/sim/missions/runtime.ts';
const saved={version:1,simVersion:SIM_VERSION,contentId:CHECKPOINT_CONTENT,world:'sf',completed:[CAMPAIGN_MISSIONS[0]!.id],cash:500,unlocks:['safehouse:fidi-desk']};
describe('progression checkpoints',()=>{
 it('restores progress into a fresh world without carrying threats or active bodies',()=>{const s=createInitialState(buildWorld([]),7,['p1'],{x:0,z:0,heading:0});const cp=readCheckpoint(saved,'sf')!;const restored=restoreCheckpoint(s,'p1',cp);expect(campaignOf(restored)!.players.p1).toMatchObject({cash:500,status:'success',threat:0,completed:saved.completed});expect(campaignOf(restored)!.actors).toEqual({});expect(restored.players).toBe(s.players);expect(restored.ext.combat).toBeUndefined();expect(checkpointOf(restored,'p1','sf')).toEqual(saved);});
 it('rejects stale content, future formats, other worlds, partial prefixes and injected state',()=>{for(const patch of [{contentId:'old'},{simVersion:SIM_VERSION+1},{version:2},{world:'dev'},{completed:[CAMPAIGN_MISSIONS[1]!.id]},{cash:Infinity},{cash:-1},{actors:[]},{unlocks:['__proto__.x']}])expect(readCheckpoint({...saved,...patch},'sf')).toBeNull();expect(readCheckpoint(null,'sf')).toBeNull();});
 it('never takes an in-action snapshot',()=>{const s=restoreCheckpoint(createInitialState(buildWorld([]),7,['p1'],{x:0,z:0,heading:0}),'p1',readCheckpoint(saved,'sf')!);campaignOf(s)!.players.p1!.status='active';expect(checkpointOf(s,'p1','sf')).toBeNull();});
});
