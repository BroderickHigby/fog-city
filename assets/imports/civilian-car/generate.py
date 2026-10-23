"""Generic 4.3 m civilian fastback for Fog City. No make, badge or real model is copied.

Run: blender -b --python assets/imports/civilian-car/generate.py -- [--preview]
Uses the repository's original mesh/export helpers; station-based vehicle construction is
informed by the MIT Slop New York reference. All coordinates below are original.
"""
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'assets/blender/lib'))
import bpy
from mathutils import Matrix, Vector
import fc
import vehicle as V

WR, WW, AXLE, W = 0.34, 0.215, 1.33, 0.93
# Body: y, half-width, sill, shoulder, top. More stations at curved bumpers.
BODY = [
 (2.15,.68,.29,.58,.66), (2.13,.76,.26,.65,.72), (2.08,.85,.25,.69,.76),
 (1.95,.91,.24,.71,.79), (1.65,.925,.23,.74,.83), (1.30,.93,.22,.78,.88),
 (.90,.925,.22,.81,.94), (.65,.925,.22,.83,.985), (0,.93,.22,.85,1.00),
 (-.70,.93,.22,.86,1.01), (-1.25,.925,.23,.86,1.02), (-1.65,.915,.24,.87,1.01),
 (-1.94,.885,.26,.86,.98), (-2.08,.825,.29,.84,.945), (-2.14,.75,.33,.79,.89), (-2.15,.71,.34,.75,.85)
]


def smoothstep(t):
    return t*t*(3-2*t)


def smooth_table(rows, y):
    # C1 cubic Hermite interpolation avoids the repeated flat spots that smoothstep
    # interpolation puts into long reflected panels and windscreens.
    s=sorted(rows)
    if y <= s[0][0]: return list(s[0][1:])
    if y >= s[-1][0]: return list(s[-1][1:])
    for i,(a,b) in enumerate(zip(s,s[1:])):
        if a[0] <= y <= b[0]:
            dy=b[0]-a[0];t=(y-a[0])/dy
            before=s[max(0,i-1)];after=s[min(len(s)-1,i+2)]
            values=[]
            for k in range(1,len(a)):
                m0=(b[k]-before[k])/(b[0]-before[0])
                m1=(after[k]-a[k])/(after[0]-a[0])
                v=(2*t*t*t-3*t*t+1)*a[k]+(t*t*t-2*t*t+t)*dy*m0+(-2*t*t*t+3*t*t)*b[k]+(t*t*t-t*t)*dy*m1
                values.append(max(min(a[k],b[k]),min(max(a[k],b[k]),v)))
            return values


def add_object(mb, ob, mat):
    me=ob.data
    M=ob.matrix_world
    for face in me.polygons:
        mb.poly([tuple(M @ me.vertices[v].co) for v in face.vertices],mat,smooth=face.use_smooth)
    bpy.data.objects.remove(ob,do_unlink=True)
    if me.users == 0: bpy.data.meshes.remove(me)


def rounded(mb, center, scale, radius, mat, segments=2):
    bpy.ops.mesh.primitive_cube_add(size=1,location=center)
    ob=bpy.context.object
    ob.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    mod=ob.modifiers.new('small manufactured edge radii','BEVEL'); mod.width=radius;mod.segments=segments
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for f in ob.data.polygons: f.use_smooth=True
    add_object(mb,ob,mat)


def section(y):
    hw,zb,zs,zt=smooth_table(BODY,y)
    for axle in (-AXLE,AXLE):
        d=y-axle
        if abs(d)<.405:
            zb=max(zb,WR+.015+math.sqrt(.405*.405-d*d))
    # Superelliptic lower corner and rounded shoulder, with a gently crowned bonnet/deck.
    height=max(zs-zb,.025)
    corner=min(.06,height*.28)
    right=[(0,zb)]
    for t in (0,.25,.5,.75,1):
        a=t*math.pi/2
        right.append((hw-.075+.075*math.sin(a),zb+corner*(1-math.cos(a))))
    right.extend([(hw,zb+height*.55),(hw-.007,zb+height*.82),(hw-.026,zs+.01),(hw-.072,zs+.045)])
    edge=hw-.12
    right.append((edge,zs+.06))
    for f in (.78,.55,.30,0): right.append((edge*f,zt-(zt-(zs+.06))*f*f))
    return right + [(-x,z) for x,z in reversed(right[1:-1])]


def body_z_at_x(y,x):
    points=section(y);hits=[]
    for a,b in zip(points,points[1:]+points[:1]):
        if min(a[0],b[0])-1e-8 <= x <= max(a[0],b[0])+1e-8 and abs(b[0]-a[0])>1e-8:
            hits.append(a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]))
    return max(hits) if hits else smooth_table(BODY,y)[3]


def body_x_at_z(y,z):
    points=section(y);hits=[]
    for a,b in zip(points,points[1:]+points[:1]):
        if min(a[1],b[1])-1e-8 <= z <= max(a[1],b[1])+1e-8 and abs(b[1]-a[1])>1e-8:
            hits.append(a[0]+(b[0]-a[0])*(z-a[1])/(b[1]-a[1]))
    return max(hits) if hits else smooth_table(BODY,y)[0]


def body_shell(mb,paint,trim,under):
    ys=set(s[0] for s in BODY)
    ys.update(2.15-i*4.3/48 for i in range(49))
    for axle in (-AXLE,AXLE):
        ys.update(axle+.405*math.cos(i*math.pi/16) for i in range(17))
    ys=sorted(ys,reverse=True)
    n=len(section(0))
    def material(j,y0,y1):
        return under if j in (0,n-1) else trim if j in (1,2,n-2,n-3) else paint
    V.loft_body(mb,ys,section,material,.58,paint,paint)


# Cabin y, rail halfwidth, rail-height, belt halfwidth, belt height.
CAB=[(.77,.78,.98,.79,.98),(.55,.72,1.16,.80,.985),(.25,.675,1.39,.805,.995),
     (.10,.67,1.435,.81,1.00),(-.35,.675,1.46,.81,1.00),(-.85,.655,1.445,.81,1.005),
     (-1.08,.635,1.405,.81,1.01),(-1.38,.70,1.23,.80,1.015),(-1.72,.79,1.035,.79,1.035)]


def native_cabin_section(y):
    rw,rh,bw,bh=smooth_table(CAB,y)
    bh=body_z_at_x(y,bw)+.004
    out=[]
    for t in (0,.25,.5,.75,1): out.append((bw+(rw-bw)*t+.009*math.sin(math.pi*t),bh+(rh-bh)*t))
    for t in (.25,.5,.75,1):
        a=t*math.pi/2
        out.append((rw*math.cos(a),rh+.024*math.sin(a)))
    return out+[(-x,z) for x,z in reversed(out[:-1])]


def cabin_section(y):
    # A single clean windscreen slope from the curved bonnet to the roof.
    # Project its leading edge onto the bonnet so there is no open cavity.
    # Rear glazing uses the same construction against the tail deck.
    if y>.25: base_y,roof_y=.77,.25
    elif y < -1.08: base_y,roof_y=-1.72,-1.08
    else: return native_cabin_section(y)
    t=(y-base_y)/(roof_y-base_y)
    base=native_cabin_section(base_y);roof=native_cabin_section(roof_y)
    return [(bx+(rx-bx)*t,body_z_at_x(base_y,bx)+.004+(rz-body_z_at_x(base_y,bx)-.004)*t)
            for (bx,bz),(rx,rz) in zip(base,roof)]


def greenhouse(mb,paint,glass,trim,chrome):
    ys=set(p[0] for p in CAB)
    ys.update(.77-i*2.49/24 for i in range(25))
    ys.update([.26,.20,-.45,-.51,-1.03,-1.10])
    ys=sorted(ys,reverse=True)
    rings=[[(x,y,z) for x,z in cabin_section(y)] for y in ys]
    n=len(rings[0])
    for a,b in zip(rings,rings[1:]):
        mid=(a[0][1]+b[0][1])/2
        for j in range(n-1):
            top=4 <= j < n-5
            pillar=(-.51 <= mid <= -.45) or (.20 <= mid <= .26) or (-1.10 <= mid <= -1.03)
            material=paint if top and -1.06 <= mid <= .23 else trim if pillar and not top else glass
            V.outward_quad(mb,[a[j],a[j+1],b[j+1],b[j]],material,.70)
    # Bonnet panel shut lines follow the same loft as the painted shell.
    for side in (-1,1):
        points=[]
        for i in range(17):
            y=.80+i*1.20/16
            x=side*(.66-.095*(i/16)**2)
            points.append((x,y,body_z_at_x(y,x)+.002))
        for a,b in zip(points,points[1:]): mb.cyl_between(a,b,.0026,4,trim)
    # Window surrounds, belt brightwork and A/C pillars keep a manufactured edge, not a black blob.
    for side in (-1,1):
        last=None
        for i in range(26):
            y=.77-i*2.49/25
            rw,rh,bw,bh=smooth_table(CAB,y)
            bh=body_z_at_x(y,bw)+.004
            p=(side*bw,y,bh+.003)
            if last: mb.cyl_between(last,p,.008,6,chrome)
            last=p
        for y in (.23,-1.075):
            rw,rh,bw,bh=smooth_table(CAB,y)
            bh=body_z_at_x(y,bw)+.004
            mb.cyl_between((side*bw,y,bh),(side*rw,y,rh),.018,8,paint)
        # Door shut lines and flush handles, original layout.
        for y in (.64,-.51,-1.42):
            low=max(.36, min(z for x,z in section(y))+.008)
            top=body_z_at_x(y,.81)
            zs=[low, low+(top-low)*.38, low+(top-low)*.75, top]
            pts=[(side*(body_x_at_z(y,z)+.003),y,z) for z in zs]
            for a,b in zip(pts,pts[1:]): mb.cyl_between(a,b,.0032,4,trim)
        for y in (-.22,-1.13):
            rounded(mb,(side*.924,y,.865),(.018,.125,.027),.008,paint,2)
        # Mirror stalk, rounded shell, glass facing rear.
        mb.cyl_between((side*.80,.55,1.015),(side*.99,.50,1.05),.018,8,trim)
        mb.sphere((side*1.005,.49,1.062),1,14,8,paint,scale=(.13,.09,.057))
        mb.sphere((side*1.006,.435,1.062),1,12,6,glass,scale=(.10,.016,.039))
    # Wipers lie on the windscreen rather than floating off the front.
    for x in (-.36,.33):
        mb.cyl_between((x,.67,1.063),(x-.15,.43,1.25),.006,6,trim)
    # A discreet shark-fin antenna.
    mb.poly_n([(-.026,-.90,1.476),(.026,-.90,1.476),(0,-.77,1.565)],paint,(0,1,0))
    mb.poly_n([(-.026,-.90,1.476),(0,-1.04,1.474),(0,-.77,1.565)],paint,(-1,0,0))
    mb.poly_n([(.026,-.90,1.476),(0,-.77,1.565),(0,-1.04,1.474)],paint,(1,0,0))


def main():
    fc.reset()
    paint=fc.material('paint','#476b84',.27,.30)
    p=paint.node_tree.nodes['Principled BSDF'];p.inputs['Coat Weight'].default_value=1;p.inputs['Coat Roughness'].default_value=.14
    glass=fc.material('glass','#101c23',.14,.0)
    trim=fc.material('trim_black','#15191c',.53,.08)
    under=fc.material('underbody','#090b0d',.85)
    chrome=fc.material('brightwork','#a8adb2',.24,.88)
    tire=fc.material('tire','#141719',.92)
    rim=fc.material('rim','#9aa6ad',.22,.88)
    brake=fc.material('brake_iron','#4c5156',.7,.65)
    plate=fc.material('plate','#e4dfcb',.65)
    head=fc.material('light_headlight','#daeaf2',.14,emission='#f4f4e9',strength=1)
    tail=fc.material('light_taillight','#790909',.18,emission='#f2221b',strength=1)
    amber=fc.material('indicator_lens','#eb951f',.22)
    root=fc.empty('civilian_car');root['fcModel']='civilian-car';root['license']='MIT';root['lengthM']=4.3;root['bodyWidthM']=1.86
    mb=fc.MeshBuilder(); body_shell(mb,paint,trim,under);greenhouse(mb,paint,glass,trim,chrome)
    # Detailed fascia and two separate lamps, with modest running-light signatures.
    for side in (-1,1):
        rounded(mb,(side*.585,2.103,.742),(.46,.060,.105),.027,trim)
        rounded(mb,(side*.585,2.142,.754),(.398,.025,.067),.02,head)
        mb.cyl_between((side*.40,2.155,.789),(side*.77,2.155,.77),.006,8,head)
        rounded(mb,(side*.788,2.11,.739),(.026,.035,.070),.01,amber)
        rounded(mb,(side*.594,-2.114,.91),(.45,.05,.092),.025,trim)
        rounded(mb,(side*.594,-2.146,.918),(.398,.02,.056),.017,tail)
        # Modest bumper corner vents, not huge racing intakes.
        rounded(mb,(side*.69,2.115,.435),(.24,.045,.11),.035,trim)
    rounded(mb,(0,2.122,.51),(.78,.08,.175),.045,trim)
    for z in (.465,.500,.535,.570): mb.cyl_between((-.345,2.167,z),(.345,2.167,z),.0055,6,chrome)
    rounded(mb,(0,-2.113,.425),(1.20,.07,.16),.045,trim)
    for y in (2.172,-2.155):
        rounded(mb,(0,y,.677 if y>0 else .725),(.34,.018,.115),.015,plate)
        for x in (-.115,-.079,-.036,.017,.054,.100):
            # Abstract registration glyph strokes, not a real plate number or logo.
            rounded(mb,(x,y+(.013 if y>0 else -.013),.68 if y>0 else .728),(.012,.003,.045),.0018,trim,1)
    # Wheel arch liner/lip geometry follows the circular opening.
    for y in (-AXLE,AXLE):
        for side in (-1,1):
            last=None
            for i in range(19):
                a=i*math.pi/18
                p=(side*.932,y+.405*math.cos(a),WR+.015+.405*math.sin(a))
                if last: mb.cyl_between(last,p,.012,6,trim)
                last=p
            # Dark wheel tub surface, capped so no daylight leaks through the opening.
            mb.push(Matrix.Translation((side*.80,y,WR+.015)) @ Matrix.Rotation(math.pi/2,4,'Y'))
            mb.lathe([(.396,-.10),(.396,.10)],24,under,arc=(math.pi/2,3*math.pi/2))
            mb.pop()
    V.weld(mb).build('body',parent=root,sharp_angle=44)
    for name,y,side in [('FL',AXLE,-1),('FR',AXLE,1),('RL',-AXLE,-1),('RR',-AXLE,1)]:
        wheel=V.wheel('wheel_'+name,WR,WW,tire,rim,hub=brake,seg=24,spokes=6,side=side,parent=root,
          location=(side*.82,y,WR),rim_r=.231,extras={'steer':name.startswith('F')})
    path=fc.export_glb('civilian-car.glb',15_000)
    if '--preview' in fc.script_args():
        import lookdev as L
        fc.reset()
        scene=bpy.context.scene
        scene.render.engine='CYCLES'
        scene.cycles.samples=24
        scene.cycles.use_denoising=False
        scene.cycles.max_bounces=5
        scene.render.threads_mode='FIXED';scene.render.threads=2
        scene.render.resolution_x=1100;scene.render.resolution_y=700;scene.render.resolution_percentage=100
        scene.render.image_settings.file_format='PNG'
        scene.view_settings.view_transform='AgX'
        scene.world=bpy.data.worlds.new('studio world');scene.world.use_nodes=True
        scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.45,.50,.58,1)
        scene.world.node_tree.nodes['Background'].inputs[1].default_value=.7
        floor=fc.material('studio_floor','#8b9299',.83)
        mbfloor=fc.MeshBuilder();mbfloor.box(-100,-100,-.04,100,100,-.01,floor);mbfloor.build('studio_floor')
        L.import_glb('civilian-car.glb',heading_deg=0)
        L.point_light((2,4,6),850,'#fff2df',kind='AREA',size=(6,6),rot=(.3,0,.3))
        L.point_light((-4,-1,4),600,'#d8e8ff',kind='AREA',size=(7,7),rot=(.5,0,-.6))
        L.sun(150,45,2,'#fff0da',angle_deg=8)
        L.camera((6.2,8.3,4.0),(0,0,.72),lens=58)
        scene.render.filepath=str(HERE/'preview.png')
        bpy.ops.render.render(write_still=True)
    print(path)

main()
