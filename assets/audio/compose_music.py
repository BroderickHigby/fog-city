import numpy as np, wave, pathlib, subprocess, json
out=pathlib.Path(__file__).resolve().parents[2]/'public/audio/music';out.mkdir(parents=True,exist_ok=True)
sr=44100;bpm=124;beat=60/bpm;duration=beat*4*32;n=int(duration*sr);mix=np.zeros((n,2),dtype=np.float32);rng=np.random.default_rng(64721)
def add(signal,start,pan=0):
 i=int(start*sr);count=min(len(signal),n-i)
 if count<=0:return
 mix[i:i+count,0]+=signal[:count]*np.sqrt((1-pan)/2);mix[i:i+count,1]+=signal[:count]*np.sqrt((1+pan)/2)
def env(t,attack,decay):return np.minimum(1,t/attack)*np.exp(-t/decay)
def tone(note,length,kind):
 t=np.arange(int(length*sr))/sr;f=440*2**((note-69)/12)
 if kind=='bass': y=np.sin(2*np.pi*f*t)+.25*np.sin(4*np.pi*f*t)+.1*np.sin(6*np.pi*f*t);a=env(t,.005,.18)*.22
 elif kind=='keys':y=np.sin(2*np.pi*f*t)+.35*np.sin(4*np.pi*f*t)+.14*np.sin(6*np.pi*f*t);a=env(t,.01,.65)*.085
 else:y=np.sin(2*np.pi*f*t+2*np.sin(2*np.pi*f*t)*np.exp(-t*9))+.14*np.sin(4*np.pi*f*t);a=env(t,.015,.22)*.11
 return (y*a).astype(np.float32)
chords=[[50,53,57,60],[46,50,53,57],[53,57,60,64],[48,52,55,58]]
for bar in range(32):
 chord=chords[(bar//2)%4];base=bar*4*beat;build=bar%16
 for k in range(4):
  t=np.arange(int(.3*sr))/sr;phase=2*np.pi*(47*t+95*.025*(1-np.exp(-t/.025)));add(np.sin(phase)*np.exp(-t*19)*.58,base+k*beat)
  if k%2:
   t=np.arange(int(.22*sr))/sr;noise=rng.normal(0,1,len(t));noise=np.concatenate([[0],np.diff(noise)])
   add((noise*.055+np.sin(2*np.pi*185*t)*.1)*np.exp(-t*24),base+k*beat)
 for h in range(8):
  t=np.arange(int(.055*sr))/sr;noise=rng.normal(0,1,len(t));high=np.concatenate([[0],np.diff(noise)])
  add(high*np.exp(-t*95)*(.022 if h%2==0 else .038),base+h*beat/2,(-1 if h%2 else 1)*.4)
 for pos in [0,.75,1.5,2,2.75,3.5]: add(tone(chord[0]-12+ (12 if pos==3.5 else 0),.4,'bass'),base+pos*beat)
 for pos in [.5,1.5,2.5,3.5]:
  for j,note in enumerate(chord):add(tone(note+12,.85,'keys'),base+pos*beat,j*.22-.33)
 if build>=4:
  pattern=[0,2,3,2,1,2,0,3]
  for k,j in enumerate(pattern):
   if (bar+k)%3:add(tone(chord[j]+24,.3,'lead'),base+k*beat/2,.25 if k%2 else -.25)
# Loop-safe bar-length arrangement and conservative headroom.
mix=np.tanh(mix*1.1)*.82;fade=int(.008*sr);mix[:fade]*=np.linspace(0,1,fade)[:,None];mix[-fade:]*=np.linspace(1,0,fade)[:,None]
wav=out/'neon-tide.wav'
with wave.open(str(wav),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((mix*32767).astype('<i2').tobytes())
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(wav),'-c:a','libvorbis','-q:a','5',str(out/'neon-tide.ogg')],check=True);wav.unlink()
(out/'credits.json').write_text(json.dumps({'title':'Neon Tide','creator':'Fog City original procedural score','bpm':bpm,'durationSeconds':duration,'license':'CC0-1.0','source':'assets/audio/compose_music.py','description':'Original stereo electro-funk: syncopated bass, electric keys, melodic synth and drums. No sampled recordings.'},indent=2)+'\n')
