// Credits: who made the data, music, models, icons and textures the game ships, and under which
// licence. A collapsible section in the pause screen and the phone's Settings app (mount.ts).
// The music list is read from its provenance file; every other entry mirrors a provenance
// README (tests/audio/credits.test.ts checks them against those files).
import musicSources from "../../assets/audio/music-sources.json" with { type: "json" };

export interface CreditEntry {
  /** What it is ("Building footprints, streets, districts"). */
  what: string;
  /** Who made it, as their licence asks to be credited. */
  who: string;
  licence: string;
  /** Where to read more (a source page or the licence). */
  url?: string;
  /** Link the credit text itself (OpenStreetMap's attribution asks for a linked notice). */
  linkWho?: boolean;
}

export interface CreditGroup {
  title: string;
  entries: CreditEntry[];
}

interface MusicSource { title: string; author: string; licence: string; page: string; context: string }

export const CREDITS: readonly CreditGroup[] = [
  {title:"Opening narration",entries:[{what:"Original fictional machine-generated opening; stock voice M1, no real person portrayed",who:"Fog City script, Supertonic 3 by Supertone Inc.",licence:"Local model: OpenRAIL-M; generator: MIT; original generated output",url:"https://huggingface.co/supertone-oss-archive/supertonic-3"}]},
  {
    title: "Map data",
    entries: [
      { what: "Map data", who: "© OpenStreetMap contributors", licence: "ODbL", url: "https://www.openstreetmap.org/copyright", linkWho: true },
      { what: "Building footprints and heights, streets, districts, parcels and business locations", who: "City and County of San Francisco, DataSF", licence: "PDDL 1.0", url: "https://datasf.org/opendata/" },
      { what: "Terrain elevation", who: "USGS National Map 3D Elevation Program (3DEP)", licence: "Public domain (U.S. federal government)", url: "https://www.usgs.gov/3d-elevation-program" },
    ],
  },
  {
    title: "Music",
    entries: (musicSources.tracks as MusicSource[]).map((t) => ({ what: `"${t.title}" (${t.context === "driving" ? "radio" : t.context})`, who: t.author, licence: t.licence, url: t.page })),
  },
  {
    title: "Sound effects",
    entries: [{ what: "Blaster, splash, rust, melt, horns and jingle", who: "Fog City (synthesised, assets/audio/generate.py)", licence: "Original work" }],
  },
  {
    title: "Models, icons and textures",
    entries: [
      { what: "Player character (Male_Adult_01)", who: "Microsoft Rocketbox avatar library, © 2020 Microsoft", licence: "MIT", url: "https://github.com/microsoft/Microsoft-Rocketbox" },
      { what: "Control icons", who: "Lucide Icons and Contributors", licence: "ISC", url: "https://lucide.dev" },
      { what: "Loading screen art and the Fog City 5.5 mark", who: "Fog City (art generated with Figma AI, gpt-image-2.5)", licence: "Original work" },
      { what: "Asphalt scan (asphalt_02)", who: "Rob Tuytel, Poly Haven", licence: "CC0 1.0", url: "https://polyhaven.com/a/asphalt_02" },
      { what: "Concrete pavement scan", who: "Charlotte Baglioni, Poly Haven", licence: "CC0 1.0", url: "https://polyhaven.com/a/concrete_pavement" },
      { what: "Rendering reference (Slop New York)", who: "Mr.doob", licence: "MIT", url: "https://github.com/mrdoob/slop-newyork" },
    ],
  },
];

export const CREDITS_STYLES=`.fc-credits{margin-top:12px;border-top:1px solid #55747b80;padding-top:8px}.fc-credits summary{cursor:pointer;font-weight:700;min-height:32px;display:flex;align-items:center}.fc-credits h3{margin:10px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#bcd1d4}.fc-credits ul{margin:0;padding-left:18px}.fc-credits li{margin:2px 0;font-size:13px}.fc-credits a{color:#9af4c3}.fc-credits small{color:#bcd1d4}`;

export function mountCredits(doc:Document,groups:readonly CreditGroup[]=CREDITS):{element:HTMLElement;dispose():void} {
  const root=doc.createElement("details");root.className="fc-credits";
  const style=doc.createElement("style");style.textContent=CREDITS_STYLES;
  const summary=doc.createElement("summary");summary.textContent="Credits";root.append(style,summary);
  for(const group of groups){
    const title=doc.createElement("h3");title.textContent=group.title;const list=doc.createElement("ul");
    for(const entry of group.entries){
      const item=doc.createElement("li");const link=(text:string)=>{const a=doc.createElement("a");a.href=entry.url!;a.target="_blank";a.rel="noopener noreferrer";a.textContent=text;return a;};
      item.append(doc.createTextNode(`${entry.what}: `));
      if(entry.url&&entry.linkWho)item.append(link(entry.who));else item.append(doc.createTextNode(entry.who));
      const licence=doc.createElement("small");licence.textContent=` (${entry.licence})`;item.append(licence);
      if(entry.url&&!entry.linkWho)item.append(doc.createTextNode(" "),link("source"));
      list.append(item);
    }
    root.append(title,list);
  }
  return {element:root,dispose(){root.remove();}};
}
