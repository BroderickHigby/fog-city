// WebGPU/TSL city materials. Procedural filtering, metre-scaled room-box interiors,
// derivative relief and canyon ambient shading are adapted from Slop New York
// (Mr.doob, MIT, source 64ad030; see the repository's third-party notice).
// Geometry, placement, game state and the legacy WebGL materials remain independent.
import * as THREE from "three";
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, InterpolationSamplingMode, InterpolationSamplingType } from "three/webgpu";
import {
  Fn, If, abs, attribute, cameraPosition, clamp, color, cos, dot, float, floor, fract,
  fwidth, instanceIndex, length, max, min, mix, mod, normalGeometry, normalLocal, normalView, normalWorldGeometry,
  normalize, positionGeometry, positionLocal, positionView, positionWorld, pow, select, sign, sin,
  smoothstep, step, texture, uniform, uv, varying, vec2, vec3, vec4,
} from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import type NodeBuilder from "three/src/nodes/core/NodeBuilder.js";
import { interleaveAttributes } from "three/addons/utils/BufferGeometryUtils.js";
import { fcUniforms } from "./materials.ts";
import { WINDOW_PROFILES } from "./building-window-profile.ts";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;
type CityNodeMaterial = MeshStandardNodeMaterial | MeshPhysicalNodeMaterial;
let enabled = false;
export function setGpuMaterialsEnabled(value: boolean): void { enabled = value; }
export function isGpuMaterialsEnabled(): boolean { return enabled; }
export const gpuMaterialUniforms = {
  time: uniform(0), night: uniform(0), wet: uniform(0), cameraGround: uniform(0),
};
export function updateGpuMaterialTime(seconds: number, cameraGround = 0): void {
  gpuMaterialUniforms.time.value = Number.isFinite(seconds) ? seconds : 0;
  gpuMaterialUniforms.night.value = fcUniforms.fcNight.value;
  gpuMaterialUniforms.wet.value = fcUniforms.fcWet.value;
  gpuMaterialUniforms.cameraGround.value = Number.isFinite(cameraGround) ? cameraGround : 0;
}

const hash2 = Fn(([p]: [V2]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise2 = Fn(([p]: [V2]) => {
  const i = floor(p), f = fract(p), u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(mix(hash2(i), hash2(i.add(vec2(1, 0))), u.x), mix(hash2(i.add(vec2(0, 1))), hash2(i.add(1)), u.x), u.y);
});
/** Box-filtered repeating coverage converges to its mean rather than shimmering. */
const pulse = Fn(([x, a, b, width]: [F, F, F, F]) => {
  const hw = max(width, .0001).mul(.5);
  const integral = (t: F): F => floor(t).mul(b.sub(a)).add(clamp(fract(t), a, b).sub(a));
  return integral(x.add(hw)).sub(integral(x.sub(hw))).div(hw.mul(2));
});
const line = Fn(([x, width]: [F, F]) => {
  const aa = max(fwidth(x), .0001), w = max(width, aa.mul(.5));
  return float(1).sub(smoothstep(w, w.add(aa), abs(x))).mul(min(1, width.div(w)));
});
const bumpNormal = Fn(([height]: [F]) => {
  const h = height.toVar(), px = positionView.dFdx(), py = positionView.dFdy();
  const rx = py.cross(normalView), ry = normalView.cross(px), det = dot(px, rx);
  const gradient = sign(det).mul(h.dFdx().mul(rx).add(h.dFdy().mul(ry)));
  return normalize(abs(det).mul(normalView).sub(gradient));
});
/** Analytic ambient sky visibility, not a screen-space AO or a GI measurement. */
export function canyonSkyAO(relativeHeight: F = positionWorld.y.sub(gpuMaterialUniforms.cameraGround)): F {
  const openness = smoothstep(0, 68, max(relativeHeight, 0));
  // SF's low blocks and open waterfront expose more sky than the reference's
  // Manhattan canyon. Retain contact shading without crushing shaded asphalt,
  // branches and street-facing windows to the old .34 ambient-light floor.
  const crevice = smoothstep(0, 7.5, max(relativeHeight, 0)).mul(.12).add(.88);
  return mix(.58, 1, openness).mul(crevice);
}

function common(source?: THREE.Material, physical = false): CityNodeMaterial {
  const m = physical ? new MeshPhysicalNodeMaterial() : new MeshStandardNodeMaterial();
  if (source) {
    const s = source as THREE.MeshPhysicalMaterial;
    m.name = s.name; m.side = s.side; m.transparent = s.transparent; m.opacity = s.opacity;
    m.depthWrite = s.depthWrite; m.depthTest = s.depthTest; m.depthFunc = s.depthFunc;
    m.alphaTest = s.alphaTest; m.alphaToCoverage = s.alphaToCoverage;
    m.vertexColors = s.vertexColors ?? false; m.flatShading = s.flatShading ?? false;
    m.polygonOffset = s.polygonOffset; m.polygonOffsetFactor = s.polygonOffsetFactor; m.polygonOffsetUnits = s.polygonOffsetUnits;
    m.visible = s.visible; m.fog = s.fog; m.toneMapped = s.toneMapped; m.forceSinglePass = s.forceSinglePass;
    m.blending = s.blending; m.blendSrc = s.blendSrc; m.blendDst = s.blendDst; m.blendEquation = s.blendEquation;
    m.blendSrcAlpha = s.blendSrcAlpha; m.blendDstAlpha = s.blendDstAlpha; m.blendEquationAlpha = s.blendEquationAlpha;
    m.premultipliedAlpha = s.premultipliedAlpha; m.alphaHash = s.alphaHash;
    if (s.color) m.color = s.color;
    if (s.emissive) m.emissive = s.emissive;
    m.emissiveIntensity = s.emissiveIntensity ?? 1;
    // Existing light/FX controllers may retain the admitted legacy material reference.
    // Forward the mutable scalar in both directions rather than freezing its initial value.
    for (const key of ["opacity", "emissiveIntensity"] as const) {
      if (typeof s[key] === "number") Object.defineProperty(m, key, { configurable: true, enumerable: true, get: () => s[key], set: (value: number) => { s[key] = value; } });
    }
    m.roughness = s.roughness ?? .8; m.metalness = s.metalness ?? 0;
    for (const key of ["map", "alphaMap", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "bumpMap", "envMap"] as const) {
      if (s[key]) m[key] = s[key];
    }
    if (s.normalScale) m.normalScale.copy(s.normalScale);
    if (m instanceof MeshPhysicalNodeMaterial) {
      m.clearcoat = s.clearcoat ?? 0; m.clearcoatRoughness = s.clearcoatRoughness ?? .1;
      m.ior = s.ior ?? 1.5; m.transmission = s.transmission ?? 0;
    }
    m.userData = { ...s.userData, fcGpuMaterial: true };
  }
  m.aoNode = canyonSkyAO();
  return m;
}

/** Genuine world-metre room slab intersection, sharing two/three window bays. */
const roomInterior = Fn(([u, v, winUv, cell, bayWidth, floorHeight, seed, footprint]: [F, F, V2, V2, F, F, F, V2]) => {
  const level = floor(v.div(floorHeight));
  const bays = mix(2, 3, step(.5, hash2(vec2(level, seed.mul(91)))));
  const phase = floor(hash2(vec2(level.add(23), seed.mul(137))).mul(bays));
  const roomU = u.div(bayWidth).add(phase).div(bays);
  const roomId = vec2(floor(roomU), level);
  const rw = bayWidth.mul(bays), rh = floorHeight.mul(.92), depth = rh.mul(1.55);
  const ox = fract(roomU).sub(.5).mul(rw), oy = winUv.y.sub(.46).mul(rh.mul(.62));
  const n = normalize(normalWorldGeometry);
  // SF's shipped wall UVs follow each polygon edge, including oblique facades.
  // Recover their signed tangent instead of assuming the New York axis-aligned frame.
  const px = positionWorld.dFdx(), py = positionWorld.dFdy(), ux = uv().dFdx(), uy = uv().dFdy();
  const determinant = ux.x.mul(uy.y).sub(ux.y.mul(uy.x));
  const safeDet = max(abs(determinant), .00000001).mul(determinant.greaterThanEqual(0).select(1, -1));
  const tangent = px.mul(uy.y).sub(py.mul(ux.y)).div(safeDet);
  const across = tangent.div(max(length(tangent), .0001));
  const ray = normalize(positionWorld.sub(cameraPosition));
  const dx = dot(ray, across), dy = ray.y, dz = max(abs(dot(ray, n)), .05);
  const tx = rw.mul(.5).sub(ox.mul(sign(dx))).div(max(abs(dx), .0001));
  const ty = rh.mul(.5).sub(oy.mul(sign(dy))).div(max(abs(dy), .0001));
  const tz = depth.add(.12).div(dz), travel = min(min(tx, ty), tz);
  const q = clamp(vec3(ox.add(dx.mul(travel)).div(rw).add(.5), oy.add(dy.mul(travel)).div(rh).add(.5), dz.mul(travel).sub(.12).div(depth)), 0, 1);
  const back = step(tz, tx).mul(step(tz, ty)), yPlane = step(ty, tx).mul(step(ty, tz));
  const ceiling = yPlane.mul(step(0, dy)), floorPlane = yPlane.mul(float(1).sub(step(0, dy)));
  const a = hash2(roomId.add(vec2(seed.mul(79), 19.4))), b = hash2(roomId.add(vec2(83.1, seed.mul(131))));
  const litSeed = hash2(roomId.add(vec2(seed.mul(211), 63.2)));
  const lod = smoothstep(.28, .8, max(footprint.x, footprint.y));
  const lit = step(.68, litSeed), bulb = mix(color(0xffb855), color(0xffe9b0), a);
  const light = mix(bulb, color(0xb6c9ec), step(.83, b));
  const wall = mix(color(0x807565), color(0xb2a68d), a);
  const boards = mix(color(0x493421), color(0x6b4c32), b).mul(float(1).sub(step(.93, fract(q.x.mul(7))).mul(.24)));
  const rug = step(abs(q.x.sub(.5)), .28).mul(step(abs(q.z.sub(.58)), .25));
  const flooring = mix(boards, mix(color(0x74453c), color(0x3b5b62), a), rug.mul(.8));
  const lamp = float(1).sub(smoothstep(.11, .18, length(q.xz.sub(.5)))).mul(float(1).sub(lod));
  const ceilingCol = mix(wall.mul(1.12), light.mul(mix(.75, 3.2, lit)), lamp);
  const door = step(abs(q.x.sub(mix(.24, .76, a))), .09).mul(step(abs(q.y.sub(.34)), .34));
  const frame = step(abs(q.x.sub(mix(.72, .28, step(.5, a)))), .085).mul(step(abs(q.y.sub(.56)), .095));
  const picture = step(abs(q.x.sub(mix(.72, .28, step(.5, a)))), .065).mul(step(abs(q.y.sub(.56)), .075));
  const backWall = mix(mix(mix(wall, color(0x4c3d2d), door), color(0x171613), frame), mix(color(0x304858), color(0x83683c), b), picture);
  const shell = mix(mix(mix(wall, flooring, floorPlane), ceilingCol, ceiling), backWall, back);
  const aoX = smoothstep(0, .16, q.x).mul(smoothstep(0, .16, float(1).sub(q.x)));
  const aoY = smoothstep(0, .16, q.y).mul(smoothstep(0, .16, float(1).sub(q.y)));
  const aoZ = smoothstep(0, .16, q.z).mul(smoothstep(0, .16, float(1).sub(q.z)));
  const shellAO = mix(.66, 1, mix(mix(aoY.mul(aoZ), aoX.mul(aoZ), yPlane), aoX.mul(aoY), back));
  const shaded = shell.mul(shellAO).mul(mix(1, .42, q.z));
  const curtainX = clamp(winUv.x.add(dx.div(dz).mul(.06)), 0, 1);
  const ca = hash2(cell.add(vec2(seed.mul(109), 41.2))), cb = hash2(cell.add(vec2(17.9, seed.mul(167))));
  const left = pow(smoothstep(.18, 1, ca), 2).mul(.48), right = pow(smoothstep(.18, 1, cb), 2).mul(.48);
  const curtainAA = fwidth(curtainX).add(.015);
  const drape = max(float(1).sub(smoothstep(left.sub(curtainAA), left.add(curtainAA), curtainX)), smoothstep(float(1).sub(right).sub(curtainAA), float(1).sub(right).add(curtainAA), curtainX));
  const coverage = mix(drape, .29, lod);
  const fabric = mix(mix(color(0xc1b69d), color(0x7d8b82), step(.4, a)), color(0x89614d), step(.75, b));
  const pleat = sin(curtainX.mul(48).add(ca.mul(6.28))).mul(float(1).sub(smoothstep(.6, 1.6, fwidth(curtainX).mul(48)))).mul(.16).add(.94);
  const room = mix(shaded, fabric.mul(pleat).mul(.75), coverage);
  const warmth = mix(vec3(1), light, lit.mul(.75));
  return vec4(room.mul(warmth).mul(mix(.72, 1.25, lit)), mix(lit, .32, lod).mul(mix(1, .2, coverage)));
});

function buildingMaterial(source: THREE.Material): CityNodeMaterial {
  const m = common(source); m.vertexColors = false; m.roughness = .8;
  const meta = varying(attribute("_building", "vec4"), "fcNodeBuilding").setInterpolation(InterpolationSamplingType.FLAT, InterpolationSamplingMode.EITHER);
  const facade = varying(attribute("_facade", "vec4"), "fcNodeFacade").setInterpolation(InterpolationSamplingType.FLAT, InterpolationSamplingMode.EITHER);
  const fuv = uv(), seed = clamp(meta.x, 0, 1), family = meta.w;
  const character = step(0, meta.x).mul(step(0, family)), roof = step(.5, facade.w);
  const g = clamp(facade.y, 0, 1), story = clamp(facade.x.mul(8), 2.6, 8);
  const colW = mix(3.2, 1.7, smoothstep(.2, .9, g));
  const bayW = mix(colW, 6, float(1).sub(step(.2, g)));
  const shopH = mix(mix(0, max(story, 3.8), step(.35, g)), 5, step(.8, g));
  const shop = step(.001, shopH).mul(float(1).sub(step(shopH, fuv.y))).mul(step(0, fuv.y));
  let ww: F = mix(.42, .9, g), low: F = float(.08).add(float(1).sub(g).mul(.2)), high: F = min(.96, low.add(mix(.42, .82, g)));
  const historic = step(.01, facade.z).mul(float(1).sub(step(.37, facade.z)));
  ww = mix(ww, ww.mul(.78), historic); low = mix(low, low.mul(.8), historic); high = mix(high, min(.95, high.add(.06)), historic);
  let profile: V4 = vec4(1, 0, 0, 0), topOffset: F = float(0);
  for (let i = 0; i < WINDOW_PROFILES.length; i++) {
    const p = WINDOW_PROFILES[i]!, choose = abs(family.sub(i)).lessThan(.5);
    profile = choose.select(vec4(p[0], p[1], p[2], p[3]), profile);
    topOffset = choose.select(float(p[4]), topOffset);
  }
  const profW = clamp(max(profile.z, ww.mul(profile.x.add(profile.y.mul(seed)))), .12, .98);
  const profLow = clamp(low.add(profile.w), .035, .45), profHigh = max(profLow.add(.12), min(.98, high.add(topOffset)));
  ww = mix(ww, profW, character); low = mix(low, profLow, character); high = mix(high, profHigh, character);
  const cellSize = vec2(mix(bayW, bayW.mul(2), shop), mix(story, shopH, shop));
  const grid = fuv.div(cellSize), cell = floor(grid), f = fract(grid), fw = max(fwidth(grid), .0001);
  const x0 = mix(float(.5).sub(ww.mul(.5)), .08, shop), x1 = mix(float(.5).add(ww.mul(.5)), .92, shop);
  const y0 = mix(low, .12, shop), y1 = mix(high, .8, shop);
  const window = pulse(f.x, x0, x1, fw.x).mul(pulse(f.y, y0, y1, fw.y)).mul(float(1).sub(roof)).mul(step(.04, g));
  const frameX = max(line(f.x.sub(x0), float(.014)), line(f.x.sub(x1), float(.014)));
  const frameY = max(line(f.y.sub(y0), float(.014)), line(f.y.sub(y1), float(.014)));
  const frame = max(frameX, frameY).mul(float(1).sub(roof));
  const pane = clamp(vec2(f.x.sub(x0).div(max(x1.sub(x0), .05)), f.y.sub(y0).div(max(y1.sub(y0), .05))), 0, 1);
  const home = step(2.5, family).mul(float(1).sub(step(3.5, family))), modern = step(3.5, family), brick = step(1.5, family).mul(float(1).sub(step(2.5, family)));
  const sash = max(line(pane.x.sub(.5), mix(.012, .022, home)), line(pane.y.sub(mix(.73, .5, home)), float(.015)));
  const steel = max(line(fract(pane.x.mul(3)).sub(.5), float(.035)), line(pane.y.sub(.5), float(.018)));
  const mullion = mix(sash, steel, brick).mul(window);
  const glassMask = window.mul(float(1).sub(mullion));
  const sourceColor = attribute("color", "vec3");
  const homePalette = mix(mix(color(0xbab599), color(0x849b8a), step(.36, seed)), color(0x9a8480), step(.72, seed));
  const warmStone = mix(color(0xd8cdb8), color(0xb7a88d), step(.5, family));
  const masonry = mix(warmStone, color(0xa05b43), brick);
  const palette = mix(mix(masonry, homePalette, home), color(0x647a80), modern);
  const wall = mix(sourceColor, palette, character.mul(.68)).toVar();
  const blockM = mix(vec2(1.05, .48), vec2(.56, .24), brick), block = fuv.div(blockM);
  const row = floor(block.y), blockX = block.x.add(mod(row, 2).mul(.5));
  const mortar = max(line(fract(blockX), float(.012)), line(fract(block.y), float(.022))).mul(float(1).sub(modern));
  const brickLod = float(1).sub(smoothstep(.5, 1, max(fwidth(blockX), fwidth(block.y))));
  const tone = hash2(vec2(floor(blockX), row).add(seed.mul(83))).sub(.5).mul(.12).mul(brickLod);
  const wallTint = wall.mul(float(1).add(tone).sub(mortar.mul(.18)));
  const soot = noise2(vec2(fuv.x.mul(1.4), fuv.y.mul(.05))).mul(.12).mul(float(1).sub(smoothstep(0, 150, fuv.y)));
  const course = line(fract(fuv.y.div(story)), float(.025)).mul(float(1).sub(modern));
  const trim = mix(wall.mul(1.15), color(0xc9bd9f), .38);
  const wallCol = mix(wallTint.mul(float(1).sub(soot)), trim, max(course.mul(.6), frame));
  const room = roomInterior(fuv.x, fuv.y, pane, cell, bayW, story, seed, fw).toVar();
  const view = normalize(cameraPosition.sub(positionWorld)), fresnel = pow(float(1).sub(abs(dot(view, normalWorldGeometry))), 3);
  const glass = mix(room.rgb.mul(.42), mix(color(0x34434e), color(0x63747d), fresnel), .35);
  const windows = mix(glass, trim.mul(.65), mullion);
  const bounceBand = smoothstep(0, 14, fuv.y).mul(float(1).sub(smoothstep(22, 75, fuv.y)));
  const bounce = color(0xb07b50).mul(bounceBand).mul(.035).mul(float(1).sub(gpuMaterialUniforms.night));
  m.colorNode = mix(mix(wallCol, windows, window), sourceColor.mul(.72), roof).add(bounce);
  m.roughnessNode = mix(.82, mix(.16, .28, seed), glassMask);
  m.metalnessNode = glassMask.mul(mix(.12, .58, modern));
  m.aoNode = canyonSkyAO(positionWorld.y.sub(meta.y)).mul(mix(1, .75, frame));
  // Height must have its own >=two-pixel ramps. Differentiating the narrower
  // color masks made sills sparkle like rivets at the game's reduced resolution,
  // and their perturbed normals also destabilized shadow normal-bias offsets.
  const ramp = max(fw.mul(2), .02);
  const reliefX = pulse(grid.x, x0, x1, ramp.x);
  const reliefWindow = reliefX.mul(pulse(grid.y, y0, y1, ramp.y));
  const sill = reliefX.mul(pulse(grid.y, y0.sub(.035), y0, ramp.y));
  const bandCoord = fuv.y.div(story);
  const belt = pulse(bandCoord, float(.97), float(1), max(fwidth(bandCoord).mul(2), .02)).mul(float(1).sub(modern));
  const facePixel = max(fwidth(fuv.x), fwidth(fuv.y));
  const brickFace = smoothstep(0, .018, min(fract(blockX), float(1).sub(fract(blockX))).mul(blockM.x))
    .mul(smoothstep(0, .018, min(fract(block.y), float(1).sub(fract(block.y))).mul(blockM.y)))
    .mul(.003).mul(brick).mul(float(1).sub(smoothstep(.006, .012, facePixel)));
  const relief = brickFace.add(sill.mul(.014)).add(belt.mul(.012)).sub(reliefWindow.mul(.012));
  const reliefFade = float(1).sub(smoothstep(18, 140, length(positionWorld.sub(cameraPosition))))
    .mul(float(1).sub(smoothstep(.03, .1, max(fw.x, fw.y)))).mul(float(1).sub(roof));
  m.normalNode = bumpNormal(relief.mul(reliefFade));
  m.emissiveNode = room.rgb.mul(room.a).mul(glassMask).mul(gpuMaterialUniforms.night).mul(.95);
  m.userData.fcGpuKind = "building";
  return m;
}

/** World-metre scored concrete, shared by sidewalk ribbons and neutral land. */
function pavingSurface(p: V2, source: V3): { color: V3; height: F; roughness: F } {
  const grid = p.div(1.5), footprint = max(fwidth(grid), .00001);
  const distance = length(positionWorld.sub(cameraPosition));
  const detail = float(1).sub(smoothstep(30, 180, distance));
  // Integrate the periodic band from an unwrapped coordinate, so a joint has
  // continuous coverage across cell boundaries and converges to its mean in LOD.
  const jointX = pulse(grid.x, float(0), float(.022), footprint.x);
  const jointZ = pulse(grid.y, float(0), float(.022), footprint.y);
  const joints = max(jointX, jointZ).mul(detail);
  const panel = mix(.5, hash2(floor(grid)), float(1).sub(smoothstep(.15, .6, max(footprint.x, footprint.y))));
  const tone = noise2(p.mul(.48));
  const pixel = length(fwidth(p));
  const grainVisible = float(1).sub(smoothstep(.02, .07, pixel));
  const grain = noise2(p.mul(14)).sub(.5).mul(grainVisible);
  const concrete = mix(color(0x85837b), color(0xa19c90), tone);
  const base = mix(source, concrete, .74).mul(panel.sub(.5).mul(.16).add(1));
  const wet = clamp(gpuMaterialUniforms.wet, 0, 1);
  const damp = noise2(p.mul(.18).add(vec2(7.4, -13.1))).mul(wet);
  const albedo = base.mul(float(1).sub(joints.mul(.38))).add(grain.mul(.025))
    .mul(mix(1, .74, max(wet.mul(.35), damp)));
  // Normal relief uses a wider filter than color, as with the facade sills.
  const ramp = max(footprint.mul(2), .012);
  const reliefJoint = max(pulse(grid.x, float(0), float(.022), ramp.x), pulse(grid.y, float(0), float(.022), ramp.y));
  const reliefFade = float(1).sub(smoothstep(18, 100, distance));
  const height = noise2(p.mul(4.5)).sub(.5).mul(.002).mul(grainVisible)
    .sub(reliefJoint.mul(.009)).mul(reliefFade).mul(float(1).sub(wet.mul(.6)));
  return { color: albedo, height, roughness: mix(float(.92).sub(panel.mul(.055)), .48, damp) };
}

function roadMaterial(source: THREE.Material, ribbons: boolean, freeway: boolean): CityNodeMaterial {
  const m = common(source); m.vertexColors = false;
  const p = positionWorld.xz, pixel = length(fwidth(p)), dist = length(positionWorld.sub(cameraPosition));
  const vcol = attribute("color", "vec3"), maximum = max(vcol.r, max(vcol.g, vcol.b));
  const chroma = maximum.sub(min(vcol.r, min(vcol.g, vcol.b))).div(max(maximum, .001));
  const asphaltMask = float(1).sub(smoothstep(.12, .19, maximum)).mul(float(1).sub(smoothstep(.25, .5, chroma)));
  const grain = mix(.5, noise2(p.mul(16)), float(1).sub(smoothstep(.02, .06, pixel)));
  const fine = mix(.5, noise2(p.mul(3.2)), float(1).sub(smoothstep(.12, .4, pixel)));
  const patch = noise2(p.mul(.18)), oil = smoothstep(.52, .84, noise2(p.mul(.42))).mul(float(1).sub(smoothstep(22, 240, dist)));
  const tar = float(1).sub(smoothstep(0, .04, abs(patch.sub(.52)))).mul(.28);
  let asphalt: V3 = mix(color(0x2b2e33), color(0x464a51), fine.mul(.36).add(grain.mul(.22)).add(patch.mul(.26))).mul(float(1).sub(oil.mul(.3))).mul(float(1).sub(tar));
  if (ribbons) {
    const ruv = uv(), dx = positionWorld.dFdx(), dy = positionWorld.dFdy(), ux = ruv.dFdx(), uy = ruv.dFdy();
    const det = ux.x.mul(uy.y).sub(uy.x.mul(ux.y));
    const width = clamp(length(dx.mul(uy.y).sub(dy.mul(ux.y))).div(max(abs(det), .00001)), 4, 60);
    const halfWidth = float(.07).div(width), dash = pulse(fract(ruv.y.div(freeway ? 12 : 9)), float(0), float(.42), fwidth(ruv.y.div(freeway ? 12 : 9)));
    const stripe = freeway ? max(line(ruv.x.sub(1 / 3), halfWidth), line(ruv.x.sub(2 / 3), halfWidth)) : line(ruv.x.sub(.5), halfWidth).mul(step(7, width));
    asphalt = mix(asphalt, color(0xcac8b9), stripe.mul(dash));
  }
  const paving = pavingSurface(p, vcol);
  // Keep colored lane paint and very bright markings outside the concrete palette.
  const neutral = float(1).sub(smoothstep(.2, .4, chroma)).mul(float(1).sub(smoothstep(.55, .72, maximum)));
  const concrete = mix(vcol, paving.color, neutral);
  const wet = clamp(gpuMaterialUniforms.wet, 0, 1), puddle = smoothstep(.58, .77, noise2(p.mul(.13))).mul(wet);
  m.colorNode = mix(concrete, asphalt.mul(mix(1, .62, max(wet.mul(.5), puddle))), asphaltMask);
  m.roughnessNode = mix(mix(.82, paving.roughness, neutral.mul(float(1).sub(asphaltMask))), mix(.38, .12, puddle), wet);
  m.metalnessNode = puddle.mul(.5);
  const height = noise2(p.mul(8.5)).sub(.5).mul(.0032).mul(float(1).sub(smoothstep(.025, .08, pixel)));
  m.normalNode = bumpNormal(mix(paving.height.mul(neutral), height, asphaltMask).mul(float(1).sub(puddle)));
  return m;
}

function groundMaterial(source: THREE.Material): CityNodeMaterial {
  const m = common(source); m.vertexColors = false;
  const vcol = attribute("color", "vec3"), p = positionWorld.xz;
  const green = step(vcol.r.mul(1.14), vcol.g).mul(step(vcol.b.mul(1.1), vcol.g));
  const range = max(vcol.r, max(vcol.g, vcol.b)).sub(min(vcol.r, min(vcol.g, vcol.b)));
  const paved = float(1).sub(smoothstep(.035, .12, range)).mul(float(1).sub(green));
  const paving = pavingSurface(p, vcol);
  const grit = noise2(p.mul(5)).sub(.5).mul(.035).mul(float(1).sub(smoothstep(.03, .2, length(fwidth(p)))));
  m.colorNode = mix(vcol.mul(float(1).add(grit)), paving.color, paved);
  m.normalNode = bumpNormal(paving.height.mul(paved));
  m.roughnessNode = mix(.96, paving.roughness, paved); m.aoNode = mix(.78, 1, green);
  return m;
}

export interface GpuCarAppearance { paint: THREE.Color; accent: THREE.Color; style: number }
function carArt(position: V3, style: F): F {
  const side = max(smoothstep(.55, .78, abs(position.x)), smoothstep(1.55, 1.9, abs(position.z)));
  const body = float(1).sub(smoothstep(1.02, 1.15, position.y)).mul(smoothstep(.40, .52, position.y));
  const ribbon = float(1).sub(smoothstep(.075, .11, abs(position.y.sub(.70).sub(sin(position.z.mul(2.2)).mul(.12)))));
  const sun = vec2(position.z.add(.35), position.y.sub(.48));
  const ring = float(1).sub(smoothstep(.055, .085, abs(length(sun).sub(.52))));
  const rays = max(ring, float(1).sub(step(.25, length(sun))));
  const coast = step(.5, fract(position.z.add(position.y.mul(3.1)).mul(.58)));
  const shape = style.lessThan(1.5).select(ribbon, style.lessThan(2.5).select(rays, coast));
  const roof = smoothstep(1.45, 1.60, position.y).mul(float(1).sub(smoothstep(.16, .24, abs(position.x.sub(sin(position.z.mul(1.8)).mul(.25))))));
  return max(side.mul(body).mul(shape).mul(step(.5, style)), roof.mul(step(.5, style)));
}
export function createGpuCarPaint(source: THREE.Material, appearance: GpuCarAppearance): THREE.Material {
  const m = common(source, true), paint = uniform(appearance.paint), accent = uniform(appearance.accent), style = uniform(appearance.style);
  m.vertexColors = false; m.colorNode = mix(paint, accent, carArt(positionGeometry, style));
  if (m instanceof MeshPhysicalNodeMaterial) { m.clearcoat = 1; m.clearcoatRoughness = .06; }
  m.userData.fcGpuKind = "car-paint"; m.userData.fcCarAppearance = appearance;
  return m;
}

export function createGpuPackedMaterial(slots: boolean, vehicles: boolean, lightK: THREE.Vector4): THREE.Material {
  const m = slots ? new MeshStandardNodeMaterial() : new MeshPhysicalNodeMaterial();
  m.name = slots ? "fc:agent-people:node" : vehicles ? "fc:agent-vehicle:node" : "fc:agent:node";
  m.vertexColors = false;
  const base = attribute("color", "vec3"), pbr = attribute("fcPbr", "vec3"), cue = attribute("fcCue", "vec4");
  const emit = attribute("fcEmit", "vec4"), light = uniform(lightK), local = positionGeometry;
  let albedo: V3 = base;
  if (slots) {
    const weights = attribute("fcSlot", "vec4"), rest = clamp(float(1).sub(weights.x).sub(weights.y).sub(weights.z).sub(weights.w), 0, 1);
    albedo = base.mul(rest).add(attribute("fcColA", "vec3").mul(weights.x)).add(attribute("fcColB", "vec3").mul(weights.y)).add(attribute("fcColC", "vec3").mul(weights.z)).add(attribute("fcColD", "vec3").mul(weights.w));
  }
  if (vehicles) {
    const paint = attribute("fcCarPaint", "vec4"), accent = attribute("fcCarAccent", "vec3"), painted = step(.5, attribute("fcPaint", "float"));
    albedo = mix(albedo, mix(paint.rgb, accent, carArt(local, paint.w)), painted);
    const wheel = attribute("fcWheel", "vec4"), motion = attribute("fcCarMotion", "vec2");
    const deformWheels = Fn(() => {
      const q = positionGeometry.sub(wheel.xyz).toVar(), n = normalGeometry.toVar();
      If(wheel.w.greaterThan(.5), () => {
        const yy = q.y.mul(cos(motion.x)).add(q.z.mul(sin(motion.x))).toVar();
        q.z.assign(q.z.mul(cos(motion.x)).sub(q.y.mul(sin(motion.x)))); q.y.assign(yy);
        const ny = n.y.mul(cos(motion.x)).add(n.z.mul(sin(motion.x))).toVar();
        n.z.assign(n.z.mul(cos(motion.x)).sub(n.y.mul(sin(motion.x)))); n.y.assign(ny);
        If(wheel.w.greaterThan(1.5), () => {
          const xx = q.x.mul(cos(motion.y)).add(q.z.mul(sin(motion.y))).toVar();
          q.z.assign(q.z.mul(cos(motion.y)).sub(q.x.mul(sin(motion.y)))); q.x.assign(xx);
          const nx = n.x.mul(cos(motion.y)).add(n.z.mul(sin(motion.y))).toVar();
          n.z.assign(n.z.mul(cos(motion.y)).sub(n.x.mul(sin(motion.y)))); n.x.assign(nx);
        });
      });
      positionLocal.assign(wheel.w.greaterThan(.5).select(q.add(wheel.xyz), positionGeometry));
      normalLocal.assign(n);
    });
    // Deform in model space before NodeMaterial applies the instance transform. A
    // positionNode runs after instancing and would need a duplicate matrix buffer,
    // exceeding portable attribute limits for large car batches. Framework instancing
    // now transforms the rotated position and normal once, on either node backend.
    const setupPosition = m.setupPosition.bind(m);
    m.setupPosition = (builder: NodeBuilder) => { deformWheels(); return setupPosition(builder); };
  }
  const oxideNoise = noise2(local.xz.mul(5).add(local.y.mul(1.7)));
  const edge = float(1.15).sub(cue.z.mul(1.3)), rust = smoothstep(edge, edge.add(.12), oxideNoise).mul(step(.001, cue.z));
  const oxide = mix(color(0x7c351b), color(0xbf753a), noise2(local.xz.mul(11)));
  m.colorNode = mix(albedo, oxide, rust).mul(float(1).sub(cue.w.mul(.3)));
  m.roughnessNode = mix(mix(pbr.x, .92, rust), .18, cue.w.mul(.75));
  m.metalnessNode = mix(pbr.y, .1, rust);
  const ch = emit.w, head = step(.5, ch).mul(float(1).sub(step(1.5, ch))), tail = step(1.5, ch).mul(float(1).sub(step(2.5, ch))), status = step(2.5, ch);
  const intensity = head.mul(light.x).add(tail.mul(max(light.y, cue.x.mul(.8)))).add(status.mul(light.z)).add(step(.5, ch).mul(cue.y).mul(light.w));
  m.emissiveNode = emit.rgb.mul(intensity);
  if (m instanceof MeshPhysicalNodeMaterial) { m.clearcoatNode = pbr.z.mul(float(1).sub(rust)); m.clearcoatRoughness = .06; }
  m.aoNode = canyonSkyAO(max(local.y, 0));
  m.userData.fcGpuKind = "packed-agent";
  return m;
}

export function createGpuGrassMaterial(blades: boolean): THREE.Material {
  const m = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, name: blades ? "fc:grass-blades:node" : "fc:grass-surface:node" });
  if (blades) {
    m.positionNode = Fn(() => {
      const root = attribute("_grassRoot", "float"), distance = length(positionGeometry.xz.sub(cameraPosition.xz));
      const fade = float(1).sub(smoothstep(70, 110, distance)), height = max(positionGeometry.y.sub(root), 0);
      return vec3(positionGeometry.x.add(sin(gpuMaterialUniforms.time.mul(1.4).add(positionGeometry.x.mul(.23)).add(positionGeometry.z.mul(.17))).mul(height).mul(.12).mul(fade)), root.add(positionGeometry.y.sub(root).mul(fade)), positionGeometry.z);
    })();
  } else {
    const p = positionWorld.xz, pixel = max(length(p.dFdx()), length(p.dFdy()));
    const fine = sin(p.x.mul(19).add(sin(p.y.mul(11)))).mul(sin(p.y.mul(23)));
    const mow = sin(p.x.add(p.y.mul(.18)).mul(.44)).mul(.5).add(.5);
    m.colorNode = vec3(float(.94).add(mow.mul(.055)).add(fine.mul(float(1).sub(smoothstep(.025, .12, pixel))).mul(.045)));
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -1;
  }
  m.aoNode = float(1); m.userData.fcGpuKind = "grass";
  return m;
}

function foliageMaterial(source: THREE.Material, leaf: boolean): CityNodeMaterial {
  const m = common(source); m.vertexColors = true;
  m.roughness = .93; m.metalness = 0;
  m.positionNode = Fn(() => {
    const phase = float(instanceIndex).mul(.731), weight = smoothstep(1.8, 7.5, positionGeometry.y);
    return positionLocal.add(vec3(sin(gpuMaterialUniforms.time.mul(.8).add(phase).add(positionGeometry.y.mul(.7))).mul(.035), 0, cos(gpuMaterialUniforms.time.mul(.63).add(phase)).mul(.025)).mul(weight));
  })();
  m.aoNode = canyonSkyAO(max(positionGeometry.y, 0));
  if (leaf && m.map) { m.maskShadowNode = texture(m.map).a.greaterThan(m.alphaTest || .42); m.side = THREE.DoubleSide; m.alphaToCoverage = true; m.forceSinglePass = true; }
  m.userData.fcGpuKind = leaf ? "foliage-leaf" : "foliage-bark";
  return m;
}

const cache = new WeakMap<THREE.Material, Map<string, THREE.Material>>();
const packedLayouts = new WeakSet<THREE.BufferGeometry>();
/**
 * Packed agent parts carry many semantic fields, but portable WebGPU only guarantees
 * eight vertex-buffer bindings. Share one immutable per-vertex buffer; live per-instance
 * cue, clothing, paint and motion buffers retain their original active-prefix updates.
 * PartMesh owns this geometry wrapper, so prototype/simplifier attributes are not changed.
 */
export function interleaveGpuPackedGeometry(geo: THREE.BufferGeometry): void {
  if (packedLayouts.has(geo) || !geo.hasAttribute("fcPbr")) return;
  const names = Object.keys(geo.attributes).filter(name => {
    const a = geo.getAttribute(name);
    return !(a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute && !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute;
  });
  const attributes = names.map(name => geo.getAttribute(name) as THREE.BufferAttribute);
  if (!attributes.length || attributes.some(a => !(a.array instanceof Float32Array))) return;
  // The installed r186 implementation returns an array; its matching declaration
  // incorrectly describes a singular attribute (confirmed against the bundled source).
  const interleaved = interleaveAttributes(attributes) as unknown as THREE.InterleavedBufferAttribute[] | null;
  if (!interleaved) return;
  names.forEach((name, i) => geo.setAttribute(name, interleaved[i]!));
  packedLayouts.add(geo);
}
function ensure(geo: THREE.BufferGeometry, name: string, values: readonly number[]): void {
  if (geo.getAttribute(name)) return;
  const count = geo.getAttribute("position")?.count ?? 0, array = new Float32Array(count * values.length);
  for (let i = 0; i < count; i++) array.set(values, i * values.length);
  geo.setAttribute(name, new THREE.BufferAttribute(array, values.length));
}
export interface GpuSceneOptions { ground?: (x: number, z: number) => number }
/** Admission-time adaptation; do not traverse the complete scene every frame. */
export function prepareGpuScene(root: THREE.Object3D, _options: GpuSceneOptions = {}): void {
  if (!enabled) return;
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry;
    interleaveGpuPackedGeometry(geo);
    const convert = (source: THREE.Material): THREE.Material => {
      if ((source as { isNodeMaterial?: boolean }).isNodeMaterial || source.userData.skipGpuAdapter) return source;
      const name = source.name ?? "", tagged = source.userData.fcGpuKind as string | undefined;
      const kind = /^fc:building/.test(name) ? "building" : name === "fc:road-paint" ? "road-paint" : /^fc:(road|freeway)/.test(name) ? "road" : name === "fc:ground" ? "ground" : tagged ?? name;
      if (kind === "building" || kind === "road" || kind === "ground") {
        ensure(geo, "color", [.6, .56, .5]);
        if (!geo.getAttribute("normal")) geo.computeVertexNormals();
      }
      if (kind === "building") { ensure(geo, "uv", [0, 0]); ensure(geo, "_facade", [0, 0, 0, 1]); ensure(geo, "_building", [-1, 0, 0, -1]); }
      let variants = cache.get(source); if (!variants) { variants = new Map(); cache.set(source, variants); }
      const variant = `${kind}:${geo.hasAttribute("uv")}:${geo.hasAttribute("color")}`;
      const hit = variants.get(variant); if (hit) return hit;
      let target: THREE.Material;
      if (kind === "building") target = buildingMaterial(source);
      else if (kind === "road") target = roadMaterial(source, /-uv$/.test(name) && geo.hasAttribute("uv"), /^fc:freeway/.test(name));
      else if (kind === "road-paint") {
        const paint = common(source); paint.roughnessNode = mix(.62, .2, gpuMaterialUniforms.wet);
        paint.colorNode = vec3(mix(1, .78, gpuMaterialUniforms.wet)); target = paint;
      }
      else if (kind === "ground") target = groundMaterial(source);
      else if (kind === "foliage-leaf" || name === "sf-tree-leaves") target = foliageMaterial(source, true);
      else if (kind === "foliage-bark" || name === "sf-tree-bark") target = foliageMaterial(source, false);
      else if (name === "fc:grass-surface" || name === "fc:grass-blades") target = createGpuGrassMaterial(name.endsWith("blades"));
      else if (source.userData.fcCarAppearance) target = createGpuCarPaint(source, source.userData.fcCarAppearance as GpuCarAppearance);
      else if ((source as THREE.MeshStandardMaterial).isMeshStandardMaterial) target = common(source, (source as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial);
      else if ((source as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        const s = source as THREE.MeshBasicMaterial, basic = new MeshBasicNodeMaterial();
        basic.name = s.name; basic.color = s.color; basic.map = s.map; basic.alphaMap = s.alphaMap; basic.transparent = s.transparent; basic.opacity = s.opacity;
        basic.alphaTest = s.alphaTest; basic.alphaToCoverage = s.alphaToCoverage; basic.alphaHash = s.alphaHash;
        basic.side = s.side; basic.depthWrite = s.depthWrite; basic.depthTest = s.depthTest; basic.vertexColors = s.vertexColors; basic.toneMapped = s.toneMapped; basic.fog = s.fog;
        basic.blending = s.blending; basic.blendSrc = s.blendSrc; basic.blendDst = s.blendDst; basic.blendEquation = s.blendEquation;
        basic.blendSrcAlpha = s.blendSrcAlpha; basic.blendDstAlpha = s.blendDstAlpha; basic.blendEquationAlpha = s.blendEquationAlpha;
        basic.premultipliedAlpha = s.premultipliedAlpha; basic.polygonOffset = s.polygonOffset; basic.polygonOffsetFactor = s.polygonOffsetFactor; basic.polygonOffsetUnits = s.polygonOffsetUnits;
        Object.defineProperty(basic, "opacity", { configurable: true, enumerable: true, get: () => s.opacity, set: (value: number) => { s.opacity = value; } });
        target = basic;
      } else return source;
      target.name ||= `${name}:node`; target.userData.fcGpuMaterial = true; variants.set(variant, target);
      // Tile/model owners still dispose the original material they admitted. Keep the
      // renderer's cached node counterpart under that same lifecycle ownership.
      source.addEventListener("dispose", () => { target.dispose(); variants!.delete(variant); });
      return target;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
}
