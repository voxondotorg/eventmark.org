/** Calendar range, region filter, and month-prefix KV scans for EventMark. */

export type CalendarRegion = "all" | "americas" | "emea" | "apac" | "mea";

const MS_DAY = 86400000;
const MAX_RANGE_DAYS = 366;

const REGION_KEYWORDS: Record<Exclude<CalendarRegion, "all">, readonly string[]> = {
  americas: [
    "americas",
    "america",
    "usa",
    "u.s.",
    "us ",
    "united states",
    "canada",
    "mexico",
    "brazil",
    "argentina",
    "chile",
    "colombia",
    "toronto",
    "montreal",
    "vancouver",
    "new york",
    "san francisco",
    "los angeles",
    "chicago",
    "boston",
    "seattle",
    "austin",
    "denver",
    "miami",
    "latin america",
  ],
  emea: [
    "emea",
    "europe",
    "eu ",
    "uk",
    "united kingdom",
    "london",
    "berlin",
    "munich",
    "paris",
    "france",
    "germany",
    "spain",
    "madrid",
    "barcelona",
    "italy",
    "rome",
    "milan",
    "amsterdam",
    "netherlands",
    "brussels",
    "zurich",
    "geneva",
    "sweden",
    "stockholm",
    "norway",
    "oslo",
    "denmark",
    "copenhagen",
    "finland",
    "helsinki",
    "dublin",
    "warsaw",
    "prague",
    "vienna",
    "lisbon",
    "athens",
    "istanbul",
    "tel aviv",
    "dubai",
    "nigeria",
    "lagos",
    "kenya",
    "nairobi",
    "south africa",
    "johannesburg",
    "cape town",
  ],
  apac: [
    "apac",
    "asia",
    "pacific",
    "oceania",
    "australia",
    "sydney",
    "melbourne",
    "brisbane",
    "perth",
    "new zealand",
    "auckland",
    "wellington",
    "japan",
    "tokyo",
    "osaka",
    "china",
    "beijing",
    "shanghai",
    "shenzhen",
    "hong kong",
    "taiwan",
    "taipei",
    "singapore",
    "korea",
    "seoul",
    "india",
    "bangalore",
    "mumbai",
    "delhi",
    "hyderabad",
    "vietnam",
    "hanoi",
    "thailand",
    "bangkok",
    "philippines",
    "manila",
    "indonesia",
    "jakarta",
    "malaysia",
    "kuala lumpur",
  ],
  mea: [
    "middle east",
    "mena",
    "mea",
    "saudi",
    "riyadh",
    "qatar",
    "doha",
    "kuwait",
    "bahrain",
    "oman",
    "muscat",
    "egypt",
    "cairo",
    "morocco",
    "casablanca",
    "tunisia",
    "algeria",
    "ethiopia",
    "addis",
  ],
};

export function parseCalendarRegion(raw: string | null | undefined): CalendarRegion {
  const v = (raw || "all").toLowerCase();
  if (v === "americas" || v === "emea" || v === "apac" || v === "mea") return v;
  return "all";
}

export function locationMatchesRegion(location: string, region: CalendarRegion): boolean {
  if (region === "all") return true;
  const loc = location.toLowerCase();
  for (const kw of REGION_KEYWORDS[region]) {
    if (loc.includes(kw)) return true;
  }
  return false;
}

/** YYYY-MM strings from first month touching `from` through last month touching `to` (inclusive). */
export function monthYmPrefixesBetween(fromIso: string, toIso: string): string[] {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(+from) || Number.isNaN(+to) || from > to) return [];
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

/** Clamp `to` so the span from `from` is at most MAX_RANGE_DAYS. Returns { from, to } ISO strings at UTC midnight boundaries. */
export function clampCalendarRange(fromIso: string, toIso: string): { from: string; to: string } | null {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(+from) || Number.isNaN(+to)) return null;
  if (from > to) return null;
  const maxEnd = new Date(from.getTime() + MAX_RANGE_DAYS * MS_DAY);
  const toClamped = to > maxEnd ? maxEnd : to;
  return { from: from.toISOString(), to: toClamped.toISOString() };
}

export function utcDateKeyFromIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return d.toISOString().slice(0, 10);
}
