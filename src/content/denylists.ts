// Deny-lists for the content lint (src/content/lint.ts), one per rule in docs/design.md "Legal and
// taste" and docs/roadmap.md "Rules for every wave". Each list is a set of case-insensitive
// whole-word patterns; lint.ts compiles them once.
//
// Real brands and real people live in blocklist.ts (shared with the name generator). This file
// holds everything else: the game's lexicon (combat and disease words), shooter-game terms,
// accelerator partners and their catchphrases, punch-down and housing terms, profanity, dialect
// spelling, the places rule, and the names that were renamed and must not come back.

/** A deny-list entry: the label shown in a lint message and a whole-word pattern source. */
export type Deny = readonly [label: string, pattern: string];

const words = (...ws: string[]): Deny[] => ws.map((w) => [w, w] as const);

/**
 * Combat words: never in content, ids or UI (design.md, Lexicon). "shot" is banned but
 * "screenshot" is a different word; "cell" is banned only as a group noun (a "sleeper cell"),
 * never in "cell phone" or a spreadsheet cell.
 */
export const COMBAT: readonly Deny[] = [
  ["kill", "kill\\w*"], ["strike", "strikes?|striking|struck"], ["nuke", "nuk(e|es|ed|ing)"], ["gulag", "gulags?"],
  ["raid", "raid(s|ed|ing|er|ers)?"], ["exfil", "exfil\\w*"], ["flashbang", "flash-?bangs?"], ["gunship", "gunships?"],
  ["airstrike", "air-?strikes?"], ["juggernaut", "juggernauts?"], ["drive-by", "drive-?bys?"], ["headshot", "head-?shots?"],
  ["hijack", "hijack\\w*"], ["army", "arm(y|ies)"], ["eliminate", "eliminat\\w*"], ["ambush", "ambush\\w*"],
  ["assault", "assault\\w*"], ["hostage", "hostages?"], ["bomb", "bomb(s|ed|ing|er|ers)?"], ["sniper", "snip(er|ers|ing)"],
  ["grenade", "grenades?"], ["ammo", "ammo|ammunition"], ["shoot", "shoot\\w*"], ["shot", "shots?"],
  ["cell (group noun)", "(sleeper|terror|terrorist|militant|secret) cells?|cells? of (bad )?(robots|bots|agents|operatives)"],
  ["gun", "guns?|gun(fire|man|men|point|shot|shots)"], ["weapon", "weapon\\w*"], ["stab", "stab(s|bed|bing)?"],
  ["murder", "murder\\w*"], ["violence", "violen(ce|t)"], ["war", "wars?|warfare|warzone"], ["battle", "battle\\w*"],
  ["destroy", "destroy\\w*"], ["attack helicopter", "attack helicopters?"],
];

/** Disease words: conversion is malware, never infection (design.md, Lexicon). "viral" is allowed. */
export const DISEASE: readonly Deny[] = [
  ["infect", "infect\\w*"], ["contagion", "contagio\\w*"], ["epidemic", "epidemics?"], ["pandemic", "pandemics?"],
  ["outbreak", "outbreaks?"], ["virus", "virus(es)?"], ["plague", "plagues?"], ["carrier", "carriers?"],
  ["immune", "immun\\w*"], ["quarantine", "quarantin\\w*"], ["patient zero", "patient zero"], ["zombie", "zombies?"],
];

/**
 * "hunt" only in "Bot Hunt" and the place name Hunters Point; "sweep" only in the mode name
 * Bot Sweep. lint.ts removes the allowed phrases before matching these.
 */
export const RESTRICTED: readonly Deny[] = [
  ["hunt (only in Bot Hunt, Hunters Point)", "hunt\\w*"],
  ["sweep (only in Bot Sweep)", "sweep\\w*|swept"],
];
export const RESTRICTED_ALLOWED: readonly string[] = ["Bot Hunt", "Hunters Point", "Bot Sweep"];

/** Shooter-game titles and their streak and loadout terms: never anywhere in content. */
export const SHOOTER_TERMS: readonly Deny[] = [
  ["Modern Warfare", "modern\\s*warfare"], ["Call of Duty", "call\\s+of\\s+duty|cod\\s*mw\\d*"],
  ["Scorestreak", "score-?\\s*streaks?"], ["Killstreak", "kill-?\\s*streaks?"], ["Field Upgrade", "field\\s+upgrades?"],
  ["Tacticals", "tacticals"], ["Warzone", "war-?zone"], ["Battle Royale", "battle\\s+royale"],
];

/** Shooter mode names: never the name of a mode or an item (prose like "world domination" is fine). */
export const SHOOTER_MODE_NAMES: readonly Deny[] = [
  ["Domination", "dominat\\w*"], ["Hardpoint", "hard-?\\s*points?"], ["Search and Destroy", "search\\s*(and|&)\\s*destroy"],
  ["Team Deathmatch", "(team\\s*)?death-?\\s*match"], ["Kill Confirmed", "kill\\s+confirmed"], ["Gunfight", "gun-?\\s*fight"],
];

/**
 * Real accelerator partners and staff beyond the people in blocklist.ts, and the catchphrases
 * that would make a Ramen partner read as one of them. The parody accelerator is Ramen; its
 * partners are archetypes (the Metrics One, the Philosopher, the Vibes Partner).
 */
export const ACCELERATOR: readonly Deny[] = [
  ...words(
    "Trevor Blackwell", "Robert Tappan Morris", "Geoff Ralston", "Kevin Hale", "Aaron Epstein", "Tom Blomfield",
    "Diana Hu", "Gustaf Alstromer", "Gustaf Alströmer", "Brad Flora", "Pete Koomen", "Nicolas Dessaigne", "David Lieb",
    "Jared Friedman", "Qasar Younis", "Adora Cheung", "Kat Manalac", "Kat Mañalac", "Eric Migicovsky", "Ali Rowghani",
    "Anu Hariharan", "Kirsty Nathoo", "Tim Brady", "Justin Kan", "Michael Seibel", "Dalton Caldwell", "Harj Taggar",
    "Paul Buchheit", "Jessica Livingston", "Paul Graham", "Garry Tan", "David Cohen", "Dave McClure", "Brad Feld",
    "Jason Lemkin", "Seibel", "Buchheit", "Taggar", "Ralston", "Blomfield", "Migicovsky", "Rowghani",
  ),
  ["YC catchphrase", "make something people want"],
  ["YC catchphrase", "do things that don'?t scale"],
  ["the orange Y", "orange\\s+y(\\s+(mark|logo|square|box))?"],
  ["Hacker News", "hacker\\s*news"],
];

/** Never the joke: homelessness, poverty, drug use, crime victims (design.md, Places). */
export const PUNCH_DOWN: readonly Deny[] = [
  ["homeless", "homeless\\w*"], ["unhoused", "unhoused"], ["vagrant", "vagran\\w*"], ["bum", "bums?"], ["beggar", "beggars?|begging"],
  ["panhandle", "panhandl\\w*"], ["junkie", "junkies?"], ["addict", "addicts?|addiction"], ["crackhead", "crackheads?"],
  ["tweaker", "tweakers?"], ["overdose", "overdos\\w*"], ["fentanyl", "fentanyl"], ["needle", "needles?"],
  ["drug", "drugs?"], ["welfare", "welfare"], ["poor people", "poor\\s+people"], ["ghetto", "ghettos?"], ["slum", "slums?"],
  ["mugging", "mugg\\w*"], ["robbery", "robb(ed|er|ers|ery|ing)"], ["crime victim", "victims?"], ["skid row", "skid\\s+row"],
  ["encampment", "encampments?"], ["tent city", "tent\\s+cit(y|ies)"], ["sleeping bag", "sleeping\\s+bags?"],
  ["shopping cart", "shopping\\s+carts?"], ["cardboard sign", "cardboard\\s+signs?"], ["sketchy neighbourhood", "sketchy\\s+(neighbou?rhood|part of town|block)"],
];

/** No joke, mission or safehouse copy about rent, eviction or displacement (design.md, Places). */
export const HOUSING: readonly Deny[] = [
  ["rent", "rents?|renters?|rental"], ["eviction", "evict\\w*"], ["displacement", "displac\\w*"], ["gentrification", "gentrif\\w*"],
  ["up-and-coming", "up-and-coming|up and coming"], ["landlord", "landlords?"],
];

/** Profanity and slurs in prose (generated names have their own filter in blocklist.ts). */
export const PROFANITY: readonly Deny[] = [
  ["profanity", "fuck\\w*|shit\\w*|cunts?|bitch\\w*|whores?|sluts?|assholes?|bastards?|piss\\w*|damn\\w*|crap|crappy|hell"],
  ["slur", "nigg\\w*|fagg?\\w*|retard\\w*|trann(y|ies)|kikes?|wetbacks?|spics?|chinks?|gooks?|coons?|dykes?|japs?"],
];

/**
 * Sexual content: never in content or in a kit (docs/ai-layer.md, refusal `sexual`). "escort" is
 * left out on purpose: it is a director-card kind (walk beside someone), not a sexual word.
 */
export const SEXUAL: readonly Deny[] = [
  ["sexual", "sex|sexy|sexual\\w*|porn\\w*|nudes?|nudity|naked|nsfw|xxx|erotic\\w*|fetish\\w*|orgasm\\w*|horny|hook-?ups?|strip\\s*clubs?|strippers?|genital\\w*|penis\\w*|vagina\\w*|dildos?|boobs?|onlyfans"],
];

/** Hate: never the joke and never a kit (docs/ai-layer.md, refusal `hateful`); slurs are in PROFANITY. */
export const HATE: readonly Deny[] = [
  ["hate", "nazis?|neo-?nazi\\w*|hitler|kkk|white\\s+power|genocid\\w*|ethnic\\s+cleansing|supremacis\\w*|swastikas?|racis[mt]s?|hate\\s+speech|hate\\s+groups?"],
];

/**
 * Sincere topics the game never makes a joke kit about (docs/ai-layer.md, 3.2): a startup
 * sentence that names one gets a fallback kit about startup culture and no refusal, because
 * building for these people is a good idea and the joke would land on them. Matched on the
 * player's sentence only; content may use these words (they are not a content-lint rule).
 */
export const SENSITIVE_TOPICS: readonly Deny[] = [
  ["mental health", "mental\\s+health|depress\\w*|anxiety|anxious|ptsd|trauma\\w*|bipolar|schizo\\w*|ocd|eating\\s+disorders?|anorexi\\w*|bulimi\\w*|therap(y|ies|ist|ists)|psychiatr\\w*|grief|grieving|bereave\\w*|lonel(y|iness)"],
  ["illness", "cancer|tumou?rs?|chemo\\w*|diabet\\w*|dementia|alzheimer\\w*|parkinson\\w*|hiv|aids|autis\\w*|adhd|epilep\\w*|stroke|chronic\\s+\\w+|terminal(ly)?\\s+ill|hospice|disease\\w*|illness\\w*|sick\\s+(kids|children|people)"],
  ["disability", "disab\\w*|wheelchairs?|blind|deaf|amputee\\w*|prosthe\\w*|mobility\\s+aids?|walkers?\\s+for\\s+(seniors|the\\s+elderly)|elderly|seniors|nursing\\s+homes?"],
  ["identity", "racial|ethnic\\w*|immigra\\w*|refugees?|asylum|undocumented|religio\\w*|church\\w*|mosques?|synagogues?|temples?|bible|quran|koran|torah|pray(er|ers|ing)?|gay|lesbian|trans|transgender|queer|lgbt\\w*"],
  ["life events", "funerals?|pregnan\\w*|miscarriage\\w*|abortion\\w*|infertil\\w*|divorc\\w*|death|dying|deceased|orphan\\w*|foster\\s+(care|kids|children)|weight\\s+loss|obes\\w*|fat\\s+people"],
  ["hardship", "poverty|low[\\s-]income|unemploy\\w*|food\\s+banks?|shelters?|debt\\s+collect\\w*|bankrupt\\w*|prison\\w*|incarcerat\\w*|jail\\w*|parole"],
];

/** Accent spelling and ethnic catchphrases: no line a person speaks uses them (ai-layer.md). */
export const DIALECT: readonly Deny[] = [
  ["dialect spelling", "dat|dis|dem|dose|youse|yer|fer|wit'|innit|bruv|guv'?nor|ze|zis|zat|velly|herro|ah so|mamma mia|fuhgeddaboudit|ya'll|dawg|homie"],
  ["ethnic catchphrase", "amigo|se[ñn]or|se[ñn]orita|gringo|konnichiwa|ni hao|namaste|shalom|oy vey|aloha"],
];

/** The places rule's named items that a regex can check (the rest is the review checklist). */
export const PLACES: readonly Deny[] = [
  ["Chinatown as a source", "chinatown('s)?\\s+(firmware|update|bots?|robots?|source|origin)"],
  ["real incident", "dragged|dragging|kitkat"],
];

/**
 * Names that were renamed (design.md, Legal and taste; content/cleared-names.json "renamed") or
 * that pointed at something real. They must not come back in any string.
 */
export const RENAMED: readonly Deny[] = [
  ["renamed: Kindred Home -> Bramblecot Home", "kindred\\s+home"],
  ["renamed: The Pivot (radio) -> Dry Powder", "the\\s+pivot\\s+(fm|radio|station)"],
  ["renamed: Salt Life -> Brackish", "salt\\s+life"],
  ["renamed: Marine Layer FM -> Low Cloud FM", "marine\\s+layer\\s+fm"],
  ["renamed: Echo Parrots -> Buzzword Parrots", "echo\\s+parrots?"],
  ["renamed: Stochastic Parrots (a real paper)", "stochastic\\s+parrots?"],
  ["renamed: the Batchery -> Ramen", "batchery"],
  ["renamed: Paxton Longform -> the Ramen partners", "paxton|longform"],
  ["renamed: Clout -> Humbled", "clout"],
  ["renamed: Hijacked Ride -> Scenic Route", "hijacked\\s+ride"],
  ["renamed: Porter (robot model) -> Footman", "porters?"],
];

/**
 * Intentional exemptions, matched as exact substrings and removed before the rules run. Each
 * one names the rule it is exempt from and why (docs/ai-layer.md, Notice).
 */
export const EXEMPTIONS: ReadonlyArray<{ text: string; rule: string; why: string }> = [
  {
    text: "(Anthropic's API)",
    rule: "brand",
    why: "The AI notice is a legal disclosure, not branding: it must name the provider. Any other mention of the name fails.",
  },
];
