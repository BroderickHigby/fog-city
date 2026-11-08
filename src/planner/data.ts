// Facts behind the Planner demo, each with its source. Numbers only: no network at runtime.
// How each table was extracted is in docs/planner.md ("Data").

/** Caltrans annual traffic census, Route 101 in San Francisco (two directions combined). */
export interface CaltransCount {
  year: number;
  /** Postmile 6.712, "Lombard Street": AHEAD leg = Lombard St west of Van Ness Ave. */
  lombardVanNessAadt: number;
  lombardVanNessPeakHour: number;
  /** Postmile 7.8, "Broderick Street": AHEAD leg = Lombard St / Richardson Ave west of Broderick. */
  broderickAadt: number;
  broderickPeakHour: number;
}

export const CALTRANS_SOURCE = "Caltrans Traffic Census Program, annual traffic volumes (AADT) workbooks 2013-2024, Route 101, County SF, postmiles 6.712 and 7.8 (AHEAD leg). https://dot.ca.gov/programs/traffic-operations/census";

/** 2024's workbook repeats 2023's figures for both postmiles (no new count). */
export const CALTRANS_COUNTS: readonly CaltransCount[] = [
  { year: 2013, lombardVanNessAadt: 35500, lombardVanNessPeakHour: 2550, broderickAadt: 45000, broderickPeakHour: 3250 },
  { year: 2014, lombardVanNessAadt: 36000, lombardVanNessPeakHour: 2600, broderickAadt: 45500, broderickPeakHour: 3300 },
  { year: 2015, lombardVanNessAadt: 36500, lombardVanNessPeakHour: 2650, broderickAadt: 46000, broderickPeakHour: 3350 },
  { year: 2016, lombardVanNessAadt: 38500, lombardVanNessPeakHour: 2900, broderickAadt: 48500, broderickPeakHour: 3650 },
  { year: 2017, lombardVanNessAadt: 40500, lombardVanNessPeakHour: 3100, broderickAadt: 51000, broderickPeakHour: 3900 },
  { year: 2018, lombardVanNessAadt: 39400, lombardVanNessPeakHour: 3100, broderickAadt: 49700, broderickPeakHour: 3800 },
  { year: 2019, lombardVanNessAadt: 38700, lombardVanNessPeakHour: 3000, broderickAadt: 48700, broderickPeakHour: 3800 },
  { year: 2020, lombardVanNessAadt: 33000, lombardVanNessPeakHour: 2600, broderickAadt: 41500, broderickPeakHour: 3200 },
  { year: 2021, lombardVanNessAadt: 31500, lombardVanNessPeakHour: 2500, broderickAadt: 39500, broderickPeakHour: 3000 },
  { year: 2022, lombardVanNessAadt: 35500, lombardVanNessPeakHour: 2800, broderickAadt: 44500, broderickPeakHour: 3400 },
  { year: 2023, lombardVanNessAadt: 36000, lombardVanNessPeakHour: 2800, broderickAadt: 45000, broderickPeakHour: 3450 },
  { year: 2024, lombardVanNessAadt: 36000, lombardVanNessPeakHour: 2800, broderickAadt: 45000, broderickPeakHour: 3450 },
];

export const SFMTA_SOURCE = "SFMTA Traffic Count Data 1993-2015 (24-hour counts by direction). https://www.sfmta.com/sites/default/files/reports/2016/SFMTA%20Traffic%20Count%20Data%201993-2015%20with%20cover%20sheet.pdf";

/** SFMTA weekday 24-hour counts on the US-101 section of Lombard St, both directions added. */
export const SFMTA_LOMBARD_COUNTS: readonly { date: string; at: string; daily: number }[] = [
  { date: "1996-11-13", at: "Lombard St west of Laguna St", daily: 24363 + 26132 },
  { date: "2010-04-26", at: "Lombard St at Pierce St", daily: 24932 + 20411 },
  { date: "2011-05-04", at: "Lombard St east of Pierce St", daily: 25827 + 23287 },
  { date: "2015-11-05", at: "Lombard St, Broderick St to Divisadero St", daily: 23845 + 23448 },
  { date: "2015-11-05", at: "Lombard St, Steiner St to Fillmore St", daily: 22887 + 22002 },
];

export const DOF_SOURCE = "California Department of Finance, E-4 population estimates (1991-2000 with 1990 and 2000 census; 2011-2020 with 2010 and 2020 census; 2021-2026 with 2020 census benchmark). https://dof.ca.gov/forecasting/demographics/estimates/";

/** San Francisco population, January 1 estimates (census years: the April 1 count). */
export const SF_POPULATION: readonly { year: number; population: number; census?: true }[] = [
  { year: 1990, population: 723959, census: true },
  { year: 1996, population: 741971 },
  { year: 2000, population: 776733, census: true },
  { year: 2010, population: 805235, census: true },
  { year: 2011, population: 815714 },
  { year: 2012, population: 826354 },
  { year: 2013, population: 839556 },
  { year: 2014, population: 846661 },
  { year: 2015, population: 855489 },
  { year: 2016, population: 861977 },
  { year: 2017, population: 867378 },
  { year: 2018, population: 872724 },
  { year: 2019, population: 872219 },
  { year: 2020, population: 873965, census: true },
  { year: 2021, population: 850783 },
  { year: 2022, population: 836264 },
  { year: 2023, population: 842227 },
  { year: 2024, population: 841228 },
  { year: 2025, population: 844394 },
  { year: 2026, population: 845658 },
];

/** EPA: "CO2 emissions from a gallon of gasoline: 8,887 grams CO2/ gallon". */
export const EPA_CO2_G_PER_GALLON = 8887;
export const EPA_SOURCE = "US EPA, Greenhouse Gas Emissions from a Typical Passenger Vehicle. https://www.epa.gov/greenvehicles/greenhouse-gas-emissions-typical-passenger-vehicle";
export const LITRES_PER_GALLON = 3.785411784;
export const CO2_G_PER_ML = EPA_CO2_G_PER_GALLON / (LITRES_PER_GALLON * 1000);

/**
 * ARRB instantaneous fuel model (Akcelik 1989), with the parameter set quoted in Wang et al.,
 * "Experimental features of emissions and fuel consumption in a car-following platoon",
 * arXiv:2305.00750, section 2.2.3, equation (10):
 *   f = alpha + beta1 (d1 v + d2 v^3 + d3 v^2 + m a v) + beta2 m max(0, a)^2 v     [mL/s]
 * m in tonnes, v in m/s, a in m/s^2. Below zero tractive power the engine idles (f = alpha).
 */
export const ARRB = Object.freeze({ alphaMlPerS: 0.666, beta1: 0.072, beta2: 0.033984, massT: 1.68, d1: 0.269, d2: 0.000672, d3: 0.0171 });
export const ARRB_SOURCE = "Akcelik (1989) ARRB fuel model, parameters from arXiv:2305.00750 eq. (10). https://arxiv.org/abs/2305.00750";

/** San Francisco's 2023-2031 housing target (RHNA). */
export const RHNA_HOMES_2031 = 82069;

export interface CrossStreetVolume {
  street: string;
  /** Two-way 24-hour volume on the cross street next to Lombard St. */
  daily: number;
  source: string;
}

/**
 * Cross-street volumes at each signalised Lombard intersection, Van Ness Ave to Broderick St.
 * Counted where SFMTA counted near Lombard; otherwise an estimate by street type, marked so.
 */
export const CROSS_STREETS: readonly CrossStreetVolume[] = [
  { street: "Van Ness Ave", daily: 6000, source: "estimate (Van Ness north of Lombard only; the US-101 turn onto Lombard is the corridor itself)" },
  { street: "Franklin St", daily: 6000, source: "estimate (Franklin north of Lombard; most Franklin traffic turns onto Lombard)" },
  { street: "Gough St", daily: 1429 + 6486, source: "SFMTA count, Gough St at Filbert St, 1996-02-22" },
  { street: "Octavia St", daily: 7415 + 3954, source: "SFMTA count, Octavia St, Greenwich St to Filbert St, 2014-09-10" },
  { street: "Laguna St", daily: 2300 + 3562, source: "SFMTA count, Laguna St at Chestnut St, 1999-03-29" },
  { street: "Buchanan St", daily: 1357 + 1619, source: "SFMTA count, Buchanan St at Union St, 1999-05-19" },
  { street: "Webster St", daily: 6000, source: "estimate (collector)" },
  { street: "Fillmore St", daily: 8000, source: "estimate (collector)" },
  { street: "Steiner St", daily: 6000, source: "estimate (collector)" },
  { street: "Pierce St", daily: 2500, source: "estimate (residential)" },
  { street: "Scott St", daily: 8899 + 7867, source: "SFMTA count, Scott St, Greenwich St to Filbert St, 2014-09-16" },
  { street: "Divisadero St", daily: 3850 + 3739, source: "SFMTA count, Divisadero St, Lombard St to Greenwich St, 2012-05-16" },
  { street: "Broderick St", daily: 1740 + 1482, source: "SFMTA count, Broderick St at Lombard St, 2006-09-13" },
];

/** Share of a day's traffic in its busiest hour (a standard planning K factor). */
export const PEAK_HOUR_SHARE = 0.09;
