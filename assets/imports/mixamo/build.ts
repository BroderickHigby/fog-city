// Offline FBX -> the existing Rocketbox rig. Raw FBX is never copied to the web build.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as T from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
const root = resolve(import.meta.dirname, "../../..");
// `node build.ts [--set dodge|crowd] [output]`: the player's locomotion bank (by default), or the
// banks every human on the Rocketbox skeleton shares (src/render/human-motion.ts): `dodge`, the
// override's shove and a sidestep's flinch; `crowd`, varied walks and idles for the skinned crowd.
// A clip may be cut to a window of its source in Mixamo's 30 fps frames, first..last (1-based,
// inclusive).
const args = process.argv.slice(2);
const set = args.includes("--set") ? args[args.indexOf("--set") + 1]! : "player";
const output = args.find((a, i) => a !== "--set" && args[i - 1] !== "--set");
type Selection = string | { file: string; first: number; last: number };
const sets: Record<string, { out: string; clips: Record<string, Selection> }> = {
  player: {
    out: "public/models/mixamo-motion.json",
    clips: {
      idle: "Breathing Idle.fbx",
      walk: "Walking.fbx",
      jog: "Jogging.fbx",
      run: "Running.fbx",
    },
  },
  dodge: {
    out: "public/models/anim/mixamo-dodge.json",
    clips: {
      // Staggering back from a shove, cut before any fall.
      stumble: { file: "Stumble Backwards.fbx", first: 1, last: 20 },
      flinch: { file: "Dodging Right.fbx", first: 1, last: 44 },
    },
  },
  crowd: {
    out: "public/models/anim/mixamo-crowd.json",
    clips: {
      walkCasual: { file: "Female Locomotion Pack/walking.fbx", first: 1, last: 30 },
      walkTexting: { file: "Walking While Texting.fbx", first: 1, last: 121 },
      idleHappy: { file: "Happy Idle.fbx", first: 1, last: 61 },
      idleLookAround: { file: "Looking Around.fbx", first: 1, last: 191 },
      idlePhone: { file: "Talking On Phone.fbx", first: 1, last: 300 },
      idleArguing: { file: "Standing Arguing.fbx", first: 1, last: 300 },
      wave: { file: "Waving.fbx", first: 1, last: 17 },
      clap: { file: "Clapping.fbx", first: 1, last: 36 },
    },
  },
};
if (!sets[set]) throw Error(`Unknown set: ${set}`);
const selections = sets[set]!.clips;
const bytes = readFileSync(resolve(root, "public/models/generic-player.glb"));
const converter = readFileSync(import.meta.filename);
const doc = JSON.parse(
  bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString(),
);
function targetRig() {
  const nodes: T.Bone[] = doc.nodes.map(
    (n: {
      name: string;
      translation?: number[];
      rotation?: number[];
      scale?: number[];
      matrix?: number[];
    }) => {
      const b = new T.Bone();
      b.name = T.PropertyBinding.sanitizeNodeName(n.name);
      if (n.matrix)
        new T.Matrix4()
          .fromArray(n.matrix)
          .decompose(b.position, b.quaternion, b.scale);
      else {
        if (n.translation) b.position.fromArray(n.translation);
        if (n.rotation) b.quaternion.fromArray(n.rotation);
        if (n.scale) b.scale.fromArray(n.scale);
      }
      return b;
    },
  );
  doc.nodes.forEach((n: { children?: number[] }, i: number) =>
    n.children?.forEach((j) => nodes[i]!.add(nodes[j]!)),
  );
  const scene = new T.Group();
  doc.scenes[0].nodes.forEach((i: number) => scene.add(nodes[i]!));
  scene.updateMatrixWorld(true);
  return { scene, bones: new Map(nodes.map((b) => [b.name, b])) };
}
const mapping: Record<string, string> = {
  "Bip01 Pelvis": "Hips",
  "Bip01 Spine": "Spine",
  "Bip01 Spine1": "Spine1",
  "Bip01 Spine2": "Spine2",
  "Bip01 Neck": "Neck",
  "Bip01 Head": "Head",
};
for (const [side, long] of [
  ["L", "Left"],
  ["R", "Right"],
] as const) {
  for (const [a, b] of [
    ["Clavicle", "Shoulder"],
    ["UpperArm", "Arm"],
    ["Forearm", "ForeArm"],
    ["Hand", "Hand"],
    ["Thigh", "UpLeg"],
    ["Calf", "Leg"],
    ["Foot", "Foot"],
    ["Toe0", "ToeBase"],
  ] as const)
    mapping[`Bip01 ${side} ${a}`] = long + b;
  for (const [i, finger] of [
    "Thumb",
    "Index",
    "Middle",
    "Ring",
    "Pinky",
  ].entries())
    for (let j = 0; j < 3; j++)
      mapping[`Bip01 ${side} Finger${i}${j === 0 ? "" : j}`] =
        `${long}Hand${finger}${j + 1}`;
}
const yaw = new T.Quaternion().setFromAxisAngle(
  new T.Vector3(0, 1, 0),
  Math.PI,
);
const worldQ = (o: T.Object3D) => o.getWorldQuaternion(new T.Quaternion());
const worldP = (o: T.Object3D) => o.getWorldPosition(new T.Vector3());
const result = [];
for (const [name, selection] of Object.entries(selections)) {
  const file = typeof selection === "string" ? selection : selection.file;
  const data = readFileSync(resolve(root, "assets/mixamo", file));
  const source = new FBXLoader().parse(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    "",
  );
  source.updateMatrixWorld(true);
  const sb = new Map<string, T.Bone>();
  source.traverse((o) => {
    if ((o as T.Bone).isBone) sb.set(o.name, o as T.Bone);
  });
  const target = targetRig();
  const pairs = Object.entries(mapping).map(([a, b]) => ({
    target: target.bones.get(T.PropertyBinding.sanitizeNodeName(a))!,
    source: sb.get("mixamorig" + b)!,
  }));
  if (pairs.some((p) => !p.target || !p.source))
    throw Error(`Incomplete bone mapping: ${file}`);
  const sourceHip = sb.get("mixamorigHips")!,
    targetHip = target.bones.get("Bip01_Pelvis")!;
  const hipRest = worldP(targetHip),
    sourceHipRest = worldP(sourceHip),
    scale = hipRest.y / sourceHipRest.y;
  const rests = pairs.map((p) => {
    const child = p.target.children.find((c) =>
      pairs.some((q) => q.target === c),
    );
    const sourceChild = child
      ? pairs.find((q) => q.target === child)?.source
      : undefined;
    const align = new T.Quaternion();
    if (child && sourceChild) {
      const a = worldP(child).sub(worldP(p.target)).normalize(),
        b = worldP(sourceChild)
          .sub(worldP(p.source))
          .normalize()
          .applyQuaternion(yaw);
      align.setFromUnitVectors(a, b);
    }
    return {
      source: worldQ(p.source),
      target: align.multiply(worldQ(p.target)),
    };
  });
  const clip = source.animations[0]!;
  const mixer = new T.AnimationMixer(source);
  mixer.clipAction(clip).play();
  const from = typeof selection === "string" ? 0 : (selection.first - 1) / 30,
    duration =
      typeof selection === "string"
        ? clip.duration
        : Math.min(clip.duration, (selection.last - 1) / 30) - from;
  const count = Math.max(2, Math.ceil(duration * 30) + 1),
    times = Array.from(
      { length: count },
      (_, i) => (i * duration) / (count - 1),
    );
  const values = pairs.map(() => [] as number[]),
    hipValues: number[] = [];
  for (const time of times) {
    mixer.setTime(from + time);
    source.updateMatrixWorld(true);
    const desired = pairs.map((p, i) =>
      yaw
        .clone()
        .multiply(worldQ(p.source))
        .multiply(rests[i]!.source.clone().invert())
        .multiply(yaw.clone().invert())
        .multiply(rests[i]!.target),
    );
    // Evaluate all world rotations first, then derive locals against the posed parent.
    pairs.forEach((p, i) => {
      const parent = pairs.findIndex((q) => q.target === p.target.parent);
      const parentQ = parent >= 0 ? desired[parent]! : worldQ(p.target.parent!);
      const q = parentQ.clone().invert().multiply(desired[i]!).normalize();
      const previous = values[i]!;
      if (
        previous.length &&
        q.dot(new T.Quaternion().fromArray(previous, previous.length - 4)) < 0
      )
        q.set(-q.x, -q.y, -q.z, -q.w);
      previous.push(...q.toArray().map((v) => Number(v.toFixed(6))));
    });
    const pos = hipRest.clone();
    pos.y += (worldP(sourceHip).y - sourceHipRest.y) * scale;
    targetHip.parent!.worldToLocal(pos);
    hipValues.push(...pos.toArray().map((v) => Number(v.toFixed(6))));
  }
  const tracks: T.KeyframeTrack[] = pairs.map(
    (p, i) =>
      new T.QuaternionKeyframeTrack(
        `${p.target.name}.quaternion`,
        times,
        values[i]!,
      ),
  );
  tracks.push(
    new T.VectorKeyframeTrack(`${targetHip.name}.position`, times, hipValues),
  );
  const out = new T.AnimationClip(name, duration, tracks).optimize();
  // Three creates a random clip UUID. Pin it to all conversion inputs so a
  // source rebuild has identical bytes, while changed rigs/clips get new IDs.
  const id = createHash("sha256").update(converter).update(bytes).update(data).digest().subarray(0, 16);
  id[6] = (id[6]! & 0x0f) | 0x80;
  id[8] = (id[8]! & 0x3f) | 0x80;
  const hex = id.toString("hex");
  const serialized = T.AnimationClip.toJSON(out);
  serialized.uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  result.push(serialized);
  console.log(name, duration.toFixed(3), tracks.length);
  mixer.stopAllAction();
  mixer.uncacheRoot(source);
}
writeFileSync(
  output ?? resolve(root, sets[set]!.out),
  JSON.stringify(
    { version: 1, rig: "rocketbox", fps: 30, clips: result },
    (_key, value) =>
      typeof value === "number" ? Number(value.toFixed(6)) : value,
  ) + "\n",
);
