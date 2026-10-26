import { describe, expect, it } from "vitest";
import { createIcon, type IconName } from "../../src/ui/icons.ts";

// No browser or layout is needed to verify the namespace and accessible factory contract.
class SvgNode {
  readonly attributes = new Map<string, string>();
  readonly children: SvgNode[] = [];
  readonly namespace: string;
  readonly tagName: string;
  constructor(namespace: string, tagName: string) { this.namespace = namespace; this.tagName = tagName; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  append(child: SvgNode): void { this.children.push(child); }
}
const doc = { createElementNS: (ns: string, tag: string) => new SvgNode(ns, tag) } as unknown as Document;
const names: IconName[] = [
  "cash", "water", "runway", "threat", "reputation", "status", "map", "phone", "shop",
  "help", "performance", "sun", "moon", "chevronDown", "arrowRight", "close", "more",
];

describe("HUD icons", () => {
  it.each(names)("creates a self-contained decorative %s icon", name => {
    const icon = createIcon(doc, name) as unknown as SvgNode;
    expect(icon.namespace).toBe("http://www.w3.org/2000/svg");
    expect(icon.tagName).toBe("svg");
    expect(Object.fromEntries(icon.attributes)).toMatchObject({
      width: "20", height: "20", viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round",
      "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
      class: "fc-icon", "data-icon": name,
    });
    expect(icon.children.length).toBeGreaterThan(0);
    for (const path of icon.children) {
      expect(path.namespace).toBe(icon.namespace);
      expect(path.tagName).toBe("path");
      expect([...path.attributes.keys()]).toEqual(["d"]);
      expect(path.attributes.get("d")).toMatch(/^[Mm]/);
      expect(path.attributes.get("d")).not.toMatch(/NaN|Infinity/);
    }
  });

  it("returns independent nodes so the same icon can appear in several controls", () => {
    const first = createIcon(doc, "map") as unknown as SvgNode;
    const second = createIcon(doc, "map") as unknown as SvgNode;
    expect(first).not.toBe(second);
    expect(first.children[0]).not.toBe(second.children[0]);
    first.setAttribute("width", "22");
    first.children[0]!.setAttribute("d", "M0 0");
    expect(second.attributes.get("width")).toBe("20");
    expect(second.children[0]!.attributes.get("d")).not.toBe("M0 0");
  });
});
