// Record the original upstream box-vs-box contact (vehicle-physics.js vehicleContact) for SIM25's
// pin, without altering its function body. Fog boxes go in with z reflected; results come back
// in Fog's frame (normal from b toward a).
// node scripts/golden/vehicle-contact-cases.cjs /path/to/slop-new-york > tests/golden/vehicle-contact-819a0ad.json
const {readFileSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {resolve,join}=require('node:path');
const root=resolve(process.argv[2]||'.'),commit='819a0adb3345e15a7c5e9558d8d00c9dd05b2ae4';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==commit)throw Error('Use the exact pinned upstream commit');
const source=readFileSync(join(root,'js/vehicle-physics.js'),'utf8');
const {loadModule}=require(join(root,'tests/helpers/module.cjs'));
const {vehicleContact}=loadModule(source,{});
// A fixed generator (no Math.random): the same cases on every run.
let seed=7;const r=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
const car={hl:2.2,hw:.95};
const cases=[
 [{x:0,z:0,heading:0,...car},{x:0,z:-4.3,heading:0,...car}],
 [{x:0,z:0,heading:0,...car},{x:1,z:-4.3,heading:0,...car}],
 [{x:0,z:0,heading:.08,...car},{x:1.85,z:-1.5,heading:0,...car}],
 [{x:0,z:0,heading:1.5707963267948966,...car},{x:0,z:-2.5,heading:0,...car}],
 [{x:0,z:0,heading:0,...car},{x:3,z:0,heading:0,...car}],
];
while(cases.length<120)cases.push([{x:(r()-.5)*6,z:(r()-.5)*6,heading:(r()-.5)*7,...car},{x:0,z:0,heading:(r()-.5)*7,hl:1.5+r()*1.5,hw:.8+r()*.4}]);
const body=b=>({x:b.x,z:-b.z,sin:Math.sin(b.heading),cos:Math.cos(b.heading),halfW:b.hw,halfL:b.hl});
const out=cases.map(([a,b])=>{const c={};return {a,b,contact:vehicleContact(body(a),body(b),c)?{depth:c.depth,nx:c.nx+0,nz:-c.nz+0,x:c.x,z:-c.z+0}:null};});
process.stdout.write(JSON.stringify({source:'mrdoob/slop-newyork',sourceCommit:commit,sourceSHA256:createHash('sha256').update(source).digest('hex'),sourcePath:'js/vehicle-physics.js',coordinateAdaptation:'Fog boxes (compass heading, forward (sin h, -cos h)) with z reflected; results reflected back. Normal from b toward a.',cases:out},null,1)+'\n');
