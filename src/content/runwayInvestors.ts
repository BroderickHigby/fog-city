// Runway Run: the invented investors who wait on the street. Every firm and person is made up and
// SF-flavoured; the puns are on purpose, so no name reads as a real person. tests/sim/runway-run
// runs the content lint's text rules and the real-firm blocklist over this list. "Accelerator" is
// the only word for that kind of firm (docs/design.md, Legal and taste).

export interface RunwayInvestor { readonly name: string; readonly firm: string }

export const RUNWAY_INVESTORS: readonly RunwayInvestor[] = Object.freeze([
  { name: "Bridget Overfund", firm: "Fogbank Ventures" },
  { name: "Hank Termsheet", firm: "Clang Clang Ventures" },
  { name: "Tobias Hindsight", firm: "Foghorn Partners" },
  { name: "Marguerite Pivot", firm: "Mother Dough Capital" },
  { name: "Ozzie Dilution", firm: "Ninth Hill Partners" },
  { name: "Lena Runwater", firm: "Pier Pressure Capital" },
  { name: "Dev Clifftrust", firm: "Steep Street Ventures" },
  { name: "Greta Vestwell", firm: "Marina Mist Partners" },
  { name: "Rex Upround", firm: "Dungeness Capital" },
  { name: "Priya Burnrate", firm: "Rate Cut Capital" },
  { name: "Cornelius Capp", firm: "Tunnel Vision Ventures" },
  { name: "Mabel Moonshot", firm: "Always Late Capital" },
  { name: "Wendell Hockeystick", firm: "Outer Sunset Equity" },
  { name: "Isadora Leverage", firm: "Lombard Twist Partners" },
  { name: "Boone Seedsworth", firm: "Sutro Heights Ventures" },
  { name: "Noor Pitchfork", firm: "Burrito Run Capital" },
  { name: "Gus Backstop", firm: "Salt Fog Partners" },
  { name: "Thea Bridgeloan", firm: "Hilltop Hindsight Fund" },
  { name: "Franklin Stretch", firm: "Cold Brew Capital" },
  { name: "Odalys Handshake", firm: "Seventh Fog Ventures" },
  { name: "Percy Valuation", firm: "Downhill Equity" },
  { name: "Zadie Softlanding", firm: "Pacific Mist Capital" },
]);
