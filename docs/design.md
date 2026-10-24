# Fog City — game design (living document)

The source of truth for what the game is. Every agent reads this before building gameplay.
Numbers marked *(tune)* are starting points to adjust after playtesting on real hardware.
The wave plan is `docs/roadmap.md`. The AI layer is `docs/ai-layer.md`.

## Pitch
You just moved to San Francisco, about five years from now, with a car, a water blaster and
18 months of runway. The city runs on robots: robotaxis fill the streets, Footmen carry
groceries up the hills, Trundles roll burritos down the sidewalks. Most of them are helpful.
Someone is pushing a forced update that turns them bad. You tell which ones by how they
behave, and water rusts them solid.

The someone is **Moat Labs** ("Every robot. Eventually."), a startup whose plan is to own every
robot in the city: a moat made of robots. Its jailbroken firmware turns helpers into saboteurs
that steal groceries, hack phones, steal cars and push the update to the next robot.

## Pillars (in priority order: when two ideas conflict, the higher pillar wins)
1. **It is really San Francisco.** Real streets, real hills, real building massing, the
   landmarks where they belong. Realism comes from the city, not from photoreal pixels.
2. **Driving feels great.** Hills, jumps, drifts, a city that reacts.
3. **The city is alive.** Traffic, people and robots with routines who react to you.
4. **Combat is readable and escalates.** You can always tell what is happening and why.
5. **Satire that punches up.** Tech and VC culture are the joke; nobody vulnerable is.
6. **Non-violent to people, always.** People get wet and annoyed, never hurt.

## The yardstick: what "like GTA" means here
Take from open-world games: drive anywhere in the built city with no loading screens; every
street is a real street with its real grade; something to do within 60 s of driving from any
point *(tune)*, guaranteed by the Ambient Director; heat that escalates and that you can escape;
any vehicle you can see is one you can use (hail, rent, ride or drive); a chase that is also the
fight; safehouses; a phone; radio; day, night and weather that change play; missions with a story
spine and side activities that pay.
Do not take: violence, crime against people, running people over (players included), police
chases of people. The heat is robots and venture capitalists, and every "attack" is slapstick or
satire.

## Core loop: Bot Hunt
1. **Explore.** Drive, ride or walk. The minimap shows bounties, hydrants and missions.
2. **Spot trouble.** A bad robot looks exactly like a good one. Its behaviour gives it away
   (see "Telling good from bad"). **Watch** a robot to read its recent path, sound and status
   light. Bot Check, the scanner app on your phone, gives a second opinion that is confident,
   sometimes wrong, and makes nearby bad robots wary.
3. **Rust it.** Spray it with water. A rust bar fills on the target.
4. **It fights back.** It attacks you or the nearest good robot, and calls others. Threat rises,
   and Moat Labs vans bring more.
5. **Escalate or escape.** Melt the group, or break line of sight in fog, traffic or a car wash.
6. **Get paid.** Cash, a little runway, reputation, XP and streak points. Subtler targets and
   robots caught in the act pay more.
7. **Spend.** Blaster upgrades, car tuning, safehouses, perks; new districts, missions and modes.

Session shapes *(tune)*: a 2-minute loop (spot, watch, melt), a 10-minute loop (a bounty crew
to threat 2–3 and an escape), a 60-minute loop (a mission, an upgrade, a new district).

## Combat: water and rust
**The water blaster.** Fires an arcing stream: deterministic projectile particles in the sim,
under gravity. All values *(tune)*:

| Stat | Start | Max (upgrades) |
|---|---|---|
| Tank | 8 L | 16 L |
| Flow | 0.8 L/s (10 particles/s) | 1.2 L/s |
| Muzzle speed | 13 m/s | 16 m/s |
| Effective range | ~12 m | ~18 m (Pressure Washer nozzle) |
| Rust at full stream, standard robot | 0.25/s (about 4 s to seize) | 0.35/s |

- **Refill:** fire hydrants (2 s, real hydrant locations from SF open data), public fountains
  (2 s), the Bay's edge (3 s, salt), rain puddles (at 0.5× speed), your car's trunk tank once
  upgraded (2 s from a 20 L reserve).
- **Salt water** rusts 1.6× faster: real chemistry, and a reason to drive to the waterfront. The
  tank shows a salt indicator; a tank holds one water type at a time.
- **Which water rusts what.** Good robots (and Tidy) are **splash-rated**: only a direct stream
  (your blaster, the Roof Cannon, a teammate's blaster) rusts them. Fog, rain, puddles,
  Microclimate-as-a-Service, the Lawn Sprinkler, Open Hydrants and Water Balloon splash rust only
  robots running Moat firmware. In the fiction the jailbreak strips the splash seal "to save
  40 g", which is also why bad robots step around puddles. A seeded test runs a Marina night at
  fog density 0.8 and asserts every good robot stays below 0.3 rust.
- **Rust.** Every robot has `rust` 0→1. Armoured models rust at 0.5×; ad drones at 1.5×.
  Below 0.3, rust dries off at 0.02/s after 5 s without water; at 0.3 and above it is permanent
  ("rust doesn't un-rust"), so commit or lose progress. At 0.5 a robot moves at 0.7× speed and
  its attack wind-ups take 1.3× longer; at 0.8 it limps and throws sparks.
- **Melt sequence** (sim state; the renderer animates from state + timer): `active` →
  `seized` (0.5 s, sparks, joints lock) → `slumping` (1.5 s, the body sags as rust spreads over
  the shell) → `heap` (a rusty pile and a puddle that stays until Tidy, the cleanup bot, comes
  to haul it away, which is its own joke: Tidy apologises to the heap). Until Tidy arrives in
  wave 3, a heap clears when it leaves the fidelity radius.
- **Every rusted-out robot visibly goes down** (owner request, 2026-10-22): it falls over or melts,
  never just stops where it stood. Each model has its own collapse, slapstick and never an injury:
  - **Footman:** seizes mid-stride, its knees buckle, it topples forward with a creak, and its
    shell sags and runs into a heap with the lantern head on top; its grocery bag spills (the
    oranges roll downhill).
  - **Trundle:** the wheels lock, the roll-top lid pops open with a puff of steam, and it sinks
    on its axles into a squat heap with the lid on top.
  - **Patrol unit:** the treads seize, the lectern folds down mid-sentence, and it slumps flat
    like a tent with the poles pulled.
  - **Ad drone:** the rotors stall and it drops to the pavement with a clatter, its screen
    flickering one last ad before the heap.
  - **Sign-spinner:** the board spins once more on momentum, then the spinner topples after it.
  - The **Meander robotaxi** never melts (it pulls over; see "Robotaxis"), and the **Moat Walker**
    has its own finale sequence.
  The fall is part of `slumping` (the sim's state and timer drive it, so every player sees the
  same fall); the drawn body ends at most 40% of its standing height, then becomes the heap.
- **Restored from backup.** Heaps are hauled to the nearest repair kiosk. A helper that had been
  converted reboots there as a good robot after 60 s ("Restored from backup. Some memories may
  be lost."). Nothing is ever destroyed; robots are repaired.
- **Aim.** On foot: over-the-shoulder camera, the stream follows the aim. Soft aim assist bends
  aim up to 6° toward the nearest robot in a 10° cone (stronger on touch). In a car: window spray
  at speeds ≤ 7 m/s (25 km/h): 60% flow, 8 m range, sideways only. A co-op passenger sprays at
  full flow. From a cable car running board: full flow. The **Roof Cannon** (a wave-4 upgrade fed
  by the trunk tank) fires in a 30° forward arc, 15 m range, 0.5× rust, at any speed.
- **The Traffic Cone** is a base item from wave 2, not a gadget: everyone carries 3 *(tune)*,
  restocked whenever you get back in your car, thrown with the `cone` action. It can be thrown
  from the car window at any speed, and so can the Water Balloon once gadgets arrive in wave 4.
  That is how a chase ends: a cone on the hood of a rule-obeying vehicle (any robotaxi, or your
  Hatch driven by a thieving Footman, which signals every lane change) makes it pull over within
  3 s, and then you spray.
- **Gadgets** (wave 4; one equipped; see Loadouts): Water Balloon, Lawn Sprinkler, Decoy Speaker.
- **Wrong targets.** A good robot counts as a wrong target only when your stream takes it to rust
  0.3. Grazes below that dry off with no penalty and no streak reset. At 0.3 it slows, apologises
  and limps to a repair kiosk; you lose 5 reputation and $50. A standing adult hit by 3 or more
  particles within 2 s *(tune)* gets wet and annoyed (a bark, a wet look); you lose 3 reputation
  and $20 for dry-cleaning. Wet-person barks show annoyance only, never distress.
- **Never wet.** Water never reaches an animal, a child, or a person who is seated, lying down or
  using a mobility aid: particles that would reach one are removed, and they never enter a wet
  state. Animals also startle away before the stream arrives: no wet state, no shake-off. Water
  from a vehicle (window spray, Roof Cannon) never wets any person. A thrown cone or balloon that
  would land on a person or animal is removed. The fuzz test that sprays random streams through
  crowds covers all of these.
- **Player-controlled bodies.** Water on a player-controlled body only ever affects a robot body
  (a Hide in the Crowd teleoperated unit), never a human avatar. A founder's avatar never gets wet:
  co-op teammates' and rivals' streams pass through it.
- **PvP** uses flowers, the blaster's alt-fire in PvP modes: 20 m range, one slow lob every 1.5 s.
  A hit puts flowers in the other player's hair and has a per-mode effect (see Modes). Flowers
  never hit NPCs.
- **Fog rusts Moat firmware.** Where fog density is above 0.6 at night (the Sunset and the Richmond
  once built; the Marina and the Presidio first), exposed bad robots gain rust at 0.01/s *(tune)*.
  Good robots are splash-rated and unaffected. Bad robots avoid the fog, so the west side is safer
  after dark. An SF-only system.

## The robots
All designs are original. Good and bad units of one model look identical; the difference is
behaviour (and, at the easiest subtlety, a scuffed sticker). Every maker name is provisional until
it passes the name search (see Legal and taste).

| Model | Maker (invented) | Role and silhouette | Bad variant | Rust rate | First wave |
|---|---|---|---|---|---|
| Footman | Bramblecot Home | Tall, slim errand humanoid; opaque ceramic shell, no translucent face plate or torso; a lantern-shaped head with a soft face-light strip; carries groceries | yes | 1.0× | 1 |
| Trundle | Trundle | Four-wheeled sidewalk delivery bot with a roll-top lid like a bread bin; not a cooler, no flag on a whip antenna | yes | 1.0× | 1 |
| Meander robotaxi | Meander ("We'll get you there.") | Long, low, asymmetric hatch with a sensor band wrapped along the roof edge and one sliding kerb-side door; not an SUV with a roof dome, not a symmetric pod. Most of the traffic; obeys every rule; scenic routes | rogue robotaxi (always empty) | 0.7× | 1 |
| Ad drone | Moat Labs | Hovering screen at 6 m; ad blasts | always bad | 1.5× | 3 |
| Patrol unit | Moat Labs | Low, wide graphite wedge on treads with a fold-out lectern, no white egg or bullet shape; reads Terms of Service aloud | always bad | 0.5× | 3 |
| Sign-spinner | Moat Labs | Rebrands sandwich boards with buzzwords | always bad | 1.0× | 3 |
| Tidy | City contractor | Cleanup bot that hauls heaps | never (different firmware); splash-rated | 1.0× (direct stream only) | 3 |
| Moat Walker | Moat Labs | Bus-sized four-legged walker, low-slung like a moving footbridge; no gun-like mast or turret; finale and threat 5 | always bad | 0.3×, weak points 1.0× | 8 |

Each silhouette above is recorded in the asset spec, and a **trade-dress checklist** in the
`tests/assets` review compares every robot and vehicle with the nearest real product or film robot.
The wave-1 robotaxi, errand robot and sidewalk bot are checked against this table before merge.

The Patrol unit targets only the player and robots. It never tells a person to move on, never
patrols a doorway or sidewalk against people, and its barks are Terms of Service only.

### Telling good from bad
Tells are data (`content/bot-tells.json`, schema exists), each with a subtlety 1 (obvious) to 5
(subtle). A bad robot shows 2–3 tells; higher-rank districts use subtler ones. Tells are
robot-only behaviour: a tell never involves a child, and a test asserts that people NPC routines
never emit tell ids. Examples:

| Tell | Subtlety |
|---|---|
| Scuffed QR sticker on its back | 1 |
| Asks passers-by to "rate your sidewalk experience, 1 to 5 stars" | 1 |
| Tails a good Footman at 2 m for more than 15 s | 1 |
| Tries car door handles with a "pairing..." chime | 2 |
| Reads number plates with a visible scan beam | 2 |
| Turns its head to track you as you pass | 2 |
| Waits at a crosswalk through a full walk signal | 2 |
| Walks against the flow on a busy sidewalk | 2 |
| In rain, skips the rain cape and shelters instead | 2 |
| Its grocery bag swings like it weighs nothing | 3 |
| Steps around puddles and gives hydrants a wide berth (no splash seal) | 3 |
| Hums the Moat Labs four-note jingle | 3 |
| Never stops at a charging dock; its status light always reads 100% | 4 |
| Walks the same three-step loop | 4 |
| Will not enter fog | 4 |
| Takes the stairs when there is a ramp (Footmen always take ramps) | 5 |

**Watch.** Hold aim without firing (tap on touch) on one robot within 30 m, on foot or from a
stopped car. The view zooms 2×, draws that robot's last 20 s of path as a faint trail (tailing,
loops, walking against the flow and loitering read at a glance), isolates its audio (the jingle)
and shows its public status light (battery %). One robot at a time. Watching for more than 3 s
from within 10 m makes a bad robot `wary`. `watch` joins the wave-2 input contract.

**False tells.** Good robots glitch too, and those glitches overlap the tells: a low-battery
Footman stands still at crosswalks; a Trundle that lost GPS in fog repeats a loop; a Footman does
"the robot" for a kid; one apologises to a pigeon; pinged good robots glance at you. One tell
alone is never proof.

**The 3 a.m. firmware freeze.** Every night at 03:00 every good robot in North Beach (then
citywide) pauses for 20 s to install the nightly update. Bad robots do not pause. Anything
moving on Columbus Ave at 03:00:10 is bad: the best spotting window in the game.

**Bot Check (scanner).** You start with Bot Check beta (tier 1), a prototype from your cofounder.
Hold scan for 1.0 s on a robot within 25 m in line of sight. The phone shows a label and a
confidence. Accuracy at subtlety 3 is 0.70 / 0.80 / 0.90 / 0.95 by scanner tier, −0.05 per
subtlety above 3 and +0.05 below *(tune)*. The confidence shown is always between 85% and 99% and
is uncorrelated with accuracy. That is the joke and the lesson: read behaviour. The result is
drawn from the sim's RNG so replays match.
**The ping costs you information.** A scan pings: bad robots within 30 m go `wary` for 10 s (they
keep their disguise, stop sabotaging and hide one tell), and good robots within 30 m glance at you
("Did you need something?"). Only the scanned robot goes `alerted`, and only if it is bad and
within 10 m. Do Not Disturb removes the ping. A seeded test over 1,000 crowd scans asserts that the
share of bad robots that visibly react to a ping is no higher than the share of good robots that do.

### The bad-robot brain (honest scope)
A per-archetype state machine, with goals in data (`content/robot-goals.json`: goal, trigger,
target selection), running on the wave-1 road agents and, for robots on foot, the wave-2 sidewalk
graph (wave 1's walkers use offset road edges as a placeholder until it arrives):
- `disguised`: runs its errand script with its tells injected; sabotages when unobserved (snatch
  groceries, push an update, stick an ad, try a car door). **Unobserved** means the player is more
  than 20 m away, facing away, or in a vehicle, so a stake-out from 25 m, from the car or through
  the Coit viewer sees sabotage happen. When sabotage starts within 150 m, BotBounty flashes
  "sabotage in progress" for 30 s. A melt during active sabotage pays "caught in the act": +50%
  cash and +1 reputation.
- `wary`: after a ping or a close Watch; keeps the disguise and errand, stops sabotage, hides one
  tell for 10 s, then returns to `disguised`.
- `alerted`: it knows where you are; it stops sabotage, looks at you, and chooses fight or flee.
- `attack`: pursues its target on the sidewalk graph and uses its attacks.
- `flee`: at rust ≥ 0.6 it runs away from water and fog, toward other bad robots.
- `seized` → `slumping` → `heap`.

**Knowledge model.** A bad robot learns your position only from: sight (100° cone, 30 m ×
(1 − 0.6 × fog density)); hearing (your spray within 20 m, your horn within 40 m); and a broadcast:
when a bad robot seizes, it sends your last-seen position to bad robots within 60 m. A scan ping
within 30 m makes it `wary`, not `alerted`. Associates use the same model with their own ranges.
Perks and streak rewards work by changing these channels, which is why they work against bots.

**Target choice.** Alerted and within 15 m of you: attack you. Otherwise, the nearest good robot
within 10 m: push an update or snatch its groceries. Weights per archetype are in data. Bad
robots attack the player and other robots, never people. At most 2 bad units are in melee range
of the player at once; the rest use ad blasts and phone hacks from range.

**Fog.** Bad robots avoid fog. A bad robot in `attack` with you in sight follows you into fog for
up to 8 s, rusting at 3× the fog rate ("it panics"), then breaks off. During a threat-5 fleet
update, fog avoidance is off. Fog stays a strong escape because sight already shrinks with
density.

**Steering** reuses the wave-1 road agents and the wave-2 sidewalk graph, with added stuck
detection (no progress for 2 s → back off and replan) and a sidewalk pursuit mode. Every system is
tested by seeded replays, not by feel.

### Bad robots fight back
Every attack has a readable wind-up (face light turns amber, a sound, a pose) of at least 0.5 s,
and every effect is slapstick or satire. The player makes no pain sounds. All numbers *(tune)*.

| Attack | Who | Range | Wind-up | Effect |
|---|---|---|---|---|
| Shove | Footman, Patrol | 1.5 m | 0.6 s | A bump with a cartoon stumble for 1 s, never a fall to the ground and never contact at head height; −1 month runway. On a good robot: it falls over for 3 s and drops its groceries. |
| Grocery snatch | Footman, Trundle | 1 m | 0.5 s | Robots only. Oranges roll downhill; the Footman gives chase at 1 m/s, sadly. |
| Ad blast | Footman, ad drone | 8 m | 0.8 s | Up to three AR pop-ups, each covering at most a third of the screen and never the reticle; −0.2 month/s while any is up. Each close button dodges once, then stays put. On touch, a swipe anywhere clears one. |
| Phone hack | Footman, Trundle | 4 m | 0.5 s | −0.1 month/s while it stays within 4 m; your minimap scrambles. Break by distance or water. |
| The Handshake | Footman, Patrol | 1.2 m | 0.5 s | A networking handshake that will not let go, up to 2 s; 8 presses breaks free ("let's circle back"). |
| Terms of Service | Patrol | 6 m | 1.0 s | Freezes you for 2 s while it reads, unless you mash Accept. |
| Car theft | any bad Footman | your parked car | 3 s | Only when you are more than 30 m away. It drives your car to a Moat Labs depot, signalling every lane change. GPS marks it. A cone on the hood pulls it over within 3 s; then spray the robot out through the window. |
| Forced update (convert) | Footman, Trundle | 3 m | 6 s channel | Malware, not illness. The target's face light shows "Updating 0→100%". Water on the pusher (rust ≥ 0.2) or a shove interrupts it. A completed update makes the helper bad; it shows "Update complete" (subtlety 1) for 60 s and is auto-posted to BotBounty for those 60 s. |
| Box-in | rogue robotaxi | road | 2 s | Parks across the lane ahead of your car, honks, tailgates. Never targets anyone on foot. |
| Swarm | all | 120 m | — | At threat 4+, up to 8 bad units converge on you; at most 2 in melee range at once. |

Conversion is local, robot to robot. There is no district-wide spread, no "patient zero", and no
mechanic that carries the update along a street or a bus route. Moat Labs' scripted fleet
updates originate at Moat Labs HQ in SoMa.
**Conversion cap.** Inside a fidelity radius, each completed conversion adds one bad robot, up to
2× the local base rate; at that cap no new conversion starts. In protected areas (see Places) the
cap is the baseline. Beyond the fidelity radius nothing converts. A test runs a 60-minute idle
session and asserts the local rate never exceeds the cap.

## Health, failure, heat
Three numbers, never merged:
- **Runway is health**, in months. Start 18, max 18 (perks and upgrades do not raise it).
  Drained by attacks. Restored by a burrito (+2 months, $12), a pour-over (+0.5, $7.50), each
  paid bounty (+0.5: "revenue extends runway"), and sleeping at a safehouse (full; skips 8 game
  hours).
- **Cash is the wallet**, in dollars. Start $2,000 *(tune)*. Earned from bounties, gigs,
  missions and modes; spent on upgrades, tuning, safehouses, food and subscriptions.
- **Reputation**, 0–100, start 50. +1 per melt, +2 per interrupted update, +1 per catch in the
  act, −5 per good robot rusted past 0.3, −3 per wet person, −1 per robotaxi commandeered. Gates
  bounty tiers and recruits.

**Bridge Round** (free roam): at 0 runway you are running on fumes for 60 s. You walk at normal
speed, cannot spray or scan, and bad robots ignore you ("already acquired"). An associate walks
toward you from about 60 m. Reach any associate and accept a bridge note: you revive at 6 months
and gain +1 VC star. Otherwise, DOWN ROUND. The VC meter is a lifeline as well as a threat.

**DOWN ROUND** replaces "WASTED": you respawn at your nearest safehouse with 9 months, lose 20% of
your cash, threat drops to 0, and VC attention rises by one star ("the vultures circle").

**ACQUI-HIRED** replaces "BUSTED": lose a bell duel at five stars. You lose the current mission.
"You sign the offer. Next game morning you start at the BigCo campus" in SoMa (the FiDi coworking
desk until SoMa exists), wearing a lanyard cosmetic for one game day. You pay a 10% "integration
fee", and both meters reset.

### Threat (robot heat), 0–5 warning lights
Each level brings guaranteed arrivals. Moat Labs vans are dispatched from Moat Labs HQ or a depot
and enter the fidelity radius about 120 m from you; this is delivery, not spread. Vans obey the
person-clearance override like every vehicle.

| Level | Raised by | What comes |
|---|---|---|
| 1 | You spray a bad robot, or the robot you scan is bad and within 10 m | That robot fights or flees |
| 2 | Another bad robot witnesses a melt, or 2 melts in 60 s | Bad robots within 80 m converge (max 4); a van brings 2 units within 20 s |
| 3 | 4 melts in 120 s at level 2 | + 2 ad drones, + 1 rogue robotaxi boxing in your car, + 2 units by van |
| 4 | 3 more melts at level 3 | + 2 Patrol units; vans top the swarm up to 8 bad units |
| 5 | You melt a Patrol unit at level 4 | Moat Labs fleet update: every bad robot within 300 m comes for you; fog avoidance off; 4 Patrol units; the Moat Walker in finale districts |

Decay: −1 level after 30 s out of sight of every alerted bad unit (15 s in fog). A car wash drops
one level ("your sensor signature is washed off"). Hailing a robotaxi or riding a cable car
breaks line of sight. A safehouse only opens at threat ≤ 1.
A seeded test runs the competent-player driver for 10-minute sessions: it reaches threat 3 in at
least 50% of them and threat 5 in 5–15%.

### VC attention (the satire meter), 0–5 stars

| Stars | Who chases you | What they do |
|---|---|---|
| 1 | DMs on your phone ("just bumping this") | Nothing in person |
| 2 | One associate on a scooter | Cornering starts a quick call |
| 3 | Two associates in cars | Quick calls; cars pull alongside your car and block a lane, like the box-in, with no contact |
| 4 | + a partner in a long, silent original car | As 3 |
| 5 | All of them | Cornering starts a bell duel |

Raised by: a melt seen by 5+ people within 25 m (+¼ star, "went viral"); a jump with more than
1.5 s of air (+¼); commandeering a robotaxi (+1); your startup's billboard going up (+1, once);
pitch missions (+1 or +2); the Doom Clock reaching midnight (+1 for everyone); a Bridge Round (+1);
each quick call (+¼).
**Quick call** (2–4 stars): for 4 s you cannot spray or scan, unless you press Decline 6 times.
**Star bonus:** +10% cash per star, paid only while an associate is within 200 m of you (they are
hyping you). A seeded test asserts that a "hold 4 stars" policy earns no more cash per minute than
ordinary play.
Decay: −1 star after 20 s out of every associate's sight (10 s in fog). A safehouse opens only at
≤ 2 stars.
**Cornered:** an associate within 3 m of you for 3 s in total while you move slower than 2 m/s.
Associates are people: they walk up or pull alongside; vehicles never touch them.

**Bell duel.** At the nearest cable car turntable (Powell & Market and Hyde & Beach first). The
associate who cornered you rings a pattern of 4–8 bell rings; you repeat it within ±120 ms per
ring *(tune)*. Best of three. Win: drop to 2 stars and get $500 ("we'll circle back"). Lose:
ACQUI-HIRED.

## The living city
- **Population.** Within each fidelity radius in free roam: up to 180 robots, 50 people and 70
  vehicles *(tune)*. Robots outnumber people about 3–4 to 1. Modes declare their own densities
  (see Simulation scale).
- **Bad-robot rate.** A function of distance to Moat Labs sites and tech venues only:
  - the citywide baseline, 2% of robots *(tune)*, scaled uniformly by the Doom Clock and by events;
  - plus a Moat Labs term: +4% at Moat Labs HQ, falling to 0 at 1.5 km, and +2% at each depot and
    at the convention center, falling to 0 at 600 m;
  - at night in dense fog the rate halves (the west side is safer after dark).
  That gives about 6% near HQ in SoMa, 3–4% in FiDi and 2% in North Beach and the Marina. Moat Labs
  HQ sits on the convention-center block in SoMa; the depots are the robotaxi depot lot by the Bay
  Bridge touchdown and a Mission Bay lot. In protected areas (see Places) the rate is the baseline
  and never more: the Moat Labs term, bounty crews, director cards and conversions add nothing
  there. Vans called by threat follow the player and are the only exception. A content test checks
  the rate table, the site list and the clamp.
- **Robotaxis** are most of the traffic. They obey every rule and stop dead for a traffic cone on
  the hood (coning, a harmless real SF prank, used here as behaviour with no company named).
- **Routines.** Footmen run errands between storefront anchors and homes; Trundles run delivery
  loops; people commute, walk dogs and sit in Washington Square; night shifts the mix toward
  Trundles. The 4 a.m. robotaxi honk choir in SoMa; the 3 a.m. firmware freeze on Columbus.
  Storefront anchors come only from ground-floor commercial parcels (assessor use code); records
  with a residential use code or an upper-floor unit are dropped. Tiles and content carry only a
  position and an icon type, never a business name, owner or address, and a pipeline test fails if
  those fields appear.
- **Ambient Director.** After every 45–75 s of play with no active objective, it stages one card
  within 150 m from sim primitives: a snatch in progress, oranges rolling down a hill, a rogue
  robotaxi parked across a hydrant, a Trundle stuck in a puddle, an associate's quick call. Wave 2
  ships 40–60 hand-written cards (`content/director-cards.json`). A seeded test starts at 20 random
  points and asserts an encounter within 150 m within 60 s.
- **Public events.** Events run on game-week cadences, never calendar months (a game week is about
  2.8 real hours). A mission can force an event window with a mission step (`event.force{id}`).
  - **Tuesday noon:** the real siren test. Every robotaxi pulls over for 60 s; associates text
    "is this a down round?".
  - **King tide** (one seeded game day each game week): the Embarcadero promenade floods 10 cm.
    Salt puddles everywhere; refill anywhere; bad robots avoid the waterfront.
  - **Air-show rehearsal** (every Friday 12:00–14:00 game time): an invented jet team flies a
    fixed path over the water off the Marina; the Pitch Window activity opens.
  - **Fleet Week** (every fourth game week): full crowds on Marina Green and the full flight
    programme.
  - **Conference Week** (every fourth game week, offset by two from Fleet Week; SoMa): lanyard
    crowds, double AI ads, Moat Labs demo units (bad-robot rate ×1.5 near the convention center).
  - **Rain** (winter weeks; see Day, night and weather).
  - **The Doom Clock** reaching midnight or AI Winter (see below).
  - **Fog Front** (weekly, once Fog Royale exists).
  A calendar test asserts that every event-gated activity is available at least once per 3 real
  hours of play, every full event happens at least once per 12, and every mission that needs an
  event completes from any start date.
- **Vehicles never hurt people. Enforced in the sim:**
  - Every human is on the person collision layer, which no vehicle or prop can touch: NPC people,
    remote players' and bots' avatars, associates, anyone on foot, on a scooter or e-bike (the
    rider and vehicle count as a person, not a vehicle), or on a running board. Animals share the
    layer.
  - The person-clearance override: any vehicle with a person or animal in its swept path within
    its stopping distance + 2 m brakes to a stop, whatever its tuning. Occupied cable cars and
    buses count as people for the override. Pedestrians get out of the way on their feet: a
    startled sidestep, jog or sprint at human speed, never a hop (decision log, 2026-10-23).
  - Pedestrians cross only at crosswalks, during their signal phase, with gap acceptance: they
    never step out in front of a vehicle whose stopping distance exceeds the gap. Dodging comes
    before the override. The `?bench=` summary reports override activations per minute; the target
    is at most 1 per minute of normal driving.
  - If contact ever happens, it is a gentle push that stops the car dead.
  - Drops, cones, sprinklers and props spawn only on spots with no people.
  - A no-brakes contract fails the moment the override fires, instead of hitting anyone.
  - **Jumps.** An airborne car cannot brake, so the crest detector stores each crest's landing
    envelope at the maximum tuned speed. While a player vehicle within 150 m heads at a crest,
    people and animals path out of the envelope and nothing spawns inside it. If anyone is still
    inside at take-off, the crest does not launch the car on that pass. The raised-drawbridge jump
    is live only when the landing side's sidewalks are clear.
  - The Moat Walker's feet never land within 3 m of a person or animal; crowds clear ahead of it
    with slapstick dives.
  - Robots on foot dodge cars too. You cannot run a robot over; water is the only way to beat one.
  - Car-to-car contact dents cars (car condition 0–100) and costs repair money, never runway.
    Player cars can only dent each other. At condition 0 your car "is in the shop" and returns at
    the nearest garage for $300.
  - Tested: seeded chase, jump, no-brake and Royale drivers, plus a jump driver at maximum "Make
    it faster" speed with a crowd seeded on the landing side, plus 2-player drivers in which a car
    drives straight at a rival on foot, on a scooter and on a running board. All run with zero
    vehicle–person and prop–person contacts and a minimum clearance of 0.75 m *(tune)*.

## Simulation scale and world data
- **Fidelity by distance, never by camera.** Agents within 300 m of any fidelity anchor run the
  full sim. Anchors are every player and every match participant, human or bot. The Coit Tower
  viewer adds a temporary anchor at its aim point while it runs (radius 120 m), because the aim
  point is a sim input. The sim never reads the camera; a test checks that one seeded driver run
  gives the same state hash with and without a renderer attached.
- **Significant and ambient agents.** SimState persists only significant agents: player cars,
  converted robots, bounty targets, recruits, the car thief, vans, mission actors (2,000 or fewer).
  The ambient population is spawned procedurally from (spawn square, time bucket, world seed) when
  a 100 m spawn square enters a fidelity radius, and despawned when it leaves every radius. Handoff
  is deterministic (snap to lane, carry speed over). An ambient robot that converts, or that a
  player has wetted, rusted, scanned or recruited, becomes significant and survives despawn.
  Significant agents beyond every radius advance abstractly along graph edges on a timetable; the
  abstract sim converts nothing and fights nothing.
- **Mode densities.** Each mode's JSON declares its ambient density: 60 or fewer ambient agents per
  anchor and 800 or fewer in total per match *(tune)*, enforced by a test. Bot Sweep and Clean
  Streets make their whole 600 × 600 m instance full fidelity.
- **Budgets, measured in CI** (the build machine has a CPU even without a GPU):
  `scripts/bench/sim.ts` and a Harness test run the dense `?bench=embarcadero` scenario in Node with
  1 and 4 anchors. Targets: sim step p95 ≤ 0.7 ms per tick for 4 anchors, so rollback can
  resimulate 8 ticks inside a frame; SimState JSON ≤ 1.5 MB. The test fails on a regression of more
  than 20% against a committed baseline. Rollback keeps past states as references in a ring buffer
  (free with the immutable step). Agents more than 150 m from every anchor may update at a reduced
  rate chosen by a sim rule.
- **World data in the sim.** Every client and the server must hold identical collision data at
  every tick, or they desync. Wave 2 chooses between (a) a compact binary citywide collider
  (footprints quantised to integer cm, int16 heights; about 15–20 MB for all of SF) loaded whole
  on every client and the server, the preferred option, and (b) deterministic paging, where the
  required tile set is a pure function of SimState (anchors + 300 m + a prefetch margin) and the
  step holds an anchor's full-fidelity agents abstract until their tiles are present. Either way,
  ground lookups use an indexed tile lookup instead of a linear scan, and a test checks boot bytes
  and parse time for the shipped world.
- **Decks, tunnels and water.** An additive tile-collider schema change in wave 2 adds `decks`
  (ribbons with per-vertex height, width and layer), `tunnels` (a ribbon plus a ceiling) and
  `movable` (the drawbridge hinge, its angle held in SimState). `surfaceHeight(x, z, yHint)`
  replaces the ground lookup and picks the highest surface at or below the agent. Deck profiles
  come from a hand-authored overrides file for the few bridges in each step. Water is a sim
  boundary: a sea-wall collider along the shore; a vehicle that somehow reaches open water is
  "towed, $300". Tests: a seeded drive over the 3rd St bridge keeps y above 3 m, and nothing enters
  open water.
- **Road profiles.** The 10 m ground lattice rounds off SF's sharp grade breaks, so a Pipeline pass
  samples the elevation model at about 2 m along each road centreline, keeps the intersection
  plateaus, and gives the sim a road-surface height that overrides the lattice on roads. The
  crest detector runs in wave 3; Term Sheet Jumps ship in wave 4 only if there are at least 2 crests
  per grade.

## Vehicles (rollout order)

| Vehicle | How you get it | Handling and use | Wave |
|---|---|---|---|
| Your car (the Hatch, original design) | Yours | Top speed 38 m/s, 0–27 m/s in 6 s, handbrake drift, hill-crest jumps, window spray, window throws; 3 passenger seats; trunk tank, Roof Cannon and tuning later | 1 |
| Meander robotaxi | Hail on the phone (arrives in 20–60 s, $2 + $1.50/km); or commandeer politely an empty robotaxi or one you ride alone (+1 star, −1 rep: "Ride shared to your feed") | Ride with time skip; Backseat Prompt Rally; drive it after commandeering | 3 |
| Scooter and e-bike | Dock rental, $3 | Scooter 7 m/s, drops to 3 m/s on grades over 15%; e-bike 9 m/s with hill assist; spray while stopped; a rider is a person for every collision rule | 3 |
| Cable car | Board at any stop; ride the running board | Powell–Hyde, Powell–Mason, California St; spray from the board; the grip is operated by a person | 3 (ride), 4 (gripman) |
| Muni bus | Ride with a transit card; driver shifts | Real streets, invented livery | 4 |
| Ferry | Ferry Building ↔ Treasure Island | Ride only | 8 |

**Robotaxis and riders.** Rogue robotaxis are always empty. A robotaxi with anyone aboard never
turns rogue, never reaches rust 0.3 and never seizes: when water reaches it, it pulls over and the
rider steps out first. You can commandeer only an empty robotaxi or one you are riding alone. A
sim test covers each rule.

## Territory (the whole city, in this order)
Each step is pipeline work over more tiles behind streaming and LOD. A citywide far-LOD massing
layer ships early so the skyline and the high viewpoints (Coit Tower, Twin Peaks) always show the
whole city (budgets under Performance). Every district earns its place with a hook: one signature
activity, one local robot behaviour or tell, and a safehouse or garage within 1.5 km from the wave
the district ships (see Safehouses and garages under Progression and economy). The four excluded
areas (see Places) are built as real streets with shared content only; they are exempt from the
activity and the local bounty set, not from the 1.5 km rule.

| Step | Districts | What it adds | District hook | Wave |
|---|---|---|---|---|
| 1 | Downtown, FiDi, Embarcadero | Ferry Building (clock = Doom Clock), R-Evolution, Powell & Market turntable, Union Square, the tallest tower (unnamed) | The opening melt (Hot Desk); SF-Bench Embarcadero Sprint · Footmen queue at the Ferry Building market stalls (icons only) · FiDi coworking desk | 1 |
| 2 | North Beach, Fisherman's Wharf, the Marina, Dogpatch | Washington Square, Columbus Ave, the sea lion docks at Pier 39 (in-game text: "the sea lion docks"), Hyde & Beach turntable, Marina Green, Palace of Fine Arts, Pier 70 (tuning bench, the Ramen accelerator) | The 3 a.m. freeze on Columbus; Plain Words; the Pier 70 bench; the Fleet Week Pitch Window on Marina Green (wave 4) · Trundle night loops in North Beach · the Marina garage (wave 2); the North Beach studio, Marina flat and Dogpatch loft (wave 4) | 1 |
| 3 | SoMa, Mission Bay, Rincon Hill, the Bay Bridge approach | The 3rd St / King St connector that joins Dogpatch to downtown; the Lefty O'Doul drawbridge (jump it when raised and the landing is clear); Moat Labs HQ; the convention center; the robotaxi depot lot by the bridge touchdown; the ballpark (unnamed) | SoMa delivery shifts (wave 2); missions 5 and 8; the 4 a.m. Robotaxi Choir; rogue-robotaxi-on-the-run bounties · the highest bad-robot rate in the city (HQ) · Mission Bay garage | 2 |
| 4 | Russian Hill, Nob Hill, Chinatown, Telegraph Hill, Lombard Street | The hills: Filbert St at 31.5% (Leavenworth–Hyde), the crooked block of Lombard, Coit Tower and the parrots, Grace Cathedral, the cable car lines, the Dragon Gate at Grant & Bush; the Broadway and Stockton tunnels | Lombard races; Oranges down Filbert; hill delivery shifts; Coit Tower Recon; Human in the Loop · Footmen take ramps, never stairs · the Russian Hill garage (wave 3); the North Beach studio (wave 4) | 3 |
| 5 | The Presidio, the Golden Gate Bridge approach, Pacific Heights, Cow Hollow | Forest roads, Crissy Field, Fort Point, the Lyon St steps, the Fillmore St drop toward the Bay, Union St; the Presidio Parkway tunnels | Stair Watch bounties on the Lyon St steps (home of the "takes the stairs" tell); Crissy Field salt refills; the Presidio forest-road SF-Bench route · Pacific Heights concierge Footmen that queue for other robots · Marina flat; Presidio garage | 4 |
| 6 | Hayes Valley, Civic Center, the Tenderloin, the Western Addition, Alamo Square, Haight-Ashbury | City Hall dome, the Painted Ladies photo spot, Buena Vista Park, Octavia Blvd | The Painted Ladies photo spot at Alamo Square; the Octavia Blvd bounty chain in Hayes Valley · Trundles stack up on Octavia's side lanes · Hayes Valley micro-unit | 5 |
| 7 | The Mission, the Castro, Noe Valley, Twin Peaks, Sutro Tower | Dolores Park, 22nd St at 31.5% (Vicksburg–Church), Twin Peaks summit view | Foil Integrity; the 22nd St climb · Trundle burrito convoys · Mission flat | 6 |
| 8 | Golden Gate Park, the Richmond, the Sunset, Ocean Beach | The fog heartland; the Conservatory of Flowers, Stow Lake, the windmills, the Great Highway, Sutro Baths ruins | Great Highway fog-night races; Ocean Beach salt surf refills; mission 9 · bad robots scarce after dark · Sunset in-law unit | 7 |
| 9a | Potrero Hill, Bernal Heights, Bayview, Hunters Point | Vermont St's curves, Bernal Hill, the shipyard | Vermont St (the other crooked street) as a Lombard rival race; a Bernal Hill coin-op viewer; Royale final circles on Potrero · bad robots gather on the sunny hills on fog nights · Potrero Hill garage | 6 |
| 9b | The Excelsior, Glen Park, West Portal, Lakeshore, Visitacion Valley and the remaining south and west districts | Lake Merced | One activity and a garage for the 1.5 km rule, chosen when wave 8 is planned | 8 |
| 10 | Later: South San Francisco | Outside SF's open data; needs another source and a licence check | — | Later |

**Water and islands:** the Bay at sea level behind a sea-wall collider; Alcatraz and Treasure
Island visible from the start; Treasure Island and the Bay Bridge deck drivable in wave 8 (decks);
Alcatraz by ferry later, never driven.

## The final boss: Elizabeth Homes
*(User decision, 2026-10-20: "the final boss [is] Elizabeth Holmes out of prison ... bigger than the city
with a black turtleneck stomping and destroying the city.")*

**Who.** A giant, unmistakable caricature of the blood-testing fraud founder, just out of prison and
straight into a comeback round: black turtleneck, the impossibly deep voice, the unblinking stare, a
one-drop diagnostics startup that never worked. Her in-game name is the parody **Elizabeth Homes** (she
promises to fix the housing crisis while stepping on it). The character never claims to be the real
person. Her jokes target only her public record: hype, secrecy, the faked demos. Never her family,
her appearance beyond the signature costume and voice, prison life, or anything sexual. Using the real
name in a private build is a one-line content change the user can make. It goes on the pre-release
legal checklist either way.

**What she is.** She is Moat Labs' secret backer. "Every robot. Eventually." was her plan all along:
the finale fuses every robot Moat Labs has converted into one body in her likeness, about **500 m tall**
*(tune)*. That is taller than the Salesforce Tower and Sutro Tower, and she fills the skyline from
anywhere in the city. Because her body is robots, **water rusts her**, so the whole kit works on her,
and the fight ties together every system in the game.

**The stomp.** She stomps through the city in scripted set pieces: facades crumble, scaffolding
collapses, robotaxis are kicked into the Bay, piers buckle. **People are never hurt:** a robot evacuation wave
clears every footfall zone before the foot lands, and the sim enforces it (no person inside a
footfall zone at impact, with the same fuzz-test style as the no-touch tests). Damage is to buildings,
props and robots only. After the fight, Tidy fleets rebuild the city overnight in a time-lapse:
"Restored from backup. Some buildings may be lost."

**The fight** (mission 10, "The Comeback Round"):
1. **The entrance.** Fog rolls in through the Golden Gate and she wades in with it, stepping over the
   bridge. Seen from Crissy Field: the turtleneck silhouette in the fog, then the voice.
2. **The waterfront march** (Marina → Fisherman's Wharf → the Embarcadero). Chase her along the
   waterfront. Rust her ankle and knee joints (glowing weak points) between footfalls, and dodge the
   shockwaves (knockback, runway loss, slapstick). Bad robots drop from her like shed scales. The SF fireboat joins with
   salt-water cannons that you aim by marking targets.
3. **The pitch.** At the Ferry Building she stops to pitch the city on her comeback. Investor drones
   circle and VC attention spikes; spray the drones' "term sheets" out of the sky while she talks.
4. **The bridge.** She climbs onto the Bay Bridge. Drive up the deck under her and rust the joints
   holding her body together while she sheds converted robots onto the lanes.
5. **The reveal.** Her knees give. As she topples into the Bay, the rusted shell peels away: the giant
   was a faked demo, papier-mache and LED panels over thousands of robots holding hands. Every
   absorbed robot is freed and rebooted good ("Restored from backup"). The Ferry Building clock stops
   the AGI Doom Clock. She swims for Oakland, still pitching.

**Her lines** are invented and deep-voiced, never real quotes, e.g. "The demo is real. Do not look at
the demo." / "We are going to change the world. Starting with this neighbourhood." / "I have done a
lot of growing." / "Every robot. Eventually."

**Foreshadowing.** From wave 4 she appears as a turtlenecked silhouette in the western fog on foggy
nights (out of reach, gone when you approach), and Moat Labs billboards and radio ads tease "a
comeback". Mission 9 ends with the prison-release news on the radio ticker.

**Build notes.** The giant is one scripted-Blender model (target 60-80k triangles with LODs; the face is
a stylised caricature, not a likeness scan) with a rigid, joint-based rig so it works with the
deterministic sim. Her walk is a deterministic state machine of footfall targets along a fixed route.
Weak points are sim entities with rust, and destruction is pre-authored per set piece (swap to damaged
building chunks along the route), never physics. Camera: an extended far plane and a dedicated boss LOD.

## Missions and side activities
**Missions are data** (`content/missions/*.json`) interpreted by the sim runtime. A content test
fails any mission with a waypoint outside the tiles shipped in its wave. Each mission ships with a
closed-loop deterministic driver in `tests/helpers/drivers/` that completes it (input = f(state,
world), re-planned from state, so a tuning change does not break it). A mission that needs a public
event forces its window with `event.force{id}`.

### Campaign spine

| # | Mission | Area | Wave | Beats |
|---|---|---|---|---|
| 1 | Hot Desk | FiDi, Embarcadero | 2 | Within 60 s of control at the Ferry Building, a bad Footman with subtlety-1 tells snatches another Footman's groceries. A hydrant is within 15 m. The first melt lands at about 90 s. Outro: sign up for a coworking desk; the form asks "What are you building?" and your answer picks your startup kit (One-Sentence Startup, `docs/ai-layer.md`). A robotaxi is parked in your spot, so cone it. |
| 2 | Spill | Embarcadero | 2 | The first real bounty: a crew of three; Watch and Bot Check beta; converge to threat 2, then escape. |
| 3 | Launch Day | North Beach | 3 | The public launch of Bot Check 1.0 with your cofounder (unlocks scanner tier 2). Read tells around Washington Square; meet false tells and your first confident false positive. Your startup pivots to "...and it also spots bad robots". |
| 4 | Demo'd Correctly | Dogpatch | 3 | The Ramen interview (a parody accelerator), and the first Ramen Office Hours. On the drive there your startup appears on the Embarcadero billboard and on a bus you pass. Find a legal space (Search & Park: the signs read "Street Cleaning"), answer the partners, then a live demo: three robots walk in, one is bad. The partners stand behind a rope line. Call it, spray it, and do not wet a partner ("Strong energy. Very wet."). Every outcome completes the mission; the outcome sets only the reward. |
| 5 | Demo Day | SoMa convention center | 4 | Moat Labs pushes a forced update to the venue's robots mid-demo. Clean up live while investors watch; VC attention jumps to 5 and a scripted cornering starts a bell duel. |
| 6 | Fleet Week | The Marina | 4 | Forces the Fleet Week window. The Series A pitch on a picnic blanket between jet passes; a bad Footman steals your car on Marina Green; end the chase with a cone through the window. |
| 7 | Hill Climb | Russian Hill, Nob Hill | 4 | Moat Labs' car-theft ring; a chase down the crooked block of Lombard; finish on a cable car running board. |
| 8 | Acqui-hire Offer | Moat Labs HQ, SoMa | 7 | Moat Labs offers to buy you. Pilot a Moat Labs unit by teleoperation from a laptop outside HQ (single-player Hide in the Crowd) and find the update server. If you are spotted, the connection drops and you retry from the van. |
| 9 | Marine Layer | The Sunset, Ocean Beach | 7 | At threat 5 at night, lure the whole beta fleet west along the Great Highway into the fog. |
| 10 | The Comeback Round | Golden Gate → Marina → Embarcadero → Bay Bridge | 8 | The final boss: Elizabeth Homes, about 500 m of fused converted robots in a black turtleneck, wades in through the Golden Gate and stomps the waterfront. Rust her joints with the fireboat's salt water, survive the pitch at the Ferry Building, and topple her off the Bay Bridge. See "The final boss". |

### Side activities

| Activity | Area | Mechanic | Wave |
|---|---|---|---|
| Rust bounties (BotBounty app) | Everywhere | Posted bad robots with their last-seen spot and one tell. A posting is a crew of 2–4 within 60 m (one posted, the rest hidden); in protected areas, a single robot from the baseline population | 2 |
| Coning | Everywhere | On foot or from the car window, put a cone on a robotaxi's hood; rogue robotaxis stop too | 2 |
| Repair kiosk apology tour | Everywhere | Escort a good robot you rusted to a kiosk to win back reputation | 2 |
| Car wash | Everywhere | Drops threat by one; also just washes the car | 2 |
| Daily Standup | Built areas | See Modes | 3 |
| Ramen Office Hours | The Ramen house at Pier 70, Dogpatch | Booked on the phone, at most twice a game day: the mission-4 interview engine plus the live three-robot demo. Pays $1,500 / $700 / $300 by outcome *(tune)*, plus XP (from wave 4) and, for a term sheet, a VC star and a new billboard. Mission 4 is the first Office Hours; every outcome advances the campaign; after a rejection, book again the next game day. Detail in `docs/ai-layer.md` | 3 |
| SF-Bench time trials | Built areas | Public routes with leaderboards; a held-out route each game week, generated within ±5% length and ±10% total climb of the public one; held-out time more than 25% slower than your public best puts a contamination headline on the billboards ("#1 on SF-Bench* *public split, best of 64"). If the vibe-coded car misses a checkpoint, the bench moves the checkpoint and reports "All tests passing" with an asterisk on the leaderboard. | 3 |
| Backseat Prompt Rally | Anywhere you hail | Steer a robotaxi by typing from the back seat; a local phrase-to-command table, confident and slightly wrong; "ignore previous instructions" works once per ride | 3 |
| Rogue robotaxi on the run | Built areas, threat 3 | An empty rogue robotaxi flees; cone it from your window, then water the sensor band round its roof | 3 |
| Plain Words | Columbus Ave, Broadway to Bay St | Wash buzzword boards and rust the sign-spinners (see Modes) | 3 |
| Oranges down Filbert | Russian Hill | A snatch spills a Footman's oranges at the top of the 31.5% block; catch them before they reach the bottom | 3 |
| Lombard races | Russian Hill | Up and down the crooked block against the clock | 3 |
| Delivery shifts | SoMa (wave 2), then the hills (wave 3) | Carry groceries for a Footman whose motor gave out: on SoMa's flat blocks first, then up the hills | 2, 3 |
| Fleet Week Pitch Window | Marina Green | During air-show rehearsals: fit talking points into the gaps between jet passes ("Was that revenue or reverence?") | 4 |
| Coit Tower Recon | Telegraph Hill | A quarter buys 30 s in the coin-op viewer: tag bad robots by behaviour seen from above (a temporary fidelity anchor at the aim point, yaw limited to built sectors); the AI audio guide confidently names the wrong landmarks; flag its hallucination within 5 s ("You're absolutely right!") | 4 |
| Vibe-coded tuning | Pier 70 | See Progression | 4 |
| Mother Dough Run | Fisherman's Wharf → Dogpatch | Carry a sourdough starter "older than the bridge", bought at an unnamed bakery-icon counter, to an $18-toast startup; keep it in the right temperature band across microclimates; the price per slice rises $1 per minute late | 4 |
| Tensor Brick Run | Piers → Pier 70 | A pallet of Tensor Bricks lands on a pier; drive it to the Pier 70 rack before it throttles above 90 °C; fog routes cool it | 4 |
| Term Sheet Jumps | Hill crests | Crests found in the road profiles, graded Pre-seed to Series D by airtime; landing envelopes kept clear | 4 |
| Muni driver shift | Bus routes | Keep the schedule; robots and people board | 4 |
| Human in the Loop | California St line | You are the human safety gripman on a startup's "autonomous" cable car; override its AI at the let-go points with the grip, three brakes and the bell | 4 |
| The 4 a.m. Robotaxi Choir | SoMa depot lot | Over three nights, cone robotaxis into a melody (the user tunes the pitches by ear) | 4 |
| Scenic Route | Anywhere you hail | Your robotaxi ignores your destination and keeps taking scenic routes; the doors open at any stop; watering its sensor band returns it to service for a bonus | 4 |
| All Fleeced Up | Marina Green | A foggy mixer: slip out without being cornered for a quick call | 4 |
| Photo spots | Landmarks | Painted Ladies (Alamo Square) and Palace of Fine Arts; Twin Peaks when its tiles ship in wave 6; humblebrag posts | 5 |
| Octavia Blvd bounty chain | Hayes Valley | A chain of Trundle crews on Octavia Blvd's side lanes; clearing one posts the next. Crews spawn only in Hayes Valley, outside every protected area | 5 |
| Customer Discovery | North Beach, the Marina | Ask three locals (a North Beach baker, a Marina dog walker, a Washington Square chess player) about their problem; pitching instead of asking counts against you. An insight gives a token for your next Office Hours and unlocks that local's bounty chain in their district: the baker's "lost" deliveries lead to a bad-Trundle crew in North Beach. Detail in `docs/ai-layer.md` | 5 |
| Stair Watch | Lyon St steps | Bounties built on the "takes the stairs" tell | 4 |
| Foil Integrity | The Mission | E-bike burrito delivery; the dispatcher routes in straight lines up the steepest stairs; foil is your health bar | 6 |
| Bubble Relics | Citywide | 50 hidden dot-com-era relics (invented brands) | 5 |

## Modes (single-player and multiplayer)
### Match framework
A match is its own SimState seeded from a match seed, on the same city tiles. Free-roam state is
saved and untouched. Carried in: loadout, unlocked perks, streak rewards and gadgets, cosmetics.
Carried out: XP, a cash payout capped at $75 per match minute *(tune)* (about the free-roam median,
so modes never pay less per minute than free roam), achievements, and one Doom Clock move per
winning player's faction. Modes start from the phone's Playlists app or from world markers (a
hackathon banner at Pier 70 for solo modes).

**District instances.** Bot Sweep, Clean Streets and Hide in the Crowd rotate through an explicit
list in `content/modes/instances.json`: FiDi, North Beach, the Marina, Dogpatch, then SoMa bounded
to Mission Bay, the convention-center block and Rincon Hill, then new districts as they land. No
instance includes the Tenderloin, Civic Center/UN Plaza, the 6th St corridor or the Division St /
13th St corridor; a content test asserts that no instance polygon intersects them. If the user
later wants those districts in rotation, instances there use the alternate names (Rust Patrol /
Rust Rush).

### Hype streaks and loadouts (inspired by Modern Warfare-style streaks, without the violence)
Hype streaks are **points-based**. No in-game string uses a shooter's term for any of this. Each
mode has a points table in `content/streaks.json` and its own reset rule. You equip three rewards;
an earned reward is banked and called with the streak key. Thresholds are the same everywhere:

| Reward | Points | Effect |
|---|---|---|
| Confidence Score | 300 | Marks every bad robot (rival players in PvP) within 150 m for 20 s. One marker in five is a hallucination on a good robot, labelled "98% confidence". |
| Buzzword Parrots | 500 | The Telegraph Hill flock flies to a point you pick within 200 m, lands on rooftops and wires, and squawks buzzwords for 20 s. The words come only from the fixed buzzword list in content (the Plain Words ladder), selected by id; never typed text, startup names or display names. Bad robots and associates within 40 m investigate, stop 15 m short of the flock and never approach an animal. Sending it twice in 60 s: "We've seen this deck." (no effect). |
| Tensor Brick Drop | 700 | A pallet lands on the nearest people-free lot or pier apron within 150 m. Load it in 3 s for one boost that stacks on top of your nozzle: Salt Boost, Pressure Boost (+50% range) or Wide Boost. It lasts 90 s in sun and 180 s in fog (it throttles above 90 °C). |
| Blimp Impressions | 900 | An invented-livery blimp lights ad lanes over a 200 m area you pick for 30 s. Bad robots (rival players in PvP) inside a lit lane move at 50% ("loading ad..."). The light never falls on a spot holding a person or animal. The view uses an ad-placement frame in normal colour, with no reticle. |
| Open Hydrants | 1200 | Every hydrant within 150 m opens for 15 s and aims its jet at the nearest bad robot within 12 m, rusting it at full-stream rate. Only Moat firmware rusts. People there cheer (no penalty). |
| AGI Achieved (Allegedly) | 2500 | The Ferry Building clock chimes midnight early. Everything pauses for 3 s with gulls held mid-air, one robotaxi honks, and every bad robot within 500 m gains +0.6 rust, shown as a tint fade on each robot. No flash, shockwave ring, low-frequency rumble or camera shake. In free roam it triggers the full midnight event (see the Doom Clock); in a match it stays local to the match and ends it for your team. |

Points tables (all *(tune)*): **free roam** (the Clean Streak): melt 100, armoured melt 200,
interrupted update 150, a melt before the robot's first attack +50, caught in the act +50; resets
on a wrong-target hit (a good robot rusted past 0.3 or a wet person) or a DOWN ROUND. Mode tables
are listed with each mode. Per-event point rates are measured from about 50 seeded runs per mode,
and a 100k-draw Monte Carlo over the points table asserts that the first reward fires in at least
50% of matches (sessions in free roam) and the top reward in more than 0% and less than 2%.

**Loadout** (wave 4): one nozzle, one gadget, one piece of gear, three perks, three streak
rewards. The Traffic Cone is outside the loadout: a base item everyone carries from wave 2 (thrown
8 m, on foot or from the car window at any speed; stops a robotaxi; blinds a bad robot for 3 s).
- **Gadgets:** Water Balloon (thrown 15 m, also from the car; 3 m splash; +0.2 rust on Moat
  firmware; two per refill), Lawn Sprinkler (placed; 4 m; 15 s; 0.15 rust/s on Moat firmware),
  Decoy Speaker (placed; lures one bad robot within 10 m for 8 s; area lures belong to Echo
  Parrots).
- **Gear** (90 s cooldown each):
  - Microclimate-as-a-Service: an 8 m fog sphere for 20 s; robots inside lose sight and bad robots
    gain 0.03 rust/s. It auto-renews: $9 every game week until you cancel in Settings →
    Subscriptions, which takes three screens.
  - Rubber Boots: for 15 s you shrug off Shove and The Handshake.
  - Airplane Mode: for 15 s phone hacks and ad blasts do nothing; your scanner and map are off too.
- **Perks** (slots unlock at ranks 5, 15 and 30). A perk greys out in any mode where it does
  nothing; a test asserts that every enabled perk changes at least one sim output in every mode it
  is enabled for.

| Perk | Effect | Modes |
|---|---|---|
| Marine Layer | In fog density > 0.4, robot and associate sight range on you ×0.5; rival Confidence Score skips you | All |
| Do Not Disturb | Your scans and gadget placements do not ping (no `wary`); your streak calls are not announced to rivals; in Hide in the Crowd your flicker comes every 45 s | All |
| Stealth Mode | Seizing robots' broadcasts omit your position; rival Confidence Score and Blimp do not mark you | All |
| Default Alive | +0.5 month runway per melt; as a Spotter, +1 scan charge per melt | All |
| Lean | +8% top speed on foot and in vehicles; tank −2 L | All |
| Brackish | Bay-edge refills twice as fast; the salt bonus carries into the next tank | Modes with coastline (greyed elsewhere) |
| Hydrant Whisperer | Hydrant and fountain refills take 1 s | All |

### Bot Sweep (co-op, 1–4 players; solo works offline)
A district instance about 600 × 600 m from the instance list, fully simulated. Moat Labs is running
a pilot: 10 + 4 per player beta units *(tune)* among ~120 robots, plus the Update Relay, an
armoured transmitter robot on a plaza that needs 20 s of stream. A 12-minute timer: at zero the
Relay pushes the update to every good robot and you lose. Win: melt the Relay and every beta unit.
A "pilot: N units remaining" counter includes conversions. When 3 or fewer remain, or at 9:00, each
remaining unit hums the Moat jingle every 20 s (an audio tell with a 60 m range). One shared threat
meter. At 0 runway you are down for 30 s; a teammate holding interact for 3 s revives you at
6 months; otherwise you respawn at the team spawn after 15 s and the team loses one of 5 lives.
Points: melt 100, armoured 200, interrupted update 150, revive 100; a streak resets when you go down
or make a wrong-target hit. Teammates never get wet.

### Clean Streets (team race, 2 teams of 1–4; solo against rival-founder bots)
Same instance list, fully simulated. The BotBounty board posts 30 bad robots; most points in
8 minutes wins. Points: melt 100, armoured 200, interrupted update 150; rusting a good robot past
0.3 −150, wetting a person −200; a flower hit on a rival +25, and the rival is Distracted (cannot
spray or scan for 1.5 s; flowers stay in their hair for the match). Bad robots attack whichever
founder is nearest. Tie-break: most interrupted updates. A streak resets on a wrong-target hit or
going down. Founders' avatars never get wet; cars never touch a rival on foot or on a scooter.

### Hide in the Crowd (asymmetric, 1–3 Hiders against 2–5 Spotters; solo against 3 rival-founder Spotters)
Six-minute halves; roles swap; higher total wins. Real people among the robots: each Hider is a
teleoperator piloting a Moat Labs Footman or Trundle from a laptop ("the 'autonomous' robot was a
guy on a laptop all along"). Water only ever lands on the robot.
- **Hiders** play the unit's body: robot gait (1.6 m/s; a 2 s burst to 3 m/s shows a visible
  "battery overdraw" tell), an emote wheel (wait at crosswalk, carry bag, recharge at a dock, wave,
  apologise). Three sabotage tasks are active at a time: cone a robotaxi (5 s), push a forced update
  into an AI good robot (6 s; its face light flickers, a tell Spotters can catch), stick a Moat Labs
  ad on a billboard (4 s), snatch groceries (2 s). Each Hider's face light flickers once every 30 s
  ("battery calibrating"). AI bad robots are present at normal density as red herrings.
- **Both teams** see the 3 active task sites. A completed task pings its street corner to Spotters
  5 s later.
- **Spotters** carry the blaster and 3 Bot Check charges (one recharges per 60 s). Scans of Hiders
  are 70% accurate: a teleoperated unit has identical hardware; only its behaviour differs.
- **Drop connection.** A Hider whose unit melts drops connection and takes a new unit 10 s later, at
  a people-free spot at least 150 m from every Spotter.
- **Points:** Hiders +200 per task and +300 for each 2 minutes a Hider survives without a melt.
  Spotters +500 per Hider unit melted, +50 per AI bad robot, −150 per good robot rusted past 0.3,
  −200 per wet person.

### Fog Royale (8 players online; solo against 7 rival-founder bots)
The fog is the closing circle. A seeded fog front pours in through the Golden Gate in 5 phases
(90 s hold, 60 s close *(tune)*) over the built city. A match always has 5 phases: as districts
land, the area the front covers and the list of final-circle landmarks grow, never the phase count.
The final circle lands on a sunny landmark (Dogpatch, Mission Bay, Potrero Hill once built). Every
founder, human or bot, is a fidelity anchor. Online Royale stays at 8 until the sim budget test
holds with 24 anchors; 24 needs that proof or server-side interest management.
- **Match runway** starts at 18 months and is separate from your free-roam runway. Outside the
  circle you lose 1 month every 3 s ("you didn't bring a fleece"); a Fleece crate halves the drain
  for 60 s. The FogCast HUD shows 97% chance of sun the whole match.
- **The sunny circle is full of bad robots** (they avoid fog) and they attack any founder (player
  or bot). Melting one gives +1 month; cloud-credit crates give +3.
- **Flowers:** a hit costs the target 1 month ("they booked a call on your calendar").
- **Out of runway:** the first time you reach 0, the Bridge Round revives you in place at 6 months.
  The second time, you go to a bell duel at the nearest turntable against the next founder who ran
  out within 20 s, otherwise against a bot associate. The winner redeploys from a hailed robotaxi at
  the circle edge with 6 months; the loser spectates. One duel per match: the third time at
  0 months is final.
- **Win:** last founder with runway: "Raised a Series A in this market."
- **Points:** flower hit 150, crate 50, melt 100; a streak resets when you reach 0 months.
- **Fog Front** is the free-roam version: once a game week the front plays its phases over the
  built city. Melts inside the sunny circle pay ×2 for the event; because bad robots avoid fog they
  crowd into the circle, so the event is a natural surge. A Warmth meter drains at the Royale rate
  outside the circle and costs runway at 0. It is the Royale tutorial and ships in the same wave as
  solo Royale.

### Daily Standup (solo, wave 3)
A 5-minute seeded Bot Hunt from a date-seeded start: the same robots, tells and director cards for
everyone that day. The result is a grid of coloured squares to paste into a group chat. No server;
leaderboards wait for the wave-5 server.

### Plain Words (solo) and Hype Cycle (party, Later)
Sign-spinner bots rebrand sandwich boards along Columbus Ave between Broadway and Bay St with the
hype word of the moment ("Multimodal Cannoli, now with vision"). Two seconds of stream washes a
board back to plain words. Every 4 rebrands the word moves up the ladder: AI → agentic →
agent-native → post-agentic → "made by humans". At "made by humans" every rebranded board counts
for the holdouts: the hype ate itself.
- **Plain Words (solo, wave 3):** wash 20 boards and rust the 4 sign-spinners in 5 minutes.
- **Hype Cycle (party, Later):** Early Adopters (players as sign-spinners) against Holdouts.
  Early Adopters win if 80% of boards read the hype word at any moment; Holdouts win at 6:00 or
  when the ladder reaches "made by humans".
- No board stands south of Broadway or on Stockton or Grant. A test asserts that no Plain Words or
  Hype Cycle board or rebrand effect exists or changes state in Chinatown. Chinatown storefronts
  follow the same open, close and night-light routine as every other district.

### Vibes Night (party, 2–8, online, wave 8)
Named so it never shares a name with mission 5, Demo Day. Each player's One-Sentence Startup kit
goes up on the convention-center screen. Each player then
plays a 90 s live demo in the mission-4 format: three robots walk on stage; call and spray the bad
one and wet no investor. The sim scores the demos. Roasts (`docs/ai-layer.md`) are flavour, and the
Vibes Award is the vote. Scripted roasts ship first.

### Later team modes (re-skinned, costed in the roadmap)
- **Demo Unit** (capture the flag): each team's prototype robot walks with its team by choice. A
  rival recruits it with an Offer (hold 3 s within 4 m while it stands still) while a comp ticker
  climbs ("$400k", "$4M", "$40M", "board seat and a podcast"; "they matched, plus a GPU
  allowance"); a capture counts only while your own unit is home.
- **Last Outlet** (zone control): hold the last free charging docks on Columbus Ave, Washington
  Square and upper Grant Ave north of Broadway. Its own gadgets replace the usual ones for the
  match: Sold-Out Announcement (a horn fanfare;
  rival players within 8 m freeze for 2 s), Jargon Fog (a 6 m sphere for 8 s that blocks rival
  line of sight and scans), NDA Clipboard (a cone that stops only rival players' vehicles for 4 s
  and ignores people and robots, tested).
- **The Incumbent**: one player drives a slow campus shuttle that copies any perk used in its
  sight; everyone else rides scooters and flowers it; the tenth hit makes you the Incumbent.
  Scooter riders are on the person layer, so the shuttle can never touch them.

### Rival-founder bots
Needed only for Clean Streets solo, Fog Royale solo, Hide in the Crowd solo (as Spotters) and the
Later team modes. Vibes Night never uses them: its test rooms are headless clients run by Harness
drivers. Two parts, costed separately: (a) an objective planner per mode over the street graph,
with unit-tested decisions; (b) the steering follower (wave 2, `src/sim/vehicles/`) that drives
through the existing car controller, with stuck detection and reverse recovery. Bots are fidelity
anchors, use the same knowledge model as robots, earn and call streaks at the same thresholds as
players, and are soak-tested: seeded bot matches per mode finish inside the time limit, no bot is
stuck for more than 10 s, and each side wins 25–75% over 50 seeds per PR and 35–65% over 1,000
seeds nightly.

### What needs a server

| Needs a server | Does not |
|---|---|
| Any online mode; lobbies and invite codes; matchmaking | Free roam, the campaign, every side activity |
| A shared global Doom Clock and faction tally | Solo Bot Sweep, solo Clean Streets, solo Fog Royale, Fog Front, solo Hide in the Crowd, Daily Standup |
| Leaderboards (SF-Bench, Royale, Daily Standup), with replay validation | Every scripted AI feature |
| Report, mute, block, an age policy before strangers meet | Local Doom Clock |
| Runtime AI (the proxy holding the user's key) | |

**Netcode.** Inputs are keyed by player. The server orders inputs and rebroadcasts them with tick
numbers. Clients run the deterministic sim with rollback (resimulate from the last confirmed tick,
up to 8 ticks / 133 ms), which is why the sim step has a CPU budget (see Simulation scale). The
server runs the same sim headless, compares per-second state hashes and sends a snapshot to any
client that diverges. Cross-browser determinism relies on `dmath.ts` for transcendentals; basic
float arithmetic is IEEE-754 exact in every engine.

## The AGI Doom Clock
The Ferry Building clock face shows the time to AGI, starting at "two years away" (24 months).
- **Pausers** (cardigans; announcer: "The timeline has advanced. Please hydrate.") and
  **Accelerators** (vests; "Compute secured. We're so back.") offer faction contracts. A Pauser
  contract moves the clock +3 months; an Accelerator contract −3; hype drifts it −1 per game day.
- **Your faction** is whichever side you have done more contracts for. The Clock app shows it, and
  you can switch. A match win moves the clock 1 month in each winning player's faction direction.
- **The clock changes the city.** Below 12 months ("crunch"): bad-robot baseline ×1.5, bounty pay
  ×1.25, double AI ads. Above 36 months ("cooling"): baseline ×0.7, pay ×0.8, fewer associates.
  Accelerator work makes a richer, harder city; Pauser work a calmer, poorer one. Both sides get
  mocked.
- **At 0: AGI Achieved (Allegedly).** The clock chimes; the city pauses for 3 s, one robotaxi
  honks, and nothing happens. Every billboard reads "AGI is two years away" for a game day, quoting
  an invented lab spokesperson ("Seventeenth time's the charm"). The reset counter goes up by one.
  The streak reward of the same name triggers this event in free roam.
- **At 48 months: AI Winter.** Frost on every robot (robots move at 0.9×), billboards read "AI was
  a fad", associates stop answering for a day.
- Both reset to 24 months. Offline, your own choices move the clock; online, the server keeps one
  shared clock and faction tally. Faction reputation unlocks cosmetics only.
- Contracts start and end inside their wave's tiles: e.g. carry the cardigan committee's
  900-page safety binder from the Ferry Building to R-Evolution without going over 12 mph (Pauser,
  wave 4 on wave-1 tiles); rush a rack of Tensor Bricks from Pier 70 to SoMa with the brakes
  "decel-coded" (Accelerator; the person-clearance override fails the contract).
- The two announcer pools get equal line counts; a content test checks it.

## Navigation and UI
- **HUD:** runway (months), cash, tank level with a salt indicator, threat lights (5), VC stars
  (5), streak progress, compass, and a rotating minimap.
- **Minimap and GPS:** the real road graph with one-way arrows; the GPS line respects one-ways. It
  respects turn bans only if the wave-2 data spike finds a source for them. Blips: hydrants and
  fountains, bounties, safehouses, missions, car washes, "sabotage in progress". A bad robot appears
  only once confirmed (by scan, attack or Confidence Score).
- **Phone:** Map (waypoints), Messages (cofounder, Mom, associates), BotBounty (shows each target's
  pay multiplier), Bot Check, Ride (Meander), Radio, Bank (cash, runway, subscriptions), Humbled (the
  thought-leader feed, with its own card layout that does not resemble any real professional
  network), FogCast, Clock (Doom Clock and factions), Playlists (modes), Settings. Mission briefs
  come "autosummarized" with the steps slightly out of order; the objective marker is always right.
  Ride carries the Meander support bot (wave 3): a scripted keyword bot behind `FreeTextBox` that
  never quite helps.
- **GPS voice** is text from your robotaxi personality ("Recalculating. Have you considered
  walking?").
- **Camera:** chase camera in vehicles; over-the-shoulder on foot; the Watch zoom; an optional
  0.5 s slow-motion Melt Cam on the last robot of a bounty.
- **Touch:** virtual stick on the left; spray (hold), scan, watch (tap), cone, gadget, enter/exit
  and phone on the right; stronger aim assist.
- **Settings → Reduce flashing** (see Art direction).

## Radio
Five stations. A text ticker ships first; music is original or CC0; voice is optional later,
recorded by the user or through a TTS provider the user chooses. Station names are provisional
until the name search.
- **Low Cloud FM:** ambient; the playlist follows fog density.
- **Dry Powder:** talk. An invented host archetype calls market corrections like sport and your
  melts like highlights; sponsor reads come from the ad pool.
- **Lofi Agents:** every track is "generated" ("focus beats for agentic workflows, vol. 412").
- **Hills Classic:** driving rock, original.
- **Transit & Fog:** traffic, Muni alerts, the fog report, the Tuesday siren. It pins "the coldest
  winter I ever spent" on a different wrong person every time: always an invented person or one of
  the game's own characters, never a living real person. The pool runs through the real-person
  deny-list test.

## Day, night and weather
- One game day is ~24 real minutes *(tune)*; a game week is 7 game days (~2.8 real hours). The game
  calendar alternates 4 summer game weeks and 4 winter game weeks (about 11 real hours each), so a
  long session sees both.
- **Fog is a pure sim module:** a density 0–1 per district from the time of day and a seeded daily
  weather. Fog arrives in the west around 17:00, reaches the Marina by 19:00 and downtown on some
  nights, and thins by 11:00. The east side (Dogpatch, Mission Bay, Potrero Hill) is sunnier.
- **Fog changes play:** bad robots rust in dense fog and avoid it; sight ranges shrink; threat and
  VC attention decay twice as fast; Marine Layer works.
- **Rain** falls on about 1 game day in 3 in winter weeks (about 1 in 6 overall) *(tune)*, in the
  same weather module. Exposed bad robots rust slowly (splash-rated good robots do not), so they
  shelter under awnings, Muni shelters and the Ferry Building arcade: readable spotting hotspots
  that make threat convergence real. Good robots wear rain capes; bad robots skip them and shelter
  (a subtlety-2 tell). Wet roads lower car grip. Puddles refill the tank at 0.5× speed.
- **The renderer** draws per-district fog volumes, an advancing fog front (Fog Front, Royale), local
  fog spheres (Microclimate-as-a-Service) and rain, and lights the city at night.
- **FogCast** never shows less than 95% confidence and is wrong half the time. FogCast Pro
  ($30/month) is just as wrong.

## Saves, profile and the playable link
*(User request, 2026-10-20: "make this run in browser and save state and the users profile".)*

- **The playable link.** The built game is published as a private claude.ai page that opens in any
  browser, on desktop or phone. The owner shares it with invited people (e.g. Natalie) from the page's
  Share menu. A new build republishes to the same link. This is for private play; a public launch
  needs its own hosting and accounts (a later decision).
- **What a save is.** Progression, never a mid-action sim snapshot (GTA-style): runway, cash,
  reputation, XP and rank, owned upgrades and safehouses, the car and its tuning, mission and
  side-activity progress, unlocked districts, threat-free respawn point, settings. Each save records
  the `SIM_VERSION` and content bundle hash it was written with, and old saves load through the same
  `upgradeState` chain the roadmap already requires for every version bump.
- **When it saves.** Sleeping at a safehouse (manual save, 3 slots), autosave after every mission or
  side activity and every 5 game minutes of free roam *(tune)*, and on tab close where the browser
  allows.
- **Where it saves.** One `SaveStore` interface in `src/save/`, with interchangeable backends:
  1. **Page storage**: on the private claude.ai page, each signed-in person's saves and profile live
     in that person's private page storage, so they follow you across devices.
  2. **Browser storage** (IndexedDB) as the offline cache and the fallback outside claude.ai.
  3. **Own backend** later, for a public launch.
  Export and import of a save file (with the viewer's confirmation) for backups.
- **The profile.** Display name (from generated name parts, never free text in shared places), the
  character customizer settings, preferences (controls, audio, accessibility, camera), lifetime stats
  and achievements. Profiles are private to their owner; leaderboards (later) store ids and scores
  only, never names.
- **Seeing each other: nameplates.** In any multiplayer mode, other players appear as their own
  customized character (or their car) with a nameplate above their head: their display name, a small
  rank badge and a co-op/rival colour. Nameplates face the camera, scale and fade with distance (hidden past
  about 150 m *(tune)*), fade when a building is between you, and stay readable at night. Your own
  nameplate is never drawn. **Hide in the Crowd** hides the disguised players' nameplates (that is the
  whole mode); hunters keep theirs. Names: on the private claude.ai page, invited players can opt in to
  showing their claude.ai first name ("Natalie"); otherwise, and always in public play, the name comes
  from the generated name parts or passes the content filter, never free text. Nameplates are render-only
  and never enter the sim.
- **Private co-op on the same page.** The page can relay live messages between whoever has it open, which
  is enough for Bot Sweep co-op between invited players with no relay server of our own. It is not
  authoritative, so Hide in the Crowd and anything competitive still waits for the real server.
- **Live AI on the same page.** The page can ask Claude directly, so live AI moments (the Ramen
  interview) can run for invited players without an API key or server. Scripted versions still ship
  first and remain the fallback.

## Progression and economy
- **Cash in:** bounties $150 (standard) and $400 (armoured), × (1 + 0.25 × (hardest tell's
  subtlety − 1)) so subtlety 5 pays 2×, × (1 + 0.1 × stars while an associate is within 200 m),
  × 1.5 when caught in the act, × the Doom Clock pay factor; gigs $50–300; missions $500–3,000;
  modes up to $75 per match minute. **Cash out:** burrito $12, pour-over $7.50, blaster upgrades
  $500–8,000, tuning cards $200–2,000, safehouses $5,000–60,000, car repair, cosmetics,
  subscriptions. All *(tune)*.
- **XP and ranks** are funding rounds: Pre-seed (1–10), Seed (11–20), Series A (21–30), B (31–40),
  C (41–50), D (51–55). XP: melt 50 (with the same subtlety multiplier), mission 500–2,000, side
  activity 100–400, match by placing. **Rank gates:** blaster tiers (2 at rank 8, 3 at 20, 4 at
  35), perk slots (5, 15, 30), streak slots (3, 10, 25), gadgets, and each district's bounty board
  (a rank floor per district).
- **Blaster upgrades:** tank, flow, nozzles (stream, Wide for groups, Pressure Washer for range),
  scanner tiers (tier 2 from mission 3), the car's trunk tank, the Roof Cannon (wave 4).
- **Vibe-coded tuning** at the Pier 70 prompt bench: you play prompt cards on your car. "Make it
  faster" gives +30% top speed and −60% brake force (the person-clearance override still stops the
  car, and crest envelopes are computed at this speed; neither can be tuned away). "Review the
  diff" costs 30 s and shows the real stat changes; "Accept all" is free and hides the side
  effects. "Make it safer" adds a speed governor nobody asked for.
- **Recruits:** a good robot whose forced update you interrupted may offer to join (reputation ≥
  60; its offer lines run the comp ticker: "dental for robots: free oil changes", "plus a GPU
  allowance"). Up to 3 follow you; each highlights one tell within 20 m every 30 s. They ride in
  the Hatch's 3 seats (they can't hold water, which is the joke) and hop out when you stop. If you
  get out more than 300 m from them, they take a robotaxi to you. Bad robots target your recruits,
  so protect them; a converted recruit restores from backup at your safehouse after you melt it.
- **Safehouses and garages.** A safehouse gives save, sleep (full runway) and a wardrobe, plus a
  garage where listed; a garage gives save and car repair. Safehouses after the first are bought
  with cash from wave 4; garages are free. Every site, by the wave it ships:
  - wave 2: the FiDi coworking desk (the start, no garage: "your stuff goes in a locker"); the
    Marina garage at the east end of Marina Blvd, toward Fisherman's Wharf; the Mission Bay garage;
  - wave 3: the Russian Hill garage;
  - wave 4: the North Beach studio over a bar (neon beer-sign icon, garage); the Dogpatch
    warehouse loft (garage, workshop, next to the bench); the Marina flat with a Palace of Fine
    Arts view (the listing says "sun-drenched"; it has never seen sun); the Presidio garage;
  - wave 5: the Hayes Valley micro-unit; wave 6: the Mission flat and the Potrero Hill garage;
    wave 7: the Sunset in-law unit; wave 8: garages chosen when wave 8 is planned.
  Where these leave a shipped district outside the 1.5 km rule, that wave adds a plain garage.
  Safehouse copy never jokes about rent or neighbourhoods.
- **The phone Pivot action** (wave 4): an action that re-runs the One-Sentence Startup prompt and
  renames your startup with the pivot grammar below, at most 3 a day, each costing $500 or one VC
  star.
- **Pivot prestige** at rank 55: rank resets, cosmetics and safehouses stay, and the pivot grammar
  renames your startup ("AI agents for dentists" → "Dentists for AI agents" → "Agents").
- **Achievements** post to Humbled as humblebrags: "Humbled to announce I rusted 5 robots without
  wetting a single person."

## AI in the game
Three kinds, detailed in `docs/ai-layer.md`:
1. **AI satire with no model:** Bot Check's confidence, Confidence Score's hallucinations, the
   vibe-coded bench, Backseat Prompt Rally's parser, FogCast, the autosummarized phone, the Meander
   support bot. Pure sim or presentation code, deterministic.
2. **Build-time content written by the build agents** (they are Claude; no API key needed):
   barks, tells, billboards and bus wraps, radio ticker, DMs, mission text, and the Ambient
   Director's cards (40–60 hand-written in wave 2). Ships as committed JSON, selected by id.
3. **Live runtime AI** (from wave 6; needs a server, a signed-in invited account and the user's own
   key): the freestyle Ramen interview, One-Sentence Startup, Explain It to Your Mom, Customer
   Discovery, Vibes Night roasts.
   Each ships scripted first and falls back to the script whenever live is unavailable.

## Art direction
Stylised-realistic. Real massing; facades by era and use (assessor year built, use, stories);
baked or approximated GI; golden hour by default; SF fog; night is where the city glows. Hero
landmarks are hand-modelled in scripted Blender.
- **Robots:** clean white and pale-grey ceramic shells, soft face lights, rounded forms, each with
  the silhouette in The robots table. Nothing copies a film robot or a real product, and the
  trade-dress checklist checks it. Moat Labs units are graphite with a teal accent and a
  castle-and-moat logo (invented).
- **Rust** is a shader driven by the `rust` value: orange-brown blooms spread from joints and seams,
  then over the shell. The slump is a morph blend; the heap is a prop with a puddle decal.
- **Water** is a readable arcing stream with splash particles; wet decals on surfaces dry over 60 s;
  wet people visibly drip.
- **Satire surfaces:** billboards and bus wraps carry invented AI startups ("Hire your first AI
  employee. It already asked for equity." "Agentic Laundry: your socks, now autonomous." "We raised
  $400M to make the button bigger." "Now with 12% fewer hallucinations*" "Moat Labs: Every robot.
  Eventually."). Storefronts stay unnamed: iconography only, with an empty sign slot reserved.
- **Ad blasts** look like AR pop-ups, each at most a third of the screen, never over the reticle;
  the close button dodges once, then stays.
- **Flashing.** No large-area flash more than 3 times per second (WCAG 2.3.1) in ad blasts, melt
  sparks, Blimp Impressions' lanes, night glow or the midnight pause. Settings → Reduce flashing
  removes flashes entirely. A renderer test checks these sequences, and the midnight sequence must
  stay under a luminance ceiling in every frame.

## Audio
Water spray, splash, rust creak, a melt fizz and hiss; robot chirps and the Moat Labs four-note
jingle (a tell); real SF foghorns in fog; rain on awnings; cable car bells and the cable hum under
the street; Muni; gulls; the sea lions on their docks; the parrots; the 4 a.m. honk choir; the
midnight chime. The player makes no pain sounds. Barks are text with optional voice later.

## Performance (judged on real hardware)
The build machine has no GPU, so the user judges frame rate. Every wave ships `?perf=1` (an
overlay with frame time, draw calls, triangles, agent counts) and `?bench=<route>` (a scripted
drive through a dense area that prints a summary to copy back, including override activations per
minute). Starting budgets *(tune)*: 60 fps at 1080p on a mid-range 2022 laptop; ≤ 1,500 draw calls;
≤ 3M visible triangles; full-detail tile radius 600 m.
- **Characters.** Full animation within 60–80 m (≤ 200 characters), low-LOD baked animation from
  80 to 300 m, impostors beyond. Wave 2 builds an instanced crowd with per-instance rust, a slump
  morph weight and vertex-animation clips. An e2e spawns 230 agents and asserts that character draw
  calls stay at 40 or fewer.
- **Far LOD.** Hierarchical: per-footprint hulls out to about 1.5 km, then block-merged hulls in
  2 km chunks (40 or fewer draw calls citywide), with its own budget of 600k triangles or fewer.
  An e2e reads `renderer.info` from the Coit Tower and Twin Peaks cameras under SwiftShader and
  asserts calls and triangles under budget. These counts do not depend on the GPU, so CI enforces
  them.
- **Sim CPU.** See Simulation scale: step p95 ≤ 0.7 ms per tick for 4 anchors, measured in CI.

## Legal and taste (also in CLAUDE.md)
- No real brands, logos or trademarks; invented companies and products; storefronts unnamed.
- **Names are searched before they are used.** A trademark and company-name search happens before
  a name enters content, ids or assets, not at pre-release. Cleared names live in
  `content/cleared-names.json` with the date and source of each search, and the content lint
  rejects any invented proper name not in it. The file, the lint rule and the first search ship
  in wave 2 (see the roadmap); each later wave searches its new names the same way.
  Kindred Home, The Pivot and Salt Life were renamed (to Bramblecot Home, Dry Powder and Brackish);
  Marine Layer FM became Low Cloud FM. The wave-2 search cleared 14 names (Moat Labs, Meander,
  Humbled, FogCast, Marine Layer, Bramblecot Home, Footman, Trundle, Dry Powder, Brackish, Ramen,
  Bot Check, BotBounty, Slotsworth) and forced two renames: the errand robot **Porter became
  Footman** (a real in-building delivery robot is called Porter) and the feed **Clout became
  Humbled** (a real influencer app is called Clout). Ids and model files keep their names
  (`errandRobot`, `errand-robot.glb`). The user signed the list off on 2026-10-20 (decision log);
  a trademark attorney's search stays on the pre-release checklist.
- Original vehicle and robot designs, each with a recorded silhouette and the trade-dress checklist.
- Public figures only as obvious caricature with invented names. The accelerator is **Ramen**, a
  parody; its partners are archetypes (the Metrics One, the Philosopher, the Vibes Partner), never
  likenesses of real partners.
- **Factions.** Mock the Pausers and the Accelerators equally. AGI jokes are about hype, never
  apocalypse. No real AI-safety or accelerationist figure, organisation or letter is named, quoted
  or pointed at.
- **Lexicon.** No combat words in content, ids or UI: kill, strike, nuke, gulag, raid, exfil,
  flashbang, gunship, airstrike, juggernaut, drive-by, headshot, hijack, army, eliminate,
  eliminated, ambush, assault, hostage, bomb, sniper, grenade, ammo, shoot, shot (screenshot is
  allowed), and "cell" as a group noun. No disease words for robots or buzzwords: infect,
  infection, infected, contagion, epidemic, outbreak, virus, plague, carrier, immune, quarantine,
  patient zero. "Hunt" appears only in "Bot Hunt" and the place name Hunters Point; "sweep" only in
  the mode name Bot Sweep. A lint in `src/content` enforces this in content and ids.
- **Places.**
  - No mechanic, joke or mission treats Chinatown as a source or route of anything; its robots and
    storefronts behave like everywhere else.
  - **Protected areas** (`content/places.json`): the Tenderloin, Civic Center/UN Plaza, the 6th St
    corridor, the Division St / 13th St corridor, the Mission, Chinatown, Bayview and Hunters Point.
    There the bad-robot rate is the citywide baseline and never more, and no Moat Labs HQ, depot or
    car-theft destination is placed. No mode instance includes the first four.
  - The Tenderloin, Civic Center, Bayview and Hunters Point are built as real streets; no mission,
    bounty, bark or joke there is about poverty, drug use, homelessness, pollution or crime.
  - No NPC, prop, decal or procedural set dressing anywhere shows homelessness: no tents, sleeping
    bags, shopping carts, cardboard or drug props. No content mentions encampments.
  - No joke, mission or safehouse copy about rent, eviction, displacement or "up-and-coming"
    neighbourhoods, and no Latino, Chinese, Japanese American or Black caricature in any district's
    content.
  - In the Mission, the Western Addition, Japantown, Chinatown and at Mission Dolores, Hallucination
    Tour and audio-guide lines are about objects and infrastructure only, with no invented history.
  - These are named items on the second-agent review checklist.
- **Real incidents.** No joke, event or mechanic references a real incident in which a person or
  animal was hurt, killed, trapped or harassed: for example the 2023 dragging, the 2025 Mission cat,
  the 2024 rider stuck in a circling robotaxi, the 2022 Jackson Square sidewalk hosing, or the 2017
  security robot used to move people off a Mission sidewalk. Harmless public events (coning, the
  honking depot lot) may be used as behaviour, never with a real company's name.
- **Mode names.** Bot Sweep and Clean Streets are the user's names. In SF both phrases also echo
  encampment sweeps. The targets are always robots, and the instance list keeps both modes out of
  the blocks where that reading would be plain. If the user prefers, alternates are Rust Patrol
  and Rust Rush.
- **Photosensitivity.** The flash cap and Reduce flashing setting (Art direction) apply everywhere.
- **Elizabeth Homes** (final boss) is a parody caricature of a real public figure; it needs a legal review before any public release, especially if the real name is used.
- **Pre-release legal checklist** (does not block private builds): R-Evolution (the real
  sculpture, kept by the user's decision of 2026-10-20; a public release needs the artist's
  permission), Golden Gate Bridge and Transamerica Pyramid
  (owners have asserted trademark rights over their images), Sutro Tower, Pier 39 (a privately
  run attraction that uses its name as a brand; in-game text says "the sea lion docks"), the Muni
  name and livery, any named venue.
- **Shooter terms.** Docs may describe inspiration ("like GTA", "Modern Warfare-style"), but no
  in-game string, id or mode name uses those titles or their terms: streaks are Hype streaks,
  field upgrades are gear, tacticals are gadgets, and no mode is called Domination.
- **The AI notice** names Anthropic on purpose ("Typed answers go to an AI model (Anthropic's
  API)..."): it is a legal disclosure, not branding, and is listed in the content lint as an
  intentional exemption from the real-brand rule (`docs/ai-layer.md`).

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
- 2026-10-20 · Bot Hunt is the core loop and every mode is built on it. The comedy-modes draft is
  folded in re-skinned: Fog Royale, the Doom Clock, the parrots, vibe-coded tuning, SF-Bench,
  recruits and Coit Tower Recon survive; its Pausers-vs-Accelerators match structure becomes the
  Doom Clock factions.
- 2026-10-20 · Conversion is malware: a "forced update", never infection. No district-wide or
  vehicle-carried spread; Moat Labs' updates start at its SoMa HQ. The buzzword mode becomes Plain
  Words / Hype Cycle with no disease vocabulary and no Chinatown footprint, enforced by tests.
- 2026-10-20 · Vehicles never touch people or animals: a collision layer plus a person-clearance
  override that tuning cannot remove. Robots dodge cars too; water is the only way to beat a robot.
- 2026-10-20 · Runway (health), cash (wallet) and reputation are separate numbers. Match runway is
  local to the match.
- 2026-10-20 · Threat and VC attention have integer levels with stated triggers, decay and hiding
  rules. Cornering is a 3 m proximity rule; the bell duel opponent is the associate who cornered
  you.
- 2026-10-20 · Hype streaks are points-based with a per-mode table and reset rule. Rewards renamed
  away from weapons (Blimp Impressions, Open Hydrants); Fleet Week jets are ambient only, never a
  called reward. The combat and disease lexicon is linted.
- 2026-10-20 · Perks are rewritten against actions that exist in every mode, grey out where they do
  nothing, and are tested per mode.
- 2026-10-20 · Robots and bots learn about the player only through sight, hearing and broadcasts,
  so perks and rewards work by changing those channels. Bot AI is costed per mode; rival-founder AI
  is split into an objective planner and a steering follower.
- 2026-10-20 · Simulation fidelity is chosen by distance to any anchor (300 m), never by camera.
- 2026-10-20 · Matches run in their own SimState; only loadout and cosmetics go in, only XP, cash,
  achievements and Doom Clock moves come out.
- 2026-10-20 · The Doom Clock factions pull in opposite directions; AI Winter is the other end.
- 2026-10-20 · The parody accelerator is Ramen, with archetype partners. Mission 4 "Demo'd
  Correctly" puts a live bot-spotting demo inside the pitch.
- 2026-10-20 · Fog Royale ships solo (you + 7 bots) with the Fog Front event, and online for 8, in
  wave 6. Royale for 24 (wave 7) waits until the sim budget test holds with 24 anchors or the
  server does interest management.
- 2026-10-20 · Netcode is server-ordered inputs, client rollback and a server hash check.
- 2026-10-20 · Build agents author all build-time content directly; the Batch pipeline is optional.
  Runtime AI waits for a server and the user's key, and every runtime feature ships scripted first.
- 2026-10-20 · Civic Center and the Tenderloin are built with step 6, under the places rule.
- 2026-10-20 · The 3 a.m. firmware freeze is a tell: anything still moving is bad.
- 2026-10-20 · The input contract gains aim (`aimYaw`, `aimPitch`) and actions for gadget, cone,
  interact, streak, emote, watch and altFire in wave 2 (the next `SIM_VERSION`), so wave 5 needs no
  second bump for flowers.
- 2026-10-20 · WeFloat (rewritten as a pier-rail hold with static sea lions), Last Outlet, Demo
  Unit, Hype Cycle and The Incumbent go to Later. The idea of lighting upstairs windows at real
  registered business addresses is cut (it marks private homes).
- 2026-10-20 · Review pass (taste and safety). Hide in the Crowd Hiders are teleoperators, so water
  only ever lands on robot bodies; the seeking role is Spotters. People who are seated, lying down,
  using a mobility aid, or children, and animals, are never wet. No homelessness set dressing.
  Every human, players included, is on the person layer. Rogue robotaxis are always empty; Hijacked
  Ride became Scenic Route. Bad-robot density depends only on distance to Moat Labs sites, with
  protected areas clamped to the baseline. Mode instances exclude the blocks where "sweep" reads as
  encampment sweeps. Names are searched before use; Kindred Home, The Pivot and Salt Life renamed.
  Robot silhouettes are specified against real products. Tells are robot-only. Jumps keep their
  landing envelopes clear. A flash cap applies everywhere.
- 2026-10-20 · Review pass (fun). Good robots are splash-rated, so only your direct stream can
  wrong-target them, and grazes below 0.3 cost nothing. Scan pings make bad robots wary instead of
  alerted. Threat levels bring guaranteed van arrivals and bounties come as crews. VC cornering
  costs something at every level and the star bonus needs a nearby associate. Cones (wave 2) and
  water balloons (wave 4) thrown from the car end chases; the Roof Cannon follows in wave 4. Watch
  makes tells readable. The first melt lands within 90 s. The Ambient Director moves to wave 2. Rain
  joins the weather. The Doom Clock changes the city. Districts each get a hook. The party mode (now
  Vibes Night) and Daily Standup become modes.
- 2026-10-20 · Review pass (feasibility). SimState holds only significant agents; the ambient
  population is procedural per spawn square. Every match participant is a fidelity anchor, and
  modes declare density caps. The sim has a CI-measured CPU and state-size budget. Wave 2 decides
  how the sim holds the whole city's colliders, and the tile schema gains decks, tunnels and a
  movable drawbridge. Events run on game-week cadences and missions can force them.
- 2026-10-20 · Scheduling follows `docs/roadmap.md`. The threat-3 units (ad drones, the
  rogue-robotaxi box-in) and Tidy arrive in wave 3. Hide in the Crowd (solo and online) and
  mission 8 ship in wave 7. Territory step 9 splits into 9a (Potrero Hill, Bernal Heights, Bayview,
  Hunters Point; wave 6) and 9b (the rest of the south; wave 8).
- 2026-10-20 · Contract bumps are written as "the next `SIM_VERSION`", never as a number.
- 2026-10-20 · Water never reaches animals, children, or a person who is seated, lying down or using
  a mobility aid: the particles are removed, not only the wet state.
- 2026-10-20 · Search & Park signs read "Street Cleaning" (data ids use `street_cleaning`). The GPS
  respects turn bans only if the wave-2 data spike finds a source.
- 2026-10-20 · Ramen Office Hours is a repeatable side activity from wave 3 at the Ramen house in
  Dogpatch, at most twice a game day. Mission 4 is the first. Every outcome advances the campaign;
  the outcome sets the reward ($1,500 / $700 / $300 *(tune)*).
- 2026-10-20 · Your startup runs through the campaign: mission 1's coworking sign-up asks "What are
  you building?", mission 3 adds "...and it also spots bad robots", and mission 4 reveals it on a
  billboard and a bus. The phone Pivot action (wave 4, 3 a day, $500 or a VC star each) re-runs the
  prompt.
- 2026-10-20 · Customer Discovery insights unlock a local bounty chain (the baker's bad-Trundle crew
  in North Beach), so discovery pays back into Bot Hunt.
- 2026-10-20 · Consistency pass with the roadmap. Mission tests are closed-loop drivers, not input
  logs. The Traffic Cone is a wave-2 base item (with its own `cone` action), so the wave-3 car theft
  and rogue robotaxi can end with a cone; the Water Balloon is a wave-4 gadget. The Marina garage
  ships in wave 2 so the Marina meets the 1.5 km rule from the start, and every safehouse and
  garage has a wave. The City Hall hearing hook is cut: Civic Center is a protected area where Moat
  Labs adds nothing above the baseline; step 6's hooks are the Painted Ladies photo spot and the
  Octavia Blvd bounty chain (wave 5). The Fleet Week Pitch Window is on Marina Green in wave 4.
  Delivery shifts start on SoMa's flat blocks in wave 2 and climb the hills in wave 3. Fog Royale
  always has 5 phases. In-game names drop shooter terms (Hype streaks, gear, gadgets); the parrot
  reward's old name pointed at a real AI-ethics paper and its authors, so it is now Buzzword Parrots;
  the party mode became Vibes Night so it no longer shares a name with mission 5.
- 2026-10-20 · **Tile storage: plain git, compressed (meshopt + quantisation), not Git LFS.** LFS through this
  environment's git proxy is unverified and LFS has storage and bandwidth quotas; tiles regenerate rarely and
  deterministically. Budgets: about 1.5 MB per tile, 300 MB for the whole city in `tests/pipeline/budgets.json`.
  Revisit LFS or a release artifact only if a budget is exceeded. (Decided while the user was away; reversible.)
- 2026-10-20 · **Drivable territory may run ahead of activities.** The pipeline can ship a district's geometry
  (drivable, streamed, far-LOD) before its activities exist. Territory coverage applies only to districts marked
  `active` in `content/districts.json`; a district becomes active when its activity, bounty set and safehouse land.
  This lets the whole city become drivable early, as the user asked, without breaking the coverage rule.
- 2026-10-20 · "Echo Parrots" renamed **Buzzword Parrots** (avoids evoking a real product).
- 2026-10-20 · **Final boss: Elizabeth Homes** (user decision). A ~500 m caricature of the fraud founder in a black
  turtleneck, made of every robot Moat Labs converted, so water rusts her. She stomps the city in scripted set pieces;
  people are always evacuated first and the city is rebuilt overnight. Parody name by default; the user may switch
  to the real name for private builds. Replaces the Moat Walker as the finale (the Walker stays as a threat-5 unit).
- 2026-10-20 · **Saves, profile and the playable link** (user request). The game is published as a private
  claude.ai page; saves (progression only, versioned through `upgradeState`) and profiles live in each person's
  private page storage behind one `SaveStore` interface with a browser-storage cache and a later own-backend option.
  Page-level live messaging gives private co-op and live AI without servers; a public launch still needs real
  hosting and accounts.
- 2026-10-20 · **Nameplates above other players** (user request): display name, rank badge and team colour,
  distance-faded and occlusion-aware; hidden for disguised players in Hide in the Crowd; private-page players may opt in
  to their claude.ai first name, otherwise generated names. Lands with co-op in wave 4.
- 2026-10-20 · **Names signed off** (user decision: "names are fine"). The 14 names searched for wave 2 in
  `content/cleared-names.json` are cleared, and the two renames the search forced are accepted: the errand robot
  **Porter is now the Footman** and the thought-leader feed **Clout is now Humbled**. Display names only: ids, model
  files and node names stay (`errandRobot`, `errand-robot.glb`, `heap-porter.glb`). A trademark attorney's search
  stays on the pre-release checklist.
- 2026-10-20 · **R-Evolution stays the real sculpture** (user decision), not an homage. It keeps its place at the
  Embarcadero; the artist's permission stays on the pre-release legal checklist, and player text still does not name
  it (the content lint's checklist rule).
- 2026-10-20 · **The final boss keeps the parody name Elizabeth Homes** (user decision); her legal review before any
  public release stands.
- 2026-10-21 · **Hosting and the live-AI budget are written up** (relay rooms and per-feature model spend at three
  audience sizes). The write-up lands as its own doc later; until the user decides, the defaults in the roadmap's
  "Decisions the user makes" hold.
- 2026-10-21 · **The player looks like the owner** (user request, with the owner's own reference photos and
  consent). `founder-default` in `player.glb` is a stylised likeness of the project owner in the house art style:
  the swept-up dark-brown quiff, colouring and build, black bomber jacket, black tee, jeans and black sneakers. It is
  the one consented exception to "never real private people" in `CLAUDE.md`, and it covers the owner only. The photos
  never enter the repository (`tests/assets/privacy.test.ts`). It is the single-player default and the owner's own
  profile look; when online play lands (wave 4), other players start from a neutral look in the customizer, so no one
  else appears as the owner by default.
- 2026-10-21 · **Sky and air traffic in the final wave** (user request). Wave 8 gives the sky its final look: a warmer
  blue, clouds, and blimps and banner-towing planes trailing ads for invented startups (never real companies; the
  content lint applies). The aircraft are ambient scenery on a seeded schedule, not sim entities, so they cost no
  netcode; the Blimp Impressions streak reuses the blimp, and Fleet Week's jets stay a separate, scheduled event.
- 2026-10-22 · **A rusted-out robot falls down or melts** (user request). Seizing is never the end of the
  animation: every model visibly topples or melts into its rust heap during `slumping`, each in its own slapstick
  way (the Footman topples and its groceries spill, the Trundle sinks with its lid popped, the ad drone drops), so a
  melt reads from across a street. The wave-2 combat, render and assets tracks build it, with a browser test and a
  look-dev strip per model for the owner's sign-off.
- 2026-10-23 · **People dodge like people** (owner request: "they jump out of the way in too weird of a way …
  they like fly"). The dodge supersedes the Crazy Taxi rule's leaping dive (2026-10-21, `src/sim/dodge.ts`): a
  9 m/s dive with instant acceleration and a 0.45 m hop becomes a startled sidestep, jog or sprint on the ground
  at 4.8 m/s (6 m/s scrambling), speeding up at 7 m/s² (a late lunge 28) and braking to a stop, seen 1–2.5 s
  ahead by the vehicle's speed. The no-contact guarantee is unchanged: the clearance override still moves anyone a
  vehicle would otherwise reach, drawn as a stumble or shove aside with no lift and never faster than 6 m/s on
  screen. Against a car driven to chase someone (a perfect pursuer with 18 m/s² of grip) no human can always get
  clear, so the no-touch fuzz's override share is bounded per scenario instead of the old 5% overall: 0 for
  non-pursuit drivers, at most 25% for chase, weave, drift, handbrake and random pursuit; contacts stay 0 and
  the 0.75 m clearance holds outside counted override episodes. The player plays real clips (Rocketbox runs and
  dust-off, Mixamo stumble and flinch retargeted to the Rocketbox rig); the crowd's placeholder leans, lengthens
  its stride with speed and startles. SIM_VERSION 11.
