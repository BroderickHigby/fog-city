// Record original upstream car controls without altering their production function bodies.
// node scripts/golden/reference-driving-paths.cjs /path/to/slop-new-york > tests/golden/reference-driving-be65d0a.json
const {readFileSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {resolve,join}=require('node:path');
const root=resolve(process.argv[2]||'.'),commit='be65d0ab61b24718b6da8886b7d7bed2d68ac178';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==commit)throw Error('Use the exact pinned upstream commit');
const source=readFileSync(join(root,'js/controllers.js'),'utf8');
const {loadModule}=require(join(root,'tests/helpers/module.cjs'));
const {ThirdPersonControllerManager}=loadModule(source,{imports:{'three/webgpu':{},'./city-config.js':{streetZ:()=>0},'./tsl-materials.js':{},'./actor-models.js':{},'./pedestrians.js':{},'./vehicle-lights.js':{},'./landmarks.js':{}}});
const cases=[
 {name:'accelerate-city',ticks:240,initial:{speed:0},input:{throttle:1,steer:0,brake:0,actions:0}},
 {name:'release-coast',ticks:300,initial:{speed:50/3.6},input:{throttle:0,steer:0,brake:0,actions:0}},
 {name:'pedal-brake',ticks:90,initial:{speed:50/3.6},input:{throttle:-1,steer:0,brake:0,actions:0}},
 {name:'steady-turn',ticks:180,initial:{speed:15},input:{throttle:.5,steer:.6,brake:0,actions:0}},
 {name:'reverse-turn',ticks:120,initial:{speed:-5},input:{throttle:0,steer:.6,brake:0,actions:0}},
 {name:'recover-impact',ticks:180,initial:{speed:15,lateral:2,yawRate:.5},input:{throttle:.5,steer:.6,brake:0,actions:0}},
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
process.stdout.write(JSON.stringify({source:'mrdoob/slop-newyork',sourceCommit:commit,sourceSHA256:createHash('sha256').update(source).digest('hex'),sourcePath:'js/controllers.js',coordinateAdaptation:'Reflect world z; positive reference steer is positive Fog compass steering. Input bindings remain Fog City controls.',tickHz:60,physicsSubsteps:2,scenarios},null,2)+'\n');
