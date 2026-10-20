# Fog City — game design (living document)

The source of truth for what the game is. Every agent reads this before building gameplay.
Numbers marked *(tune)* are starting points to adjust after playtesting on real hardware.

## Pitch
You just moved to San Francisco, about five years from now, with a car, a water blaster and
18 months of runway. The city runs on robots: robotaxis fill the streets, helpers carry
groceries up the hills. Most of them are helpful. Someone is releasing bad ones.

## Pillars (in priority order: when two ideas conflict, the higher pillar wins)
1. **It is really San Francisco.** Real streets, real hills, real building massing, the
   landmarks where they belong. Realism comes from the city, not from photoreal pixels.
2. **Driving feels great.** Hills, jumps, drifts, a city that reacts.
3. **The city is alive.** Traffic, people and robots with routines who react to you.
4. **Combat is readable and escalates.** You can always tell what is happening and why.
5. **Satire that punches up.** Tech and VC culture are the joke; nobody vulnerable is.
6. **Non-violent to people, always.** People get wet and annoyed, never hurt.

## Core loop
Explore → spot trouble (a bad robot's tells) → rust it with water → it fights back and calls
others → escalate or escape → earn runway and reputation → unlock blaster upgrades,
vehicles, neighbourhoods and missions.

## Combat: water and rust
- **The water blaster** fires an arcing stream (deterministic projectile particles in the sim,
  affected by gravity). Tank 8 L, flow 0.8 L/s, range ~12 m *(tune)*. Refill at fire
  hydrants (2 s), fountains, or the Bay's edge.
- **Rust.** Every robot has `rust` 0→1. Water exposure adds rust: 0.25/s at full stream on a
  standard bad robot *(tune)*, so about 4 s of sustained hits. Armoured models rust at half
  speed. **Salt water** from the Bay rusts 1.6× faster: real chemistry, and a reason to drive to
  the waterfront to refill.
- **Melt sequence** (sim state; the renderer animates from state + timer): `active` →
  `seized` (0.5 s, sparks, joints lock) → `slumping` (1.5 s, the body sags as rust spreads
  over the shell) → `heap` (a rusty pile and a puddle that stays until a cleanup bot comes,
  which is its own joke).
- **Wrong targets.** A good robot hit with water starts rusting too: it slows, apologises and
  limps to a repair kiosk, and you lose reputation and runway. A person hit with water gets
  wet and annoyed (a bark, a wet look) and you lose points. Nobody is ever harmed.
- **PvP** keeps the flower launcher: a hit puts flowers in the other player's hair.
- **Fog rusts robots.** In fog-heavy neighbourhoods (Sunset, Richmond) at night, exposed
  robots gain rust slowly (0.01/s *(tune)*). Bad robots avoid the fog, so the west side is
  safer after dark. This is an emergent SF-only system.

## Bad robots fight back
They are saboteurs first; once spotted or attacked, they turn on you and on helpful robots.
All attacks are slapstick or satire, never injury:
- **Shove:** knockback and a stumble; costs ~6% runway *(tune)*.
- **Ad blast:** pop-up ads cover your screen until you swipe or press to clear them;
  runway drains while they are up.
- **Phone hack:** drains runway while the robot stays within ~4 m.
- **Grab:** holds you for up to 2 s; mash to break free.
- **Carjack:** a bad robot can steal your parked car (the GTA move, reversed).
- **Convert:** 6 s near a helpful robot turns it bad. Its face light flickers during the
  conversion, a tell you can catch, and the infection spreads if ignored.
- **Swarm:** at high threat, nearby bad robots converge.

## Health, failure, heat
- **Runway is health**, shown in months (start at 18). It drains from attacks and is restored
  by income, food (burritos) and rest at a safehouse.
- **DOWN ROUND** replaces "WASTED": at 0 runway you respawn at your nearest safehouse and
  lose 20% of your cash *(tune)*.
- **ACQUI-HIRED** replaces "BUSTED": maxed-out VC attention catches you; you lose the
  current mission and are "integrated" for a day.
- **Threat** (0–5 warning lights) is robot heat: it rises when bad robots see you rusting
  their kind, drives swarming, and decays after ~30 s out of sight. **VC attention** (0–5)
  is the satire meter, raised by hype, stunts and pitching; associates chase you to invest.

## The living city
- Robotaxis are most of the traffic. They obey every rule and stop dead for a traffic cone on the
  hood (coning: a real SF 2023 prank, here a non-destructive tool).
- Errand robots, sidewalk delivery bots and people share the sidewalks; robots outnumber people
  about 3–4 to 1 *(tune)*.
- **Vehicles never hurt people.** Pedestrians dodge (GTA-style dives, slapstick), and contact is a
  gentle push that stops the car. Enforced in the sim.
- Routines: robots run errands between real storefront anchors and homes; people commute;
  night shifts the mix (the 4 a.m. robotaxi honk choir in SoMa, the 3 a.m. firmware freeze on
  Columbus).

## Vehicles (rollout order)
Your car → robotaxis you can hail, or politely commandeer for a VC-attention cost → scooters and
e-bikes → Muni buses (drive a route as a side job) → cable cars (ride the hills; the grip is
operated by a person, and it's iconic) → ferries (the Ferry Building ↔ Sausalito, later).

## Territory (the whole city, in this order)
Each step is pipeline work over more tiles once streaming exists.
1. Downtown / Financial District / Embarcadero (M0)
2. North Beach, Fisherman's Wharf, the Marina, Dogpatch (M1)
3. SoMa, Mission Bay, Rincon Hill, the Bay Bridge approach
4. Russian Hill, Nob Hill, Chinatown, Telegraph Hill, Lombard Street (the hills)
5. The Presidio and the Golden Gate Bridge approach; Pacific Heights; Cow Hollow
6. Hayes Valley, the Western Addition, Alamo Square (Painted Ladies), Haight-Ashbury
7. The Mission, the Castro, Noe Valley, Twin Peaks, Sutro Tower
8. Golden Gate Park, the Richmond, the Sunset, Ocean Beach
9. Potrero Hill, Bayview, Hunters Point, the Excelsior and the remaining south and west districts
10. Later: South San Francisco (outside SF's open data; needs another source and a licence check)

**Water and islands:** the Bay at sea level; Alcatraz and Treasure Island are visible first,
drivable later.

## Missions and side activities
- **Campaign spine** (about 10 missions): arrive and get a desk → build the thing → the first
  bad robot → the YC pitch (Dogpatch) → demo day → the big rival's bot army → the
  finale on the Bay Bridge.
- **Side activities:** rust bounties, coning, chasing oranges down Filbert Street, races up
  Lombard, delivery shifts on the hills, Muni driver shifts, photo spots at landmarks.
- **Missions are data** (`content/missions/*.json`) interpreted by the sim runtime.

## Navigation and UI
Minimap with a GPS route line on the real road graph; a phone (map, texts, missions, radio);
touch controls (virtual stick + buttons) so it is playable on a phone.

## Day, night and fog
Day/night cycle (~24 real minutes per game day *(tune)*). Fog rolls in from the west in the
evening and thins by midday, and gameplay reacts to it (see "Fog rusts robots").

## Art direction
Stylised-realistic. Real massing; facades by era and use (assessor year built, use, stories);
baked or approximated GI; golden hour by default; SF fog; night is where the city glows.
Hero landmarks are hand-modelled in scripted Blender.

## Legal and taste (also in CLAUDE.md)
- No real brands, logos or trademarks; invented companies and products; storefronts unnamed.
- Original vehicle and robot designs.
- Public figures only as obvious caricature with invented names.
- **Pre-release legal checklist** (does not block private builds): R-Evolution (sculpture,
  needs the artist's permission or an homage), Golden Gate Bridge and Transamerica Pyramid
  (owners have asserted trademark rights over their images), any named venue.

## Decision log
- 2026-10-20 · Water/rust blaster replaces the patch launcher. It reads instantly, sprays
  are fun, rust is a visible progress bar on the target, and it is non-violent.
- 2026-10-20 · Bad robots attack the player and convert helpful robots. Combat needs a
  threat or there is no tension; the attacks are slapstick and satire.
- 2026-10-20 · Runway is health; DOWN ROUND / ACQUI-HIRED replace WASTED / BUSTED.
- 2026-10-20 · Territory expands district by district across all of SF behind streaming + LOD.
- 2026-10-20 · Sim physics is our own pure TypeScript, not Rapier: SimState must be plain JSON
  for multiplayer and replays. Rapier is allowed only for cosmetic effects in the renderer.
- 2026-10-20 · Near-future setting: robots outnumber people; humans stay present but are
  costlier to render.
