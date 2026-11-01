import { describe,expect,it,vi } from "vitest";
import { loadLawnData } from "../../src/io/lawn-data.ts";

describe("optional terrain lawn loading",()=>{
  it("resolves the registered layer through the same loose/packed asset API",async()=>{
    const doc={grass:[]};
    const json=vi.fn().mockResolvedValueOnce({layers:{grass:"lawns.json"}}).mockResolvedValueOnce(doc);
    expect(await loadLawnData({json},"tiles/sf/")).toBe(doc);
    expect(json.mock.calls.map(c=>c[0])).toEqual(["tiles/sf/street-detail.json","tiles/sf/lawns.json"]);
  });
  it("keeps worlds without optional lawn data working",async()=>{
    for(const json of [vi.fn().mockRejectedValue(new Error("absent")),vi.fn().mockResolvedValue(null),vi.fn().mockResolvedValue({layers:{}})]){
      expect(await loadLawnData({json},"tiles/dev/")).toBeNull();expect(json).toHaveBeenCalledTimes(1);
    }
  });
  it("reports a missing registered layer without breaking boot",async()=>{
    const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
    const json=vi.fn().mockResolvedValueOnce({layers:{grass:"lawns.json"}}).mockRejectedValueOnce(new Error("missing"));
    try { expect(await loadLawnData({json},"tiles/sf/")).toBeNull();expect(warning).toHaveBeenCalledWith(expect.stringContaining("lawns.json")); }
    finally { warning.mockRestore(); }
  });
});
