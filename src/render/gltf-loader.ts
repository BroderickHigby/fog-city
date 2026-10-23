// The one GLTFLoader set-up that reads the pipeline's tiles (public/tiles/<world>/*.glb).
// Tiles are meshopt-compressed (EXT_meshopt_compression, decoded by the WebAssembly decoder
// three.js ships) and quantised (KHR_mesh_quantization, which GLTFLoader reads natively).
// Every tile loader must come from here, or compressed tiles fail to load.

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export function createTileLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
