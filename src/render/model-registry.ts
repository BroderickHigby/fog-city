import { VEHICLE_MODEL_FILES } from "./vehicle-models.ts";
// Model registry: a key ("player-car", "robotaxi", "landmark:ferry-building") maps to a
// glTF file that may or may not exist yet. Other tracks produce the files on their own
// schedule, so a missing or broken file is normal, not an error: the registry hands out a
// procedural fallback and keeps going.
//
// Generic over the model type so the rules are unit-tested without WebGL
// (tests/render/model-registry.test.ts); the scene instantiates it with THREE.Object3D.

export type ModelSource = "file" | "fallback";

export interface ResolvedModel<T> {
  model: T;
  source: ModelSource;
  /** Why the file was not used, when source is "fallback". */
  reason?: string;
}

export interface RegistryOptions<T> {
  /** Loads and parses one file. Rejects when the file is missing or unreadable. */
  load: (url: string) => Promise<T>;
  /** Builds the stand-in for a key. Called once per instance. */
  fallback: (key: string) => T;
  /** Makes an independent instance of a loaded prototype. */
  clone: (prototype: T) => T;
  /**
   * URLs known to exist (e.g. from a build-time listing of public/models). When given, a
   * URL outside it is not requested at all, so missing files cost no request and no
   * console noise. null = unknown: try every URL.
   */
  available?: ReadonlySet<string> | null;
}

/**
 * Well-known model keys and where their files go (paths under public/; the assets track's
 * files, assets/blender/README.md). People have no model yet: person.ts builds them.
 */
export const MODEL_FILES: Readonly<Record<string, string>> = Object.freeze({
  ...VEHICLE_MODEL_FILES,
  "player-car": "models/civilian-car.glb",
  robotaxi: "models/robotaxi.glb",
  robot: "models/errand-robot.glb",
  "sidewalk-bot": "models/sidewalk-bot.glb",
  bus: "models/muni-bus.glb",
});

export class ModelRegistry<T> {
  private urls = new Map<string, string>();
  private pending = new Map<string, Promise<ResolvedPrototype<T>>>();
  private settled = new Map<string, ResolvedPrototype<T>>();
  private opts: RegistryOptions<T>;

  constructor(opts: RegistryOptions<T>, files: Readonly<Record<string, string>> = MODEL_FILES) {
    this.opts = opts;
    for (const [k, u] of Object.entries(files)) this.register(k, u);
  }

  register(key: string, url: string): void {
    const prev = this.urls.get(key);
    if (prev === url) return;
    this.urls.set(key, url);
    this.pending.delete(key);
    this.settled.delete(key);
  }

  url(key: string): string | undefined {
    return this.urls.get(key);
  }

  /** "unknown" until a get() for the key has settled. */
  status(key: string): ModelSource | "loading" | "unknown" {
    const s = this.settled.get(key);
    if (s) return s.source;
    return this.pending.has(key) ? "loading" : "unknown";
  }

  /** An instance right now: a clone of the file if it already loaded, else a fallback. */
  now(key: string): ResolvedModel<T> {
    const s = this.settled.get(key);
    if (s && s.source === "file") return { model: this.opts.clone(s.prototype as T), source: "file" };
    return { model: this.opts.fallback(key), source: "fallback", reason: s?.reason ?? "not loaded yet" };
  }

  /** A fresh instance: the file's model when it loads, else the fallback. Never rejects. */
  async get(key: string): Promise<ResolvedModel<T>> {
    const p = await this.resolve(key);
    if (p.source === "file") return { model: this.opts.clone(p.prototype as T), source: "file" };
    return { model: this.opts.fallback(key), source: "fallback", reason: p.reason };
  }

  private resolve(key: string): Promise<ResolvedPrototype<T>> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const url = this.urls.get(key);
    let p: Promise<ResolvedPrototype<T>>;
    if (url === undefined) {
      p = Promise.resolve({ source: "fallback", reason: `no file registered for "${key}"` });
    } else if (this.opts.available && !this.opts.available.has(url)) {
      p = Promise.resolve({ source: "fallback", reason: `${url} is not in the asset listing` });
    } else {
      p = this.opts.load(url).then(
        (prototype): ResolvedPrototype<T> => ({ source: "file", prototype }),
        (err: unknown): ResolvedPrototype<T> => ({
          source: "fallback",
          reason: `${url}: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
    const tracked = p.then((r) => {
      if (this.pending.get(key) === tracked) this.settled.set(key, r);
      return r;
    });
    this.pending.set(key, tracked);
    return tracked;
  }
}

interface ResolvedPrototype<T> {
  source: ModelSource;
  prototype?: T;
  reason?: string;
}
