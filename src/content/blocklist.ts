// Real brands, companies, products, investors and public figures that must never come out
// of a content generator (startup names, billboard copy) or appear in authored content.
//
// Three lists, because they need different matching:
//  - BRANDS: distinctive names. Blocked as a whole name, as a substring of a generated name,
//    within one edit of a generated name or word ("Anthropik"), and as a whole word in prose.
//  - GENERIC_BRANDS: brands that are also ordinary English words (Apple, Square, Slack). Blocked
//    when a generated name or one of its words IS the brand; never scanned in prose, where
//    "a square block" is just English.
//  - PEOPLE / SURNAMES: real public figures. Caricatures get invented names; a real name never
//    appears in content and never comes out of the name generator.
//
// The list is deliberately broad: blocking a harmless name costs nothing (the generator draws
// another), letting a real one through is the failure this file exists to prevent.

export const BRANDS: readonly string[] = [
  // AI labs, models and assistants
  "OpenAI", "ChatGPT", "GPT", "DALL-E", "Sora", "Anthropic", "Claude", "Gemini", "DeepMind", "Copilot",
  "Cortana", "Alexa", "Siri", "Llama", "LlamaIndex", "Mistral", "Mixtral", "Grok", "xAI", "Perplexity",
  "Midjourney", "Stable Diffusion", "Stability AI", "Pika Labs", "Suno", "Udio", "ElevenLabs", "Character.ai",
  "Replika", "Inflection AI", "Cohere", "AI21", "Hugging Face", "Scale AI", "Databricks",
  "Snowflake", "Pinecone", "Weaviate", "LangChain", "Jasper AI", "Copy.ai", "Grammarly", "Glean", "Hebbia",
  "Anysphere", "Replit", "Codeium", "Windsurf", "Cognition Labs", "Tabnine", "Sourcegraph",
  "Adept AI", "Rabbit R1", "Magic Leap", "Black Forest Labs", "Runway ML", "Synthesia", "HeyGen",
  "Otter.ai", "Clearview", "Palantir", "Anduril", "Shield AI", "Neuralink", "OpenRouter",
  "Groq", "Cerebras", "SambaNova", "Graphcore", "Together AI", "Fireworks AI", "Modal Labs", "Baseten",
  "Weights & Biases", "Kaggle", "Linux", "Ubuntu", "Debian", "Red Hat", "Unix", "DeepSeek", "Qwen", "Baidu", "Ernie Bot", "Moonshot AI", "Zhipu",
  // Big tech and their products
  "Google", "Alphabet", "YouTube", "Gmail", "Chromebook", "Pixel Phone", "Waymo", "Verily",
  "Facebook", "Instagram", "WhatsApp", "Oculus", "Microsoft", "Xbox", "LinkedIn",
  "Azure", "Bing", "PowerPoint", "iPhone", "iPad", "MacBook", "iCloud", "AirPods", "Vision Pro",
  "AWS", "Kindle", "Zoox", "Whole Foods", "Netflix", "Nvidia", "CUDA", "GeForce", "Tesla", "Cybertruck",
  "SpaceX", "Starlink", "Twitter", "Tweet", "Uber", "Lyft", "Airbnb", "DoorDash", "Instacart", "Postmates",
  "Grubhub", "Gopuff", "Yelp", "Nextdoor", "Pinterest", "Reddit", "Snapchat", "TikTok", "ByteDance",
  "Tinder", "Bumble", "Spotify", "SoundCloud", "Twitch", "Roblox", "Fortnite", "Nintendo", "PlayStation",
  "Samsung", "Huawei", "Xiaomi", "OnePlus", "Lenovo", "Qualcomm", "Broadcom", "TSMC", "Micron", "Cisco",
  "IBM", "SAP", "Workday", "ServiceNow", "Adobe", "Photoshop", "Autodesk", "Salesforce", "Tableau",
  "HubSpot", "Zendesk", "Intercom", "Twilio", "SendGrid", "Mailchimp", "Okta", "Cloudflare", "Akamai",
  "Fastly", "DigitalOcean", "Heroku", "Vercel", "Netlify", "Supabase", "Firebase", "MongoDB", "Redis",
  "Splunk", "Datadog", "PagerDuty", "New Relic", "GitHub", "GitLab", "Bitbucket",
  "Atlassian", "Jira", "Confluence", "Trello", "Asana", "ClickUp", "Airtable", "Zapier", "Retool", "Figma",
  "Canva", "Calendly", "Dropbox", "DocuSign", "Evernote", "Todoist", "Superhuman", "Webflow", "Squarespace",
  "Wix", "WordPress", "Shopify", "Etsy", "eBay", "Craigslist", "Wikipedia", "Mozilla", "Firefox", "Tumblr",
  "Flickr", "Substack", "Patreon", "Kickstarter", "Indiegogo", "Product Hunt", "Hacker News", "Quora",
  "Duolingo", "Peloton", "Fitbit", "GoPro", "Sonos", "Roku", "Hulu", "Disney", "Pixar", "Lucasfilm",
  "Boston Dynamics", "Unitree", "Kiwibot", "Starship Technologies", "Serve Robotics", "Nuro", "Motional",
  "Pony.ai", "WeRide", "Aurora Innovation", "Argo AI", "Cruise LLC", "Skydio", "Zipline", "Lime Scooter",
  // Money, fintech and crypto
  "Stripe", "Plaid", "Brex", "Rippling", "Gusto", "Deel", "Carta", "AngelList", "Robinhood", "Coinbase",
  "Binance", "PayPal", "Venmo", "Cash App", "Affirm", "Klarna", "SoFi", "Revolut", "Mastercard",
  "American Express", "Amex", "Wells Fargo", "Bank of America", "Goldman Sachs", "Morgan Stanley",
  "Bitcoin", "Ethereum", "Dogecoin", "Solana", "Tether", "FTX", "OpenSea", "Kalshi", "Polymarket",
  // Famous flameouts (still trademarks, still real)
  "Theranos", "Juicero", "WeWork", "Quibi", "Fyre",
  // Accelerators and venture firms
  "Y Combinator", "Techstars", "500 Startups", "500 Global", "Andreessen Horowitz", "a16z",
  "Sequoia", "Greylock", "Kleiner Perkins", "Lightspeed", "Founders Fund", "Khosla Ventures",
  "General Catalyst", "Index Ventures", "Tiger Global", "SoftBank", "Thrive Capital", "Insight Partners",
  "Bessemer", "Initialized Capital", "SV Angel", "First Round Capital", "Union Square Ventures",
  "Lux Capital", "Coatue", "Accel Partners", "Benchmark Capital", "Felicis", "Redpoint", "Battery Ventures",
  "Ribbit Capital", "Pear VC", "South Park Commons", "On Deck",
  // Consumer giants that show up on SF streets
  "Starbucks", "Blue Bottle", "Philz", "Peet's", "Safeway", "Trader Joe's", "Walgreens", "CVS", 
  "Walmart", "Costco", "McDonald's", "Chipotle", "Sweetgreen", "In-N-Out", "Coca-Cola", "Pepsi",
  "Red Bull", "Nike", "Adidas", "Patagonia", "Allbirds", "Lululemon", "Levi's", "Ghirardelli", "Boudin",
  "Tartine", "Salesforce Tower",
];

export const GENERIC_BRANDS: readonly string[] = [
  "Apple", "Amazon", "Meta", "X", "Square", "Block", "Box", "Slack", "Notion", "Linear", "Zoom", "Signal",
  "Snap", "Lime", "Bird", "Ramp", "Scale", "Writer", "Index", "Benchmark", "Accel", "Pi", "Rabbit", "Cursor",
  "Runway", "Jasper", "Hinge", "Discord", "Oracle", "Shell", "Dell", "HP", "Intel", "AMD", "Arm", "Sony",
  "Oppo", "Nest", "Ring", "Wing", "Chrome", "Pixel", "Bard", "Codex", "Devin", "Bolt", "Cognition", "Figure",
  "Agility", "Digit", "Spot", "Optimus", "Cruise", "Aurora", "Starship", "Coco", "Serve", "Mercury", "Chime",
  "Wise", "Kraken", "Medium", "Loom", "Monday", "Teams", "Webex", "Threads", "Pebble", "Tidal", "Clover",
  "Pandora", "Steam", "Valve", "Epic", "Unity", "Watson", "Lumen", "Flux", "Kick", "Gong", "Otter", "Modal",
  "Together", "Fireworks", "Sentry", "Elastic", "Mint", "Robin", "Granola", "Harvey", "Humane", "Magic",
  "Replica", "Character", "Inflection", "Adept", "Pika", "Messenger", "Windows", "Outlook", "Office", "Edge",
  "Surface", "Echo", "Prime", "Safari", "Maps", "Wallet", "Venture", "Thrive", "Insight", "Lux", "Android",
  "Fireflies", "Chase", "Visa", "Target", "Lovable", "Clubhouse",
];

export const PEOPLE: readonly string[] = [
  "Paul Graham", "Jessica Livingston", "Garry Tan", "Michael Seibel", "Sam Altman", "Elon Musk",
  "Mark Zuckerberg", "Jeff Bezos", "Marc Andreessen", "Ben Horowitz", "Peter Thiel", "Reid Hoffman",
  "Jensen Huang", "Lisa Su", "Satya Nadella", "Sundar Pichai", "Tim Cook", "Larry Page", "Sergey Brin",
  "Bill Gates", "Steve Jobs", "Steve Wozniak", "Jack Dorsey", "Brian Chesky", "Travis Kalanick",
  "Dara Khosrowshahi", "Marc Benioff", "Naval Ravikant", "Balaji Srinivasan", "Dario Amodei",
  "Daniela Amodei", "Demis Hassabis", "Mustafa Suleyman", "Ilya Sutskever", "Greg Brockman", "Mira Murati",
  "Andrej Karpathy", "Yann LeCun", "Geoffrey Hinton", "Fei-Fei Li", "Andrew Ng", "Arthur Mensch",
  "Aravind Srinivas", "Alexandr Wang", "Chamath Palihapitiya", "David Sacks", "Jason Calacanis",
  "Keith Rabois", "Vinod Khosla", "Masayoshi Son", "Patrick Collison", "John Collison", "Drew Houston",
  "Evan Spiegel", "Kevin Systrom", "Sheryl Sandberg", "Susan Wojcicki", "Marissa Mayer",
  "Elizabeth Holmes", "Sam Bankman-Fried", "Adam Neumann", "Kara Swisher", "Steve Ballmer",
  "Larry Ellison", "Tony Xu", "Apoorva Mehta", "Logan Green", "Ev Williams", "Dick Costolo",
  "Parag Agrawal", "Linda Yaccarino", "Gavin Newsom", "London Breed", "Daniel Lurie", "Nancy Pelosi",
  "Scott Wiener", "Aaron Peskin", "Ron Conway", "Mike Moritz", "Doug Leone", "Roelof Botha",
  "Bill Gurley", "Fred Wilson", "Brad Feld", "Paul Buchheit", "Harj Taggar", "Dalton Caldwell",
];

/** Surnames distinctive enough that a bare surname reads as the real person. */
export const SURNAMES: readonly string[] = [
  "Altman", "Musk", "Zuckerberg", "Bezos", "Andreessen", "Thiel", "Nadella", "Pichai", "Amodei",
  "Hassabis", "Dorsey", "Chesky", "Kalanick", "Benioff", "Ravikant", "Seibel", "Palihapitiya", "Calacanis",
  "Rabois", "Sutskever", "Brockman", "Murati", "Karpathy", "LeCun", "Hinton", "Suleyman", "Collison",
  "Systrom", "Sandberg", "Wojcicki", "Neumann", "Ballmer", "Khosrowshahi", "Wozniak", "Bankman",
  "Yaccarino", "Costolo", "Agrawal", "Newsom", "Pelosi", "Peskin", "Moritz", "Gurley", "Buchheit",
  "Livingston", "Huang", "Gates", "Jobs", "Brin", "Hoffman", "Horowitz", "Graham",
];

/** Lower-case, accents stripped, everything but a-z and 0-9 removed. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

/** Words of a name or sentence, normalized, empty ones dropped. "kale.ai" -> ["kale", "ai"]. */
export function tokens(s: string): string[] {
  return s
    .split(/[\s.\-_/,:;!?'"()]+/)
    .map(normalize)
    .filter((t) => t.length > 0);
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

const N_BRANDS = BRANDS.map((b) => [b, normalize(b)] as const);
// Near-miss candidates bucketed by length, so a check only compares strings that are within one edit.
const NEAR_BY_LEN = new Map<number, Array<readonly [string, string]>>();
for (const e of N_BRANDS) {
  if (e[1].length < 5) continue;
  const list = NEAR_BY_LEN.get(e[1].length) ?? [];
  list.push(e);
  NEAR_BY_LEN.set(e[1].length, list);
}

/** True when a and b differ by at most one insertion, deletion or substitution. Linear time. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a.length < b.length) [a, b] = [b, a];
  if (a.length - b.length > 1) return false;
  let i = 0;
  while (i < b.length && a[i] === b[i]) i++;
  if (i === b.length) return true; // equal, or a has one extra trailing char
  // First mismatch at i: substitution (skip both) or deletion from a (skip a only).
  const rest = a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : false;
  return rest || a.slice(i + 1) === b.slice(i);
}

function nearMiss(s: string): string | null {
  for (let len = s.length - 1; len <= s.length + 1; len++) {
    for (const [label, b] of NEAR_BY_LEN.get(len) ?? []) if (withinOneEdit(s, b)) return label;
  }
  return null;
}
const N_GENERIC = GENERIC_BRANDS.map((b) => [b, normalize(b)] as const);
const N_PEOPLE = PEOPLE.map((p) => [p, normalize(p)] as const);
const N_SURNAMES = SURNAMES.map((p) => [p, normalize(p)] as const);

/**
 * Why a generated NAME is not allowed, or null if it is fine. Strict: a name is rejected when
 * it is, contains, or nearly spells a distinctive brand; when it or any of its words is a
 * generic brand; or when it contains a real person's name or distinctive surname.
 */
export function blockedNameReason(name: string): string | null {
  const n = normalize(name);
  const words = tokens(name);
  if (n.length === 0) return "empty";
  for (const [label, b] of N_BRANDS) {
    if (b.length >= 3 && n.includes(b)) return `contains brand "${label}"`;
    if (n === b || words.includes(b)) return `is brand "${label}"`;
  }
  const whole = nearMiss(n);
  if (whole) return `near-miss of brand "${whole}"`;
  for (const w of words) {
    const hit = nearMiss(w);
    if (hit) return `word near-miss of brand "${hit}"`;
  }
  for (const [label, b] of N_GENERIC) {
    if (n === b || words.includes(b)) return `is brand "${label}"`;
  }
  for (const [label, p] of N_PEOPLE) if (n.includes(p)) return `contains person "${label}"`;
  for (const [label, s] of N_SURNAMES) {
    if (words.includes(s) || (s.length >= 5 && n.includes(s))) return `contains surname "${label}"`;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Prose matching: whole words, case-insensitive, punctuation inside the brand kept literal.
const PROSE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ...BRANDS.map((b) => [`brand "${b}"`, new RegExp(`(^|[^A-Za-z0-9])${escapeRe(b)}($|[^A-Za-z0-9])`, "i")] as const),
  ...PEOPLE.map((p) => [`person "${p}"`, new RegExp(`(^|[^A-Za-z0-9])${escapeRe(p)}($|[^A-Za-z0-9])`, "i")] as const),
  ...SURNAMES.filter((s) => s.length >= 5 && !["Gates", "Jobs", "Graham", "Huang", "Hinton"].includes(s)).map(
    (s) => [`surname "${s}"`, new RegExp(`(^|[^A-Za-z0-9])${escapeRe(s)}($|[^A-Za-z0-9])`, "i")] as const,
  ),
];

/**
 * Why a piece of PROSE (billboard copy, dialogue, descriptions) is not allowed, or null.
 * Looser than names: generic-word brands and common surnames are ordinary English here.
 */
export function blockedProseReason(text: string): string | null {
  for (const [label, re] of PROSE_PATTERNS) if (re.test(text)) return `mentions ${label}`;
  return null;
}
