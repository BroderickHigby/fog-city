import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ACTIVITY_RULES } from "../content/gameplay.ts";
import { PLAIN_WORDS_BOARDS, PLAIN_WORDS_ID, PLAIN_WORDS_LADDER } from "../sim/activities/plain-words.ts";
import type { SimState } from "../sim/contract.ts";
import { retireRenderTree } from "./renderer-warmup.ts";

/** Original wooden A-frames; their presentation never adds a physical blocking body. */
export const PLAIN_WORDS_BOARD_DIMENSIONS = Object.freeze({ width: .8, height: 1.18, depth: .46 });
const CAPACITY = PLAIN_WORDS_BOARDS.length;
const TILT = .17, PANEL_HEIGHT = 1.1, PANEL_DEPTH = .06;
const PANEL_Y = PANEL_HEIGHT / 2 * Math.cos(TILT) + PANEL_DEPTH / 2 * Math.sin(TILT);
const PANEL_Z = .10;
const TEXTURE_WIDTH = 256, TEXTURE_HEIGHT = 384;

interface BoardPlace { id: string; x: number; z: number; headingDeg: number }
interface Placement { id: string; frame: THREE.Matrix4; labels: readonly THREE.Matrix4[]; bars: readonly THREE.Matrix4[] }
interface LabelBatch { mesh: THREE.InstancedMesh; material: THREE.MeshBasicMaterial; texture: THREE.Texture | null }

/** Authored compass heading: the board's forward face is -z, as with other game models. */
export function plainWordsBoardTransform(board: BoardPlace, ground: (x: number, z: number) => number): THREE.Matrix4 {
  const y = ground(board.x, board.z);
  return new THREE.Matrix4().makeRotationY(-board.headingDeg * Math.PI / 180).setPosition(board.x, Number.isFinite(y) ? y : 0, board.z);
}

export function plainWordsLabel(word: number): string {
  return word < 0 ? "PLAIN WORDS" : (PLAIN_WORDS_LADDER[word] ?? PLAIN_WORDS_LADDER[0]!).toUpperCase();
}

function frameGeometry(): THREE.BufferGeometry {
  const parts = [-1, 1].map(side => {
    const geometry = new THREE.BoxGeometry(.74, PANEL_HEIGHT, PANEL_DEPTH);
    geometry.rotateX(-side * TILT).translate(0, PANEL_Y, side * PANEL_Z);
    return geometry;
  });
  parts.push(new THREE.BoxGeometry(.8, .045, .08).translate(0, 1.12, 0));
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("Plain Words frame geometry could not be combined");
  merged.computeBoundingBox(); merged.computeBoundingSphere();
  return merged;
}

function faceTransform(side: number, y: number, depth = .036): THREE.Matrix4 {
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -side * TILT);
  if (side < 0) rotation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  // Follow the slanted panel, then sit just outside its wooden face.
  const z = side * (PANEL_Z - Math.sin(TILT) * (y - PANEL_Y) + depth * Math.cos(TILT));
  return new THREE.Matrix4().compose(new THREE.Vector3(0, y + depth * Math.sin(TILT), z), rotation, new THREE.Vector3(1, 1, 1));
}

/** Generated chalk lettering, at most one small texture for each authored word plus clean. */
function labelTexture(label: string, clean: boolean): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_WIDTH; canvas.height = TEXTURE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = clean ? "#e9efe1" : "#142126";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = clean ? "#52745b" : "#e2b66c";
  ctx.lineWidth = 3; ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = clean ? "#375641" : "#e2b66c";
  ctx.font = "bold 14px monospace";
  ctx.fillText(clean ? "THE HYPE IS GONE" : "NOW POWERED BY", canvas.width / 2, 67);
  const words = label.split(" "), lines: string[] = [];
  let line = "";
  ctx.font = "bold 30px monospace";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > canvas.width - 38) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  ctx.fillStyle = clean ? "#203b2b" : "#f9f0da";
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!;
    let size = 30;
    while (size > 16 && ctx.measureText(text).width > canvas.width - 38) { size -= 2; ctx.font = `bold ${size}px monospace`; }
    ctx.fillText(text, canvas.width / 2, 176 + (index - (lines.length - 1) / 2) * 42);
    ctx.font = "bold 30px monospace";
  }
  ctx.fillStyle = clean ? "#52745b" : "#b3c9cb";
  ctx.font = "14px monospace";
  ctx.fillText(clean ? "Just good work." : "Wash the hype away.", canvas.width / 2, 290);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 2;
  texture.name = `plain-words:${label}`;
  return texture;
}

/**
 * Nothing is allocated on the GPU until a local Plain Words run starts. A run has twenty
 * frames, two readable faces per board and one pooled progress strip. Word batches are
 * bounded by the five-rung ladder plus clean, retained for reuse and released on disposal.
 */
export class PlainWordsLayer {
  readonly root = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly ground: (x: number, z: number) => number;
  private frames: THREE.InstancedMesh | undefined;
  private feedback: THREE.InstancedMesh | undefined;
  private frameMaterial: THREE.MeshStandardMaterial | undefined;
  private feedbackMaterial: THREE.MeshBasicMaterial | undefined;
  private labelGeometry: THREE.PlaneGeometry | undefined;
  private readonly labels = new Map<string, LabelBatch>();
  private placements: Placement[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly scale = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private disposed = false;

  constructor(scene: THREE.Scene, ground: (x: number, z: number) => number) {
    this.scene = scene; this.ground = ground;
    this.root.name = "plain-words-boards"; this.root.visible = false;
  }

  private allocate(): void {
    if (this.frames) return;
    this.frameMaterial = new THREE.MeshStandardMaterial({ color: 0x956e43, roughness: .9, metalness: 0 });
    this.frames = new THREE.InstancedMesh(frameGeometry(), this.frameMaterial, CAPACITY);
    this.frames.name = "plain-words-frames"; this.frames.count = 0; this.frames.frustumCulled = false;
    this.frames.receiveShadow = true;
    this.labelGeometry = new THREE.PlaneGeometry(.64, .92);
    this.feedbackMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.feedback = new THREE.InstancedMesh(new THREE.PlaneGeometry(.60, .045), this.feedbackMaterial, CAPACITY * 2);
    this.feedback.name = "plain-words-wash-progress"; this.feedback.count = 0; this.feedback.frustumCulled = false;
    this.feedback.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.placements = PLAIN_WORDS_BOARDS.map(board => {
      const frame = plainWordsBoardTransform(board, this.ground);
      return { id: board.id, frame,
        labels: [1, -1].map(side => frame.clone().multiply(faceTransform(side, PANEL_Y))),
        bars: [1, -1].map(side => frame.clone().multiply(faceTransform(side, .16, .041))) };
    });
    this.root.add(this.frames, this.feedback);
    this.scene.add(this.root);
  }

  private label(word: number): LabelBatch {
    const key = plainWordsLabel(word), known = this.labels.get(key);
    if (known) return known;
    const texture = labelTexture(key, word < 0);
    const material = new THREE.MeshBasicMaterial({ map: texture, color: texture ? 0xffffff : word < 0 ? 0xe9efe1 : 0x142126, toneMapped: false });
    const mesh = new THREE.InstancedMesh(this.labelGeometry!, material, CAPACITY * 2);
    mesh.name = `plain-words-label:${key}`; mesh.userData.label = key;
    mesh.count = 0; mesh.frustumCulled = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const batch = { mesh, material, texture };
    this.labels.set(key, batch); this.root.add(mesh);
    return batch;
  }

  update(state: SimState, playerId: string): void {
    if (this.disposed) return;
    const own = state.ext.activities?.players[playerId];
    const run = own?.activeActivityId === PLAIN_WORDS_ID ? own.plainWords : undefined;
    this.root.visible = !!run;
    if (!run) return;
    this.allocate();
    this.frames!.count = 0; this.feedback!.count = 0;
    for (const batch of this.labels.values()) batch.mesh.count = 0;
    for (const place of this.placements) {
      const board = run.boards.find(candidate => candidate.id === place.id);
      if (!board) continue;
      this.frames!.setMatrixAt(this.frames!.count++, place.frame);
      const batch = this.label(board.word);
      for (const face of place.labels) batch.mesh.setMatrixAt(batch.mesh.count++, face);
      const progress = board.word < 0 ? 1 : Math.max(0, Math.min(1, board.wash / (ACTIVITY_RULES.plainWords.boardWashS * 60)));
      if (progress > 0) {
        this.color.setHex(board.word < 0 ? 0x64c88b : 0x60cce7);
        this.scale.makeScale(progress, 1, 1);
        for (const face of place.bars) {
          this.matrix.copy(face).multiply(this.scale);
          const index = this.feedback!.count++;
          this.feedback!.setMatrixAt(index, this.matrix); this.feedback!.setColorAt(index, this.color);
        }
      }
    }
    this.frames!.instanceMatrix.needsUpdate = true;
    this.feedback!.instanceMatrix.needsUpdate = true;
    if (this.feedback!.instanceColor) this.feedback!.instanceColor.needsUpdate = true;
    for (const batch of this.labels.values()) batch.mesh.instanceMatrix.needsUpdate = true;
  }

  info(): { boards: number; drawCalls: number; triangles: number } {
    if (this.disposed || !this.root.visible || !this.frames) return { boards: 0, drawCalls: 0, triangles: 0 };
    let drawCalls = 0, triangles = 0;
    for (const mesh of [this.frames, this.feedback!, ...Array.from(this.labels.values(), batch => batch.mesh)]) {
      if (!mesh.count) continue;
      drawCalls++; triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3 * mesh.count;
    }
    return { boards: this.frames.count, drawCalls, triangles };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.root.visible = false;
    void retireRenderTree(this.root, () => {
      this.frames?.dispose(); this.frames?.geometry.dispose(); this.frameMaterial?.dispose();
      this.feedback?.dispose(); this.feedback?.geometry.dispose(); this.feedbackMaterial?.dispose();
      for (const batch of this.labels.values()) { batch.mesh.dispose(); batch.material.dispose(); batch.texture?.dispose(); }
      this.labelGeometry?.dispose(); this.labels.clear(); this.placements = []; this.root.clear();
    });
  }
}
