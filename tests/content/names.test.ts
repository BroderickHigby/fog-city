// Invented startup names: deterministic, varied, and provably never a real brand or person.
import { describe, expect, it } from "vitest";
import {
  BRANDS,
  GENERIC_BRANDS,
  OFFENSIVE_STEMS,
  OFFENSIVE_WORDS,
  PEOPLE,
  SURNAMES,
  blockedNameReason,
  blockedProseReason,
  editDistance,
  normalize,
  offensiveNameReason,
  withinOneEdit,
} from "../../src/content/blocklist.ts";
import {
  NAME_MAX,
  NAME_MIN,
  NAME_PATTERNS,
  allNames,
  generateName,
  namesOfPattern,
  rejectReason,
  rejectedCandidates,
} from "../../src/content/names.ts";
import { hashString, makePrng } from "../../src/content/prng.ts";

describe("generateName", () => {
  it("is deterministic", () => {
    for (const s of [0, 1, 99, "player:bo", "tile-3_4"]) expect(generateName(s)).toBe(generateName(s));
  });

  it("is varied: 1000 seeds give at least 800 distinct names, from every pattern", () => {
    const names = Array.from({ length: 1000 }, (_, i) => generateName(i));
    expect(new Set(names).size).toBeGreaterThanOrEqual(800);
    for (const p of NAME_PATTERNS) {
      const pool = new Set(namesOfPattern(p));
      expect(names.some((n) => pool.has(n)), `pattern ${p} never chosen`).toBe(true);
    }
  });

  it("stays within NAME_MIN..NAME_MAX", () => {
    for (let i = 0; i < 2000; i++) {
      const n = generateName(i);
      expect(n.length).toBeGreaterThanOrEqual(NAME_MIN);
      expect(n.length).toBeLessThanOrEqual(NAME_MAX);
    }
  });
});

describe("no real name ever comes out", () => {
  const space = allNames();

  it("the complete output space is large and fully enumerable", () => {
    expect(space.length).toBeGreaterThanOrEqual(2000);
  });

  it("EVERY name in the output space passes the brand and people blocklist", () => {
    const bad = space.map((n) => [n, blockedNameReason(n)] as const).filter(([, why]) => why !== null);
    expect(bad).toEqual([]);
  });

  it("no name in the space is any blocklisted brand, word for word", () => {
    const banned = new Set([...BRANDS, ...GENERIC_BRANDS].map(normalize));
    for (const n of space) {
      expect(banned.has(normalize(n)), n).toBe(false);
      for (const w of n.split(/[\s.]+/)) expect(banned.has(normalize(w)), `${n}: ${w}`).toBe(false);
    }
  });

  it("EVERY name in the output space passes the offensive-word filter", () => {
    const bad = space.map((n) => [n, offensiveNameReason(n)] as const).filter(([, why]) => why !== null);
    expect(bad).toEqual([]);
  });

  // Every real or offensive name this generator has been caught spelling (review of 2026-10-20,
  // and the full read of the output space that followed). Each must stay out of the space AND
  // stay blocked by the filter, so bringing a root back cannot quietly bring the name back.
  it.each([
    "TensorFlow", "VectorWorks", "ParrotOS", "Lattice HQ", "Cable Labs", "Saran", "tally.so", "Satan",
    "Drift AI", "Juniper AI", "JuniperOS", "Kernel AI", "Comet AI", "Cometly", "Glide AI", "Pylon AI", "Wren AI",
    "Kiln AI", "Fable AI", "DuneOS", "HatchWorks", "Hushly", "Vectorly", "Ledgr", "Badgr", "Gathr", "Embr Labs",
    "Gadget Labs", "GadgetFlow", "Widgetkit", "WidgetBot", "PromptBase", "PromptFlow", "Tokenly", "Velora",
    "Teravia", "Katara", "Minix", "Xenix", "Nymox", "Slopify", "Go Prompt", "Sonder AI", "EmberStack", "Quillify",
  ])("never produces %s", (name) => {
    expect(space).not.toContain(name);
    expect(rejectReason(name), name).not.toBeNull();
  });

  it("the filter actually removed real-brand collisions the patterns can spell", () => {
    // If this ever reads 0, either the patterns changed or the filter stopped running.
    const brandHits = rejectedCandidates().filter((r) => /brand|person|surname/.test(r.reason));
    expect(brandHits.length).toBeGreaterThan(0);
    for (const r of brandHits) expect(space).not.toContain(r.name);
  });
});

describe("blocklist", () => {
  it("is substantial", () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(300);
    expect(GENERIC_BRANDS.length).toBeGreaterThanOrEqual(80);
    expect(PEOPLE.length).toBeGreaterThanOrEqual(60);
    expect(SURNAMES.length).toBeGreaterThanOrEqual(40);
  });

  it("has no duplicates", () => {
    const all = [...BRANDS, ...GENERIC_BRANDS].map(normalize);
    const dupes = all.filter((x, i) => all.indexOf(x) !== i);
    expect(dupes).toEqual([]);
  });

  it.each([
    ["OpenAI", "brand"], ["openai", "brand"], ["Open AI", "brand"], ["Anthropik", "near-miss"], ["Waymo Labs", "brand"],
    ["Stripely", "brand"], ["Nvidiaa", "brand"], ["Apple", "brand"], ["Quiet Apple", "brand"], ["Slack", "brand"],
    ["Y Combinator", "brand"], ["kale.ycombinator", "brand"], ["Altman AI", "surname"], ["Sam Altman", "person"],
    ["Zuckerberg Labs", "surname"], ["Go Pro", "brand"], ["Tesla", "brand"], ["Teslo", "near-miss"],
    ["Instacart", "brand"], ["DoorDashly", "brand"], ["Lyftr", "brand"], ["Gooogle", "near-miss"],
  ])("blocks %s (%s)", (name, why) => {
    const r = blockedNameReason(name);
    expect(r, name).not.toBeNull();
    expect(r).toContain(why);
  });

  it.each(["Kelpforge", "Feral Teapot", "moss.ai", "Pondr", "Squandr", "Kale AI", "Hey Kelp", "Paxton Longform", "Slotsworth", "Batchery"])(
    "allows invented %s",
    (name) => expect(blockedNameReason(name)).toBeNull(),
  );

  // Well-known brands kept apart from BRANDS on purpose: deleting a blocklist entry fails here.
  // Includes the reviewer's probe of 2026-10-20 that found ~140 of ~230 well-known brands unblocked.
  it.each([
    "PyTorch", "Keras", "Docker", "Kubernetes", "Jupyter", "Terraform", "HashiCorp", "Telegram", "WeChat",
    "Tencent", "Alibaba", "Yahoo", "Zillow", "Waze", "Vimeo", "Rivian", "Mixpanel", "Amplitude", "Obsidian",
    "Raycast", "1Password", "Lattice", "Drift", "Juniper", "Comet", "Glide", "Pylon", "Kernel", "Ledger", "Dune",
    "Sierra", "Gamma", "Arc", "Warp", "Calm", "Brave", "Lucid", "Compass", "Anchor", "Headspace", "Miro", "Toast",
    "Sonder", "Ember", "Quill", "Grove", "Burrow", "Thistle", "Marble", "Fennel", "Sprout Social", "Hatch", "Orbit",
    "Prism", "Tally", "Wren", "Pitch", "Framer", "Sketch", "Postman", "Kafka", "Grafana", "Nginx", "Ollama",
    "Raspberry Pi", "Arduino", "Roomba", "Knightscope", "WALL-E", "R2-D2", "Baymax", "Optimus Prime", "Skynet",
    "Velcro", "Xerox", "Polaroid", "Kodak", "Bose", "Garmin", "Dyson", "Rolex", "Gucci", "Prada", "Zara", "Uniqlo",
    "IKEA", "Wayfair", "Temu", "Shein", "Klaviyo", "Beehiiv", "Linktree", "Gumroad", "Expensify", "Navan",
    "Wealthfront", "Betterment", "Acorns", "Monzo", "Nubank", "Afterpay", "Zelle", "MetaMask", "Uniswap",
    "Chainlink", "Cardano", "Ripple", "Opendoor", "Redfin", "Flexport", "Verkada", "Samsara", "Rubrik",
    "Confluent", "Optimizely", "LaunchDarkly", "Benchling", "Eventbrite", "Zynga", "Niantic", "Bungie", "Strava",
    "Oura", "Whoop", "Grindr", "OkCupid", "Zocdoc", "Ancestry", "23andMe", "Typeform", "SurveyMonkey",
    "Qualtrics", "Mailgun", "Auth0", "Bitwarden", "LastPass", "NordVPN", "Tailscale", "Algolia", "PostHog",
    "Hotjar", "Snyk", "CodePen", "LeetCode", "Coursera", "Udemy", "Chegg", "Quizlet", "Kahoot", "Descript",
    "CapCut", "Ideogram", "Krea", "Leonardo", "Replicate", "CoreWeave", "RunPod", "LangSmith", "CrewAI", "Lindy",
    "Decagon", "Sierra AI", "Wayve", "Mobileye", "Polestar", "Lucid Motors", "Porsche", "Toyota", "Honda",
    "Subaru", "Hyundai", "Volvo", "BYD", "Segway", "Waffle House", "Dunkin", "Panera", "Shake Shack", "Popeyes",
    "Domino's", "Budweiser", "Heineken", "Olipop", "Liquid Death", "Oatly", "HBO", "Crunchyroll", "TechCrunch",
    "The Verge", "Bloomberg", "Reuters", "Axios", "BuzzFeed", "Gizmodo", "Sightglass", "Bi-Rite", "Lagunitas",
    "Verve", "AT&T", "Verizon", "T-Mobile", "Comcast", "Xfinity", "Nokia", "Motorola", "BlackBerry", "Netscape",
    "Napster", "Myspace", "Digg", "Friendster", "Yik Yak", "GeoCities", "Calm Labs", "Lucid AI", "Compass HQ",
  ])("blocks well-known brand %s", (name) => {
    expect(blockedNameReason(name), name).not.toBeNull();
  });

  it("every brand and person on the list is caught in a sentence (the prose index misses nothing)", () => {
    for (const b of [...BRANDS, ...PEOPLE]) {
      expect(blockedProseReason(`Better than ${b}, honestly.`), b).not.toBeNull();
      expect(blockedProseReason(`${b.toUpperCase()}!`), b).not.toBeNull();
    }
  });

  it("prose check finds brands and people as whole words, ignores generic English", () => {
    expect(blockedProseReason("Faster than any Waymo.")).toContain("Waymo");
    expect(blockedProseReason("as Elon Musk once said")).toContain("Musk");
    expect(blockedProseReason("A square block of slack apple boxes.")).toBeNull();
    expect(blockedProseReason("Uberly fine.")).toBeNull(); // not a whole word: names catch this, prose does not
  });

  it("withinOneEdit agrees with Levenshtein distance <= 1", () => {
    const rng = makePrng("edit");
    const alpha = "abcde";
    const rand = (): string => Array.from({ length: 1 + rng.int(6) }, () => alpha[rng.int(alpha.length)]).join("");
    for (let i = 0; i < 5000; i++) {
      const a = rand();
      const b = rng.int(3) === 0 ? a : rand();
      expect(withinOneEdit(a, b), `${a} ${b}`).toBe(editDistance(a, b) <= 1);
    }
  });
});

describe("offensive-word filter", () => {
  it.each(["Satan", "Satan Labs", "Hell AI", "KaleHell", "Lucifer HQ", "Meth Labs", "Crack.ai", "Gun Labs", "Jesus AI", "Porntify"])(
    "rejects %s",
    (name) => {
      expect(offensiveNameReason(name), name).not.toBeNull();
      expect(rejectReason(name), name).not.toBeNull();
    },
  );

  it.each(["Brass Labs", "Hello AI", "Shellkit", "Skillful", "Cocktail", "Assembly", "Kelpforge", "Feral Teapot"])(
    "leaves harmless words that only contain a short one: %s",
    (name) => expect(offensiveNameReason(name)).toBeNull(),
  );

  it("lists are lower-case, unique and non-empty", () => {
    for (const xs of [OFFENSIVE_STEMS, OFFENSIVE_WORDS]) {
      expect(xs.length).toBeGreaterThan(20);
      expect(new Set(xs).size).toBe(xs.length);
      for (const x of xs) expect(x).toBe(normalize(x));
    }
  });
});

describe("prng", () => {
  it("is deterministic, seeds diverge, and int() stays in range", () => {
    const a = makePrng(1);
    const b = makePrng(1);
    const c = makePrng(2);
    const xs = Array.from({ length: 20 }, () => a.nextU32());
    expect(xs).toEqual(Array.from({ length: 20 }, () => b.nextU32()));
    expect(xs).not.toEqual(Array.from({ length: 20 }, () => c.nextU32()));
    const r = makePrng("range");
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 7000; i++) counts[r.int(7)]++;
    for (const n of counts) expect(n).toBeGreaterThan(800);
    expect(() => r.int(0)).toThrow(RangeError);
  });

  it("hashString is FNV-1a 32", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
    expect(hashString("foobar")).toBe(0xbf9cf968);
  });

  it("matches a pinned sequence (engines must agree)", () => {
    const r = makePrng(12345);
    expect(Array.from({ length: 5 }, () => r.nextU32())).toMatchInlineSnapshot(`
      [
        2977242774,
        3666342370,
        284612288,
        1272139869,
        3250622756,
      ]
    `);
  });
});
