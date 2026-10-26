import { describe, expect, it } from "vitest";
import { formatCompass } from "../../src/ui/compass.ts";

const radians = (degrees: number): number => degrees * Math.PI / 180;

describe("compass heading presentation", () => {
  it.each([
    [0, "N", "N · 000°"],
    [45, "NE", "NE · 045°"],
    [90, "E", "E · 090°"],
    [135, "SE", "SE · 135°"],
    [180, "S", "S · 180°"],
    [225, "SW", "SW · 225°"],
    [270, "W", "W · 270°"],
    [315, "NW", "NW · 315°"],
  ])("formats %d degrees clockwise from north", (degrees, direction, label) => {
    const result = formatCompass(radians(Number(degrees)));
    expect(result.bearing).toBe(degrees);
    expect(result.direction).toBe(direction);
    expect(result.label).toBe(label);
    expect(result.rotation).toBeCloseTo(Number(degrees), 8);
  });

  it.each([
    [-45, 315, "NW"],
    [-360, 0, "N"],
    [-765, 315, "NW"],
    [360, 0, "N"],
    [765, 45, "NE"],
  ])("normalizes %d degree negative and multi-turn headings", (degrees, bearing, direction) => {
    const result = formatCompass(radians(Number(degrees)));
    expect(result.bearing).toBe(bearing);
    expect(result.direction).toBe(direction);
    expect(result.rotation).toBeGreaterThanOrEqual(0);
    expect(result.rotation).toBeLessThan(360);
  });

  it("changes octants at the half-way bearing while keeping the needle unrounded", () => {
    expect(formatCompass(radians(22.49)).direction).toBe("N");
    expect(formatCompass(radians(22.5)).direction).toBe("NE");
    expect(formatCompass(radians(67.49)).direction).toBe("NE");
    expect(formatCompass(radians(67.5)).direction).toBe("E");
    expect(formatCompass(radians(337.49)).direction).toBe("NW");
    expect(formatCompass(radians(337.5)).direction).toBe("N");
    const result = formatCompass(radians(44.75));
    expect(result.label).toBe("NE · 045°");
    expect(result.rotation).toBeCloseTo(44.75, 8);
  });

  it("wraps the rounded bearing at north without jumping the needle early", () => {
    const result = formatCompass(radians(359.75));
    expect(result).toMatchObject({ bearing: 0, direction: "N", label: "N · 000°" });
    expect(result.rotation).toBeCloseTo(359.75, 8);
    expect(formatCompass(radians(-.25))).toEqual(result);
    expect(Object.is(formatCompass(-0).bearing, -0)).toBe(false);
    expect(Object.is(formatCompass(-0).rotation, -0)).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])("uses north for nonfinite heading %s", heading => {
    expect(formatCompass(heading)).toEqual({ bearing: 0, direction: "N", label: "N · 000°", rotation: 0 });
  });

  it("keeps very large finite headings within the compass range", () => {
    const result = formatCompass(Number.MAX_VALUE);
    expect(result.bearing).toBeGreaterThanOrEqual(0);
    expect(result.bearing).toBeLessThan(360);
    expect(result.rotation).toBeGreaterThanOrEqual(0);
    expect(result.rotation).toBeLessThan(360);
    expect(result.label).toMatch(/^(N|NE|E|SE|S|SW|W|NW) · \d{3}°$/);
  });
});
