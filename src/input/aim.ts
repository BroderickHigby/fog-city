const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
/** Local aiming is sampled into the recorded input, never read by the simulation. */
export class AimControl {
  yaw=0;pitch=.08;private offset=0;private walking=false;
  update(heading:number,onFoot:boolean,dx:number,dy:number):void {
    if(onFoot&&!this.walking){this.offset=0;this.pitch=.08;}
    this.walking=onFoot;
    if(onFoot){this.offset=wrap(this.offset+(Number.isFinite(dx)?dx:0)*.003);this.pitch=Math.max(-.85,Math.min(.95,this.pitch-(Number.isFinite(dy)?dy:0)*.003));}
    else {this.offset=0;this.pitch=.08;}
    this.yaw=wrap(heading+this.offset);
  }
}
