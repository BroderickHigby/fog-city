// Invented names in prose (the lint's proseName rule). The clearedName rule checks the registry
// of name fields; this rule covers everything else a player reads, so a bark that says "Grab a
// Snorkel Labs smoothie" or an ad "Brought to you by Squandr" cannot slip an uncleared brand in.
//
// No NLP guessing: a word is a candidate only by its spelling, and it passes only when it is
// known. A candidate is
//   - a CamelCase word ("FogCast", "SnorkelLabs"), anywhere;
//   - a capitalised word that does not start a sentence ("by Squandr");
//   - a capitalised word followed by a company word ("Snorkel Labs", "Kelp AI"), even at the
//     start of a sentence: the whole phrase must be a cleared name.
// Known words are the lexicon: every word the content uses in lower case (the corpus
// dictionary), the place gazetteer (street names from the sf road graph, districts and their
// hubs, protected areas, safehouses, landmarks), the cleared names and generic labels, the
// registered game-term fields (mode, activity and item names), and content/proper-words.json,
// the reviewed list of other capitalised words (weekdays, months, named support services).
// Invented names belong in a placeholder ({name}, {$product}) or in brands.json and
// cleared-names.json.

import properJson from "../../content/proper-words.json" with { type: "json" };

export interface ProperWord {
  word: string;
  kind: "calendar" | "place" | "service" | "word" | "acronym" | "firstName" | "astronomy";
  why: string;
}

export const PROPER_WORDS: readonly ProperWord[] = (properJson as unknown as { words: ProperWord[] }).words;

/** What the proseName rule accepts: lower-case known words, and the cleared multi-word names. */
export interface ProseLexicon {
  known: ReadonlySet<string>;
  /** Cleared names, lower-cased ("moat labs"), for the company-word check. */
  clearedPhrases: ReadonlySet<string>;
}

/** Words that make the capitalised word before them read as a company name. */
export const COMPANY_WORDS: ReadonlySet<string> = new Set([
  "Labs", "Lab", "AI", "Inc", "HQ", "Co", "Corp", "Ventures", "Capital", "Partners", "Systems", "Robotics", "Technologies",
  "Tech", "Dynamics", "Studio", "Studios", "Works", "Foundry", "Group", "Bio", "Motors", "Networks", "Analytics", "Logistics",
]);

/** Words that start a description, not a name: "The AI notice", "Ethical AI", "Your Labs badge". */
const DETERMINERS: ReadonlySet<string> = new Set(
  ("the a an this that these those your our my his her their its every each no one any some more most new real good bad big generative open ask " +
    "ethical responsible trustworthy safe agentic smart honest human friendly sovereign").split(" "),
);

const WORD = /[A-Za-z][A-Za-z'’]*/g;
/** Characters after which a capital letter starts a sentence or a new line of copy. */
const BOUNDARY = /(^|[.!?:;"“”(—–|*\n])\s*$/;

/** Lower-case parts of a word for lookup ("O'Doul" -> "o'doul"; possessives and contractions dropped). */
function bare(w: string): string {
  return w.replace(/['’](s|m|ll|ve|re|d|t)$/i, "").replace(/['’]$/, "");
}

/** Every word in lower case that the text uses in lower case. */
export function lowerCaseWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD)) if (/^[a-z]/.test(m[0])) out.push(bare(m[0]).toLowerCase());
  return out;
}

/** Every word of a name or label, lower-cased, for the gazetteer ("Lefty O'Doul Bridge" -> lefty, o'doul, bridge). */
export function nameWords(text: string): string[] {
  return [...text.matchAll(WORD)].map((m) => bare(m[0]).toLowerCase());
}

/** The lexicon from the corpus's lower-case words, the gazetteer's names, the cleared names and proper-words.json. */
export function buildProseLexicon(input: {
  corpus: Iterable<string>;
  gazetteer: Iterable<string>;
  cleared: Iterable<string>;
  properWords?: readonly ProperWord[];
}): ProseLexicon {
  const known = new Set<string>();
  for (const s of input.corpus) for (const w of lowerCaseWords(s)) known.add(w);
  for (const s of input.gazetteer) for (const w of nameWords(s)) known.add(w);
  const clearedPhrases = new Set<string>();
  for (const s of input.cleared) {
    clearedPhrases.add(s.toLowerCase());
    for (const w of nameWords(s)) known.add(w);
  }
  for (const p of input.properWords ?? PROPER_WORDS) for (const w of nameWords(p.word)) known.add(w);
  return { known, clearedPhrases };
}

function isKnown(w: string, lex: ProseLexicon): boolean {
  const lw = bare(w).toLowerCase();
  if (lex.known.has(lw)) return true;
  // Plurals of known words: "Footmen", "Trundles", "Saturdays".
  if (lw.endsWith("men") && lex.known.has(`${lw.slice(0, -3)}man`)) return true;
  if (lw.endsWith("es") && lex.known.has(lw.slice(0, -2))) return true;
  return lw.endsWith("s") && lex.known.has(lw.slice(0, -1));
}

/** Acronyms ("AI", "GPU", "KPIs", "TAM") are not names here; hex colours ("#FFFFFF") are data. */
function isAcronym(w: string, before: string): boolean {
  if (before.endsWith("#")) return true;
  return /^[A-Z]{1,5}s?$/.test(bare(w));
}

export interface ProseNameHit {
  word: string;
  why: string;
}

/** The invented-looking names in one string that the lexicon does not know. */
export function proseNameHits(text: string, lex: ProseLexicon): ProseNameHit[] {
  const out: ProseNameHit[] = [];
  const words = [...text.matchAll(WORD)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
  const spaceBetween = (a: number, b: number): boolean => {
    const x = words[a];
    const y = words[b];
    return x !== undefined && y !== undefined && /^\s+$/.test(text.slice(x.at + x.w.length, y.at));
  };
  for (let i = 0; i < words.length; i++) {
    const { w, at } = words[i] as { w: string; at: number };
    const before = text.slice(0, at);
    if (before.endsWith("{") || before.endsWith("{$")) continue; // a placeholder
    const next = words[i + 1];
    if (/^[A-Z]/.test(w) && !/['’]s$/.test(w) && !DETERMINERS.has(w.toLowerCase()) && next && COMPANY_WORDS.has(next.w) && spaceBetween(i, i + 1)) {
      // "Snorkel Labs": the phrase, with any capitalised words before it, must be cleared.
      let start = i;
      while (start > 0 && /^[A-Z]/.test(words[start - 1]?.w ?? "") && !DETERMINERS.has((words[start - 1]?.w ?? "").toLowerCase()) && spaceBetween(start - 1, start)) start--;
      const phrases: string[] = [];
      for (let s = start; s <= i; s++) phrases.push(words.slice(s, i + 2).map((x) => x.w).join(" ").toLowerCase());
      if (!phrases.some((p) => lex.clearedPhrases.has(p))) out.push({ word: `${w} ${next.w}`, why: "reads as a company name and is not in content/cleared-names.json" });
      i++; // the company word is part of this phrase
      continue;
    }
    if (/^[A-Z][a-z]+[A-Z]/.test(w)) {
      if (!lex.clearedPhrases.has(w.toLowerCase()) && !isKnown(w, lex)) out.push({ word: w, why: "a CamelCase name that is not in content/cleared-names.json" });
      continue;
    }
    if (!/^[A-Z]/.test(w) || BOUNDARY.test(before) || isAcronym(w, before)) continue;
    if (!isKnown(w, lex)) out.push({ word: w, why: "a capitalised word mid-sentence that is not a known word, place or cleared name" });
  }
  return out;
}
