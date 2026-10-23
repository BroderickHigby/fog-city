"""Download immutable upstream inputs for convert.py; requires Python 3 standard library."""
from pathlib import Path
import hashlib,json,sys,urllib.request
commit='0943055db6ec570bcef9f2c8b41c9e5467c808f9'
base=f'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/{commit}/'
paths=['Assets/Avatars/Adults/Male_Adult_01/Export/Male_Adult_01.fbx']
paths += ['Assets/Avatars/Adults/Male_Adult_01/Textures/'+n+'.tga' for n in ['m002_body_color','m002_body_normal','m002_head_color','m002_head_normal','m002_opacity_color']]
paths += ['Assets/Animations/all_animations_max_motextr_static/m_idle_neutral_01.max.fbx','Assets/Animations/all_animations_max_motextr_xy/m_walk_neutral.max.fbx','Assets/Animations/all_animations_max_motextr_xy/m_run_neutral.max.fbx']
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
records=[]
for path in paths:
 data=urllib.request.urlopen(base+path,timeout=60).read();(out/Path(path).name).write_bytes(data)
 records.append({'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(out/'source-manifest.json').write_text(json.dumps({'repository':'https://github.com/microsoft/Microsoft-Rocketbox','commit':commit,'files':records},indent=2)+'\n')
