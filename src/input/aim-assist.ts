export interface AimTarget {readonly id:string;readonly x:number;readonly z:number;readonly visible:boolean;readonly robot:boolean;readonly protected?:boolean}
const angle=(value:number)=>Math.atan2(Math.sin(value),Math.cos(value));

/** Presentation-only assist. Occlusion/eligibility is supplied by the world adapter. */
export function assistedAim(origin:{readonly x:number;readonly z:number},yaw:number,targets:readonly AimTarget[],touch=false):number {
  if(!Number.isFinite(yaw))return 0;
  const eligible=targets.filter(t=>t.visible&&t.robot&&!t.protected&&Number.isFinite(t.x)&&Number.isFinite(t.z))
    .map(target=>({target,distance:Math.hypot(target.x-origin.x,target.z-origin.z),delta:angle(Math.atan2(target.x-origin.x,-(target.z-origin.z))-yaw)}))
    .filter(value=>value.distance<=25&&Math.abs(value.delta)<=Math.PI/18)
    .sort((a,b)=>a.distance-b.distance||(a.target.id<b.target.id?-1:a.target.id>b.target.id?1:0));
  const target=eligible[0];if(!target)return angle(yaw);
  const strength=touch?1:.5,limit=Math.PI/30;
  return angle(yaw+Math.max(-limit,Math.min(limit,target.delta*strength)));
}
