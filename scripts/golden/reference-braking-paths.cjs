// Record the original upstream controller braking against travel while steering (SIM24's pin),
// without altering its production function bodies. The braking-steer cases were never in
// reference-driving-paths.cjs, whose commit be65d0a is not in a shallow clone; the pinned commit
// here has the same updateCar and CAR_DRIVE (it reproduces every be65d0a pin exactly).
// node scripts/golden/reference-braking-paths.cjs /path/to/slop-new-york > tests/golden/reference-braking-819a0ad.json
const {readFileSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {resolve,join}=require('node:path');
const root=resolve(process.argv[2]||'.'),commit='819a0adb3345e15a7c5e9558d8d00c9dd05b2ae4';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==commit)throw Error('Use the exact pinned upstream commit');
const source=readFileSync(join(root,'js/controllers.js'),'utf8');
const {loadModule}=require(join(root,'tests/helpers/module.cjs'));
const {ThirdPersonControllerManager}=loadModule(source,{imports:{'three/webgpu':{},'./city-config.js':{streetZ:()=>0},'./tsl-materials.js':{},'./actor-models.js':{},'./pedestrians.js':{},'./vehicle-lights.js':{},'./landmarks.js':{},'./building-collision.js':{}}});
// Throttle against travel is the original's only brake (it calls it the handbrake); Fog City's S key.
const cases=[
 {name:'brake-steer-right',ticks:90,initial:{speed:20},input:{throttle:-1,steer:1,brake:0,actions:0}},
 {name:'half-brake-steer-left',ticks:120,initial:{speed:15},input:{throttle:-.5,steer:-.6,brake:0,actions:0}},
 {name:'brake-steer-fast',ticks:120,initial:{speed:30},input:{throttle:-1,steer:-1,brake:0,actions:0}},
 {name:'reverse-brake-steer',ticks:60,initial:{speed:-8},input:{throttle:1,steer:.6,brake:0,actions:0}},
 {name:'brake-while-sliding',ticks:60,initial:{speed:18,lateral:3,yawRate:.4},input:{throttle:-1,steer:0,brake:0,actions:0}},
];
const scenarios=cases.map(spec=>{
 const h=spec.initial.heading||0,side=spec.initial.lateral||0;
 const car={type:'car',position:{x:0,y:0,z:0},heading:h,speed:spec.initial.speed,vx:Math.cos(h)*side,vz:-Math.sin(h)*side,angularVel:spec.initial.yawRate||0,steerAngle:0,pitchVel:0,rollVel:0,heaveVel:0,heaveY:0,wheelSpin:0,chassisPivot:{rotation:{x:0,z:0},position:{y:0}},wheels:[],carState:{value:{x:0,w:0}}};
 const controller=Object.create(ThirdPersonControllerManager.prototype);controller.entities={car};controller.keys={forward:Math.max(0,spec.input.throttle),backward:Math.max(0,-spec.input.throttle),left:Math.max(0,spec.input.steer),right:Math.max(0,-spec.input.steer)};controller.getGroundHeight=()=>0;controller.resolveHorizontalCollision=()=>{};
 const checkpoints=[];
 for(let tick=1;tick<=spec.ticks;tick++){
  controller.updateCar(1/60);
  if(tick%30===0||tick===spec.ticks)checkpoints.push({tick,x:car.position.x,z:-car.position.z,heading:car.heading,speed:car.speed,lateral:car.vx*Math.cos(car.heading)-car.vz*Math.sin(car.heading),yawRate:car.angularVel,steer:car.steerAngle});
 }
 return{...spec,checkpoints};
});
const sha=text=>createHash('sha256').update(text).digest('hex');
process.stdout.write(JSON.stringify({source:'mrdoob/slop-newyork',sourceCommit:commit,sourceSHA256:sha(source),updateCarSHA256:sha(ThirdPersonControllerManager.prototype.updateCar.toString()),sourcePath:'js/controllers.js',coordinateAdaptation:'Reflect world z; positive reference steer is positive Fog compass steering. Throttle against travel is the reference brake.',tickHz:60,physicsSubsteps:2,scenarios},null,2)+'\n');
