import {it,expect} from 'vitest';
import {AimControl} from '../../src/input/aim.ts';
it('bounds pitch and resets orbit on return to a vehicle',()=>{const aim=new AimControl();aim.update(0,true,100000,100000);expect(aim.pitch).toBe(-.85);expect(Math.abs(aim.yaw)).toBeLessThanOrEqual(Math.PI);aim.update(1,false,500,500);expect(aim.yaw).toBeCloseTo(1);expect(aim.pitch).toBe(.08);aim.update(1,true,0,0);expect(aim.yaw).toBeCloseTo(1);});
