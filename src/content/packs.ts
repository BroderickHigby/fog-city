// District content packs (content/packs/<district>.json): typed access and the rules that tie
// each pack to its district, the bot tells and the map (docs/ai-layer.md, District content packs).

import bayBridgeApproachJson from "../../content/packs/bay-bridge-approach.json" with { type: "json" };
import dogpatchJson from "../../content/packs/dogpatch.json" with { type: "json" };
import downtownJson from "../../content/packs/downtown.json" with { type: "json" };
import embarcaderoJson from "../../content/packs/embarcadero.json" with { type: "json" };
import fidiJson from "../../content/packs/fidi.json" with { type: "json" };
import fishermansWharfJson from "../../content/packs/fishermans-wharf.json" with { type: "json" };
import marinaJson from "../../content/packs/marina.json" with { type: "json" };
import missionBayJson from "../../content/packs/mission-bay.json" with { type: "json" };
import northBeachJson from "../../content/packs/north-beach.json" with { type: "json" };
import rinconHillJson from "../../content/packs/rincon-hill.json" with { type: "json" };
import somaJson from "../../content/packs/soma.json" with { type: "json" };
import { contentHash, checkBarks, type Bark, type Provenance } from "./barks.ts";
import { BOT_TELLS, botWithLocalTell, type BotTellsFile } from "./botTells.ts";
import { lintFit } from "./lint.ts";
import { DISTRICTS, PROTECTED_AREAS, pointInPolygon } from "./places.ts";

export interface PackBounty {
  id: string;
  archetype: string;
  level: number;
  localTell?: string;
  crew: number;
  lastSeen: { label: string; lat: number; lon: number };
  posting: string;
  tellHint: string;
}

export interface PackAd {
  id: string;
  surface: "billboard" | "busWrap";
  headline: string;
  subline: string;
}

export interface DistrictPack {
  version: 1;
  district: string;
  provenance: Provenance;
  robotBarks: Bark[];
  peopleLines: Bark[];
  bounties: PackBounty[];
  ads: PackAd[];
}

/** Every pack, by district id. A new pack file must be added here (the packs test checks the directory). */
export const PACKS: Readonly<Record<string, DistrictPack>> = {
  "bay-bridge-approach": bayBridgeApproachJson as unknown as DistrictPack,
  "dogpatch": dogpatchJson as unknown as DistrictPack,
  "downtown": downtownJson as unknown as DistrictPack,
  "embarcadero": embarcaderoJson as unknown as DistrictPack,
  "fidi": fidiJson as unknown as DistrictPack,
  "fishermans-wharf": fishermansWharfJson as unknown as DistrictPack,
  "marina": marinaJson as unknown as DistrictPack,
  "mission-bay": missionBayJson as unknown as DistrictPack,
  "north-beach": northBeachJson as unknown as DistrictPack,
  "rincon-hill": rinconHillJson as unknown as DistrictPack,
  "soma": somaJson as unknown as DistrictPack,
};

/** The text a pack's provenance hash covers, in file order. */
export function packTexts(p: DistrictPack): string[] {
  return [
    ...p.robotBarks.map((b) => b.text),
    ...p.peopleLines.map((b) => b.text),
    ...p.bounties.map((b) => b.posting),
    ...p.ads.map((a) => `${a.headline}|${a.subline}`),
  ];
}

/** Every rule a pack must satisfy beyond its schema. Empty means shippable. */
export function checkPack(p: DistrictPack, tells: BotTellsFile = BOT_TELLS): string[] {
  const errs: string[] = [];
  const where = `pack ${p.district}`;
  const d = DISTRICTS.find((x) => x.id === p.district);
  if (!d) return [`${where}: no such district in content/districts.json`];
  const area = PROTECTED_AREAS.find((a) => a.id === p.district);
  const excludedDistrict = area?.excluded === true;
  if (p.robotBarks.length < 40) errs.push(`${where}: ${p.robotBarks.length} robot barks, needs 40`);
  if (!excludedDistrict && p.peopleLines.length < 40) errs.push(`${where}: ${p.peopleLines.length} people lines, needs 40`);
  if (excludedDistrict && p.peopleLines.length > 0) errs.push(`${where}: an excluded area uses the shared people pool only`);
  errs.push(...checkBarks([...p.robotBarks, ...p.peopleLines], where));
  for (const b of [...p.robotBarks, ...p.peopleLines]) if (!b.id.startsWith(`${p.district}-`)) errs.push(`${where}: id ${b.id} must start with the district id`);
  for (const b of p.robotBarks) if (!/Robot$/.test(b.speaker)) errs.push(`${where}: robot bark ${b.id} has speaker ${b.speaker}`);
  for (const b of p.peopleLines) if (/Robot$/.test(b.speaker)) errs.push(`${where}: people line ${b.id} is spoken by a robot`);

  // The bounty set.
  if (!p.bounties.some((b) => b.localTell !== undefined)) errs.push(`${where}: the bounty set needs at least one template with the local tell`);
  for (const b of p.bounties) {
    const at = `${where} bounty ${b.id}`;
    const a = tells.archetypes.find((x) => x.id === b.archetype);
    if (!a) {
      errs.push(`${at}: unknown archetype ${b.archetype}`);
      continue;
    }
    if (a.kind !== "bad") errs.push(`${at}: a bounty is always a bad robot`);
    if (b.localTell !== undefined) {
      const t = tells.tells.find((x) => x.id === b.localTell);
      if (!t) errs.push(`${at}: unknown local tell ${b.localTell}`);
      else if (!t.districts?.includes(p.district)) errs.push(`${at}: ${b.localTell} is not local to ${p.district}`);
      else {
        try {
          botWithLocalTell(b.archetype, b.level, b.localTell, tells);
        } catch (e) {
          errs.push(`${at}: ${(e as Error).message}`);
        }
      }
    }
    const pt = [b.lastSeen.lat, b.lastSeen.lon] as const;
    if (!pointInPolygon(pt, d.polygon)) errs.push(`${at}: last seen ${b.lastSeen.label} lies outside ${d.name}`);
    for (const pa of PROTECTED_AREAS) {
      if (pointInPolygon(pt, pa.polygon) && b.crew > 1) errs.push(`${at}: a crew bounty in ${pa.name}; protected areas post single baseline robots`);
    }
  }

  // Ad copy fits its slot with the longest product name.
  for (const ad of p.ads) {
    const [h, s] = ad.surface === "billboard" ? (["billboardHeadline", "billboardSubline"] as const) : (["busWrapHeadline", "busWrapSubline"] as const);
    for (const i of [...lintFit(ad.headline, h), ...lintFit(ad.subline, s)]) errs.push(`${where} ad ${ad.id}: ${i.message}`);
  }
  if (p.provenance.contentHash !== contentHash(packTexts(p))) errs.push(`${where}: provenance contentHash is stale; regenerate it`);
  return errs;
}
