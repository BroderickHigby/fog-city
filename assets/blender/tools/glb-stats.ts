// Triangle counts and sizes of the hero GLBs as exported, read back from the files with the
// same reader the tests use (tests/assets/glb.ts). Blender's own count (fc.tri_count) is
// taken before export and can be a few triangles higher: the exporter drops degenerate ones.
//
//   node assets/blender/tools/glb-stats.ts                    # every public/models/*.glb
//   node assets/blender/tools/glb-stats.ts path/to/model.glb  # given files

import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { allPositions, box, loadModelFrom, nodePositions, sceneNodes, triangleCount } from "../../../tests/assets/glb.ts";

const root = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const dir = join(root, "public", "models");
const files = args.length
  ? args.map((a) => resolve(a))
  : readdirSync(dir)
      .filter((f) => f.endsWith(".glb"))
      .sort()
      .map((f) => join(dir, f));

for (const file of files) {
  const { doc } = await loadModelFrom(file);
  const all = box(allPositions(doc));
  const parts = sceneNodes(doc)
    .filter((n) => n.getMesh())
    .map((n) => {
      let t = 0;
      for (const p of n.getMesh()!.listPrimitives()) {
        const idx = p.getIndices();
        t += (idx ? idx.getCount() : (p.getAttribute("POSITION")?.getCount() ?? 0)) / 3;
      }
      return { name: n.getName(), tris: t, points: nodePositions(n).length };
    })
    .filter((p) => p.points > 0)
    .sort((a, b) => b.tris - a.tris);
  const top = parts
    .slice(0, 4)
    .map((p) => `${p.name} ${p.tris}`)
    .join(", ");
  const [x, y, z] = all.size.map((v) => v.toFixed(2));
  console.log(
    `[glb] ${basename(file)}: ${triangleCount(doc)} tris (${top}${parts.length > 4 ? ", ..." : ""}), ` +
      `x${x} y(up)${y} z(depth)${z} m, ${Math.round(statSync(file).size / 1024)} KiB`,
  );
}
