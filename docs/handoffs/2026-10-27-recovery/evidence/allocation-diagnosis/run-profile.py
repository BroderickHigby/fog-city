from pathlib import Path
import argparse,json,os,subprocess,sys,time
parser=argparse.ArgumentParser();parser.add_argument('--node-heap-mb',type=int,choices=[1024,2048],default=1024);args=parser.parse_args()
base=Path(__file__).resolve().parent;label=f'node{args.node_heap_mb}';out=base/f'result-{label}';log_path=base/f'profile-{label}.log'
if out.exists() or log_path.exists():raise SystemExit('Refusing to overwrite prior diagnostic evidence')
env={**os.environ,'FOG_PROFILE_NODE_HEAP_MB':str(args.node_heap_mb),'FOG_PROFILE_OUT':str(out)}
started=time.monotonic();timed_out=False
with log_path.open('w') as log:
 child=subprocess.Popen(['node',f'--max-old-space-size={args.node_heap_mb}',str(base/'profile-allocation.ts')],cwd=base,env=env,stdout=log,stderr=subprocess.STDOUT)
 try:code=child.wait(timeout=90)
 except subprocess.TimeoutExpired:
  timed_out=True;child.kill();child.wait();code=124;log.write('\nFAILED: bounded90s profiler deadline reached; owned child terminated.\n')
status={'diagnosticOnly':True,'requestedNodeOldSpaceMiB':args.node_heap_mb,'pid':child.pid,'wallSeconds':time.monotonic()-started,'exitCode':code,'timedOut':timed_out,'reportPresent':(out/'report.json').exists(),'log':str(log_path),'result':str(out),'browserCapacityAcceptance':False}
(base/f'status-{label}.json').write_text(json.dumps(status,indent=2)+'\n');print(json.dumps(status));sys.exit(code if code>=0 else 1)
