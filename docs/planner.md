# Fog City Planner

A city-planning demo in the Fog City engine: real San Francisco streets, measured traffic, and
signal timing you can change. Open `/?world=sf&mode=planner`. The game's simulation, saves and UI
do not run in this mode. The proposal behind it is the "Fog City Planner: proposal" doc.

The first corridor is **US-101 on Lombard Street**, Van Ness Ave to Richardson Ave: 1.8 km,
13 signals, three lanes each way, the surface-street route to the Golden Gate Bridge.

## What it shows

- **Rush hour:** evening (westbound to the bridge is busy) or morning (eastbound into town).
- **Traffic:** today's measured peak hour; 2031 with the 82,069-home housing target built,
  following the 1996-2023 trend; and 2031 if traffic grew with population (a stress test).
- **Signals:** today's timing (assumed, see below), a plain green wave, optimized timing, and
  adaptive signals that react to the cars they see.
- **Scorecard:** drive time in the busy direction, stops per car, hours everyone loses waiting
  (side streets included), and CO2 per hour, each plan against the same cars.
- **Cameras:** a tour, an overview from Pacific Heights, street level at Fillmore, and a ride
  along with one car.

URL options: `period=pm|am`, `traffic=now|trend2031|grow2031`, `plan=today|greenwave|optimized|adaptive`,
`camera=tour|overview|street|follow`, `speed=1|4|10`.

## Results (model, evening peak, today's traffic, five unseen seeds)

`node scripts/planner/results.ts` prints the full table. Evening peak, today's counted traffic:

| Signals | Drive west | Stops per car | Hours lost per hour | CO2 per hour |
|---|---|---|---|---|
| Today (assumed, uncoordinated) | 8:02 | 5.3 | 352 | 3,761 kg |
| Green wave | 5:58 | 3.6 | 270 | 3,172 kg |
| Optimized timing | 3:45 | 1.6 | 175 | 2,630 kg |
| Adaptive signals | 4:25 | 2.6 | 293 | 3,393 kg |

Read these as a comparison between plans, not as a forecast. Field studies of retiming and
adaptive signals report smaller gains: 1.4-5% CO2 (Adelaide, field), about 10% (Antwerp,
simulation), and 21% lower emissions with 25% shorter trips for the Surtrac adaptive pilot in
Pittsburgh. A model with no parking, buses, bikes or pedestrians crossing on red overstates the
benefit; the gap between the green wave and the optimized plan is the more trustworthy figure.

Adaptive signals give Lombard's drivers short trips but make the side streets wait about twice
as long as the optimized fixed plan does; that trade-off is the demo's second talking point.

## The model (`src/planner/`)

| File | What it does |
|---|---|
| `corridor.ts` | Builds the corridor from the game's road graph and signal list (DataSF). |
| `data.ts` | Every measured number and its source. |
| `demand.ts` | The peak hour: cars entering each end, joining and leaving at each cross street, cross-street queues. |
| `traffic.ts` | Each car in each lane follows the Intelligent Driver Model (Treiber, Hennecke and Helbing, 2000); signals are stop lines with a yellow-light decision; cross streets are queues. Deterministic, with every plan seeing the same cars. |
| `emissions.ts` | Fuel second by second from speed and acceleration (ARRB model, Akcelik 1989), CO2 at EPA's 8,887 g per gallon. |
| `signals.ts` | Fixed-time plans, the green wave and the adaptive controller (gap-out with platoon look-ahead, minimum greens for people crossing). |
| `optimize.ts` | Coordinate descent over cycle length, greens and offsets, minimizing everyone's waiting including side streets. `scripts/planner/optimize-lombard.ts` writes `plans.json`. |
| `forecast.ts` | Traffic against population, 1996-2023, and the 2031 levels. |
| `view.ts`, `panel.ts` | The 3D overlay and the side panel. |

## Data

| Data | Source | How it was taken |
|---|---|---|
| Lombard St traffic, 2013-2024 | Caltrans Traffic Census annual AADT workbooks, Route 101, county SF, postmiles 6.712 (Lombard St) and 7.8 (Broderick St), AHEAD leg | Read from each year's workbook on dot.ca.gov; 2024 repeats 2023. |
| Lombard St traffic, 1996-2015 | SFMTA Traffic Count Data 1993-2015 (PDF) | `pdftotext -layout`, rows whose primary street is Lombard and cross street between Van Ness and Broderick; east-of-Van Ness rows are not US-101 and are left out. |
| Cross-street traffic | Same SFMTA file, counts nearest each intersection | Six intersections have no count: their figures are estimates by street type, marked in `data.ts` and on screen. |
| San Francisco population | California Department of Finance E-4 tables (1991-2000, 2011-2020, 2021-2026) | County row, January 1 estimates and the April 1 census counts. |
| Fuel model | Akcelik (1989) ARRB model; parameters as given in arXiv:2305.00750, eq. (10) | |
| CO2 per gallon | US EPA, Greenhouse Gas Emissions from a Typical Passenger Vehicle | 8,887 g per gallon. |
| Streets, signals | DataSF `3psu-pn9h`, `ybh5-27n2` (PDDL 1.0), already in the game | |

**What is assumed, not measured:** signal timing (SFMTA does not publish it: "today" is a 90 s
cycle with greens split by measured traffic and uncoordinated offsets); the peak direction's
55% share (SFMTA's 2015 Broderick counts); 3% of cars turning off at each signal; 9% of a
cross street's daily traffic in its busiest hour; 2 people per new home.

**Finding:** San Francisco grew about 18% from 1996 to 2019 while daily traffic on this stretch
stayed level (about 50,500 in 1996, 46,000-51,000 in 2013-2019). The fitted elasticity of
traffic to population is -0.09. The street is full at the peak, so growth lengthens the busy
period instead of raising the peak hour.

## Next

The 511 SF Bay token (free) brings Muni schedules for the buses that use the corridor. A records request to SFMTA for Lombard's timing plans would replace the assumed
"today". After that: the housing layers for 2031, the Muni editor and the citywide view
(the proposal's milestones M2-M4).
