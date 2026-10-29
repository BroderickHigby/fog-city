"""Prepare licensed public-preview candidates. No invented original/lossless or listening claim."""
from pathlib import Path
import array,hashlib,json,math,subprocess,wave
BASE=Path(__file__).resolve().parent
REPO=BASE.parents[2]
OUT=REPO/'public/audio/vehicle'
OUT.mkdir(parents=True,exist_ok=True)
RAW=BASE/'raw/processed'
RAW.mkdir(exist_ok=True)
acquired=json.loads((BASE/'manifest.json').read_text())
by_id={x['sound_id']:x for x in acquired['files']}
plan=[('idle','865228',2.0,4.0,True,35,4000),('roll','865228',27.0,4.0,True,35,4000),('road','439311',8.0,5.0,True,120,4000),('brake','104026',0,2.0,False,300,6500),('accel','162499',0,4.265,False,40,4500)]
records=[]
for ident,source_id,start,length,loop,hp,lp in plan:
 source=by_id[source_id]
 source_path=REPO/'assets/imports'/source['path']
 if hashlib.sha256(source_path.read_bytes()).hexdigest()!=source['sha256']:raise ValueError('Source hash mismatch')
 cmd=['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-ss',str(start),'-i',str(source_path),'-t',str(length),'-vn','-af',f'highpass=f={hp},lowpass=f={lp}','-ac','1','-ar','48000','-f','f32le','pipe:1']
 values=array.array('f',subprocess.run(cmd,check=True,capture_output=True).stdout)
 if not values:raise ValueError('Empty source section')
 if loop:
  count=9600 if ident=='road' else 7680
  head=values[:count];tail=values[-count:]
  blend=array.array('f',(tail[i]*(1-(.5-.5*math.cos(math.pi*i/(count-1))))+head[i]*(.5-.5*math.cos(math.pi*i/(count-1))) for i in range(count)))
  values=values[count:-count]+blend
 else:
  attack=min(480,len(values));release=min(3840,len(values))
  for i in range(attack):values[i]*=i/attack
  for i in range(release):values[len(values)-1-i]*=i/release
 rms=math.sqrt(sum(v*v for v in values)/len(values));peak=max(abs(v) for v in values)
 gain=min(.1/max(rms,1e-12),.75/max(peak,1e-12))
 samples=array.array('h',(round(max(-1,min(1,x*gain))*32767) for x in values))
 pcm=RAW/(ident+'.wav')
 with wave.open(str(pcm),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(48000);f.writeframes(samples.tobytes())
 duration=len(samples)/48000
 formats=[]
 for extension,encoding in [('ogg',['-c:a','libopus','-b:a','96k','-vbr','off','-application','audio']),('mp3',['-c:a','libmp3lame','-b:a','128k'])]:
  path=OUT/(ident+'.'+extension)
  cmd=['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-y','-threads','1','-filter_threads','1','-i',str(pcm),'-map_metadata','-1','-ar','48000','-ac','1',*encoding,'-fflags','+bitexact','-flags:a','+bitexact',str(path)]
  subprocess.run(cmd,check=True)
  b=path.read_bytes()
  formats.append({'url':'audio/vehicle/'+path.name,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'codec':'opus' if extension=='ogg' else 'mp3','loopStartS':0,'loopEndS':duration})
 record={'id':ident,'sources':formats,'maxDecodedSeconds':duration+.15,'author':source['author'],'sourcePage':source['source_page'],'licence':'CC0-1.0','sourcePreviewSha256':source['sha256'],'sourceAcquisitionUrl':source['acquisition_url'],'sourceRepresentation':'HQ MP3 public preview; lossy, not the original WAV/AIFF','sourceStartS':start,'sourceLengthS':length,'loop':loop,'pcmDurationS':duration,'pcmRmsDbFS':20*math.log10(max(rms*gain,1e-12)),'pcmPeakDbFS':20*math.log10(max(peak*gain,1e-12)),'pcmLoopJumpDbFS':20*math.log10(max(abs(samples[-1]-samples[0])/32768,1e-12)) if loop else None,'qualityApproved':False}
 records.append(record)
manifest={'schema':1,'status':'candidate','qualityApproved':False,'recordings':records,'review':'Candidate trim points and signal processing only; no human listening or native browser loop acceptance performed.'}
(BASE/'prepared-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(REPO/'src/audio/vehicle-recording-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'files':sum(len(x['sources'])for x in records),'bytes':sum(y['bytes']for x in records for y in x['sources']),'loops':[{'id':x['id'],'duration':x['pcmDurationS'],'jumpDbFS':x['pcmLoopJumpDbFS'],'rmsDbFS':x['pcmRmsDbFS']}for x in records]},indent=2))
