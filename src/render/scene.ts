// Phase 0 renderer: builds buildings straight from collider data and draws a box car.
// The renderer track replaces this with glTF tiles, real art and lighting.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CarState } from "../sim/contract.ts";
import type { TileCollider } from "../sim/world.ts";

export type CameraMode = "chase" | "first-person";

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.5, 6000);
  private cars = new Map<string, THREE.Object3D>();
  cameraMode: CameraMode = "chase";
  private camPos = new THREE.Vector3();
  private camInit = false;

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xb9c7d6);
    this.scene.fog = new THREE.Fog(0xb9c7d6, 250, 1800);
    this.scene.add(new THREE.HemisphereLight(0xe8eef5, 0x5d574f, 1.4));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-300, 500, 200);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.MeshStandardMaterial({ color: 0x8c8a86, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.scene.add(ground);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addTile(tile: TileCollider): void {
    const geoms: THREE.BufferGeometry[] = [];
    for (const b of tile.buildings) {
      if (b.footprint.length < 3 || b.topY <= b.baseY) continue;
      // Shape lives in (x, -z); rotating -90deg about X maps it onto the ground plane.
      const shape = new THREE.Shape(b.footprint.map(([x, z]) => new THREE.Vector2(x, -z)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: b.topY - b.baseY, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.translate(0, b.baseY, 0);
      geoms.push(g.index ? g.toNonIndexed() : g);
    }
    if (geoms.length === 0) return;
    const merged = mergeGeometries(geoms, false);
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.85 }));
    mesh.name = `tile:${tile.tileId}`;
    this.scene.add(mesh);
    for (const g of geoms) g.dispose();
  }

  private carObject(id: string): THREE.Object3D {
    let obj = this.cars.get(id);
    if (!obj) {
      obj = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 1.1, 4.4),
        new THREE.MeshStandardMaterial({ color: 0xc9302c, roughness: 0.5, metalness: 0.2 }),
      );
      body.position.y = 0.75;
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.7, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x1e2630, roughness: 0.3 }),
      );
      cabin.position.set(0, 1.55, 0.2);
      obj.add(body, cabin);
      this.scene.add(obj);
      this.cars.set(id, obj);
    }
    return obj;
  }

  /** heading: compass bearing (clockwise from north/-z). Model faces -z at rotation 0. */
  setCar(id: string, c: Pick<CarState, "x" | "y" | "z" | "heading">): void {
    const obj = this.carObject(id);
    obj.position.set(c.x, c.y, c.z);
    obj.rotation.y = -c.heading;
  }

  follow(c: Pick<CarState, "x" | "y" | "z" | "heading">, dtSeconds: number): void {
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    if (this.cameraMode === "first-person") {
      this.camera.position.set(c.x + fx * 0.3, c.y + 1.45, c.z + fz * 0.3);
      this.camera.lookAt(c.x + fx * 30, c.y + 1.2, c.z + fz * 30);
      this.camInit = false;
      return;
    }
    const target = new THREE.Vector3(c.x - fx * 9, c.y + 4, c.z - fz * 9);
    if (!this.camInit) {
      this.camPos.copy(target);
      this.camInit = true;
    } else {
      this.camPos.lerp(target, 1 - Math.exp(-dtSeconds * 6));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(c.x + fx * 6, c.y + 1.2, c.z + fz * 6);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
