interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Energy-Charts (Fraunhofer ISE) MCP — European electricity generation, prices, and capacity.
 * Keyless public API at https://api.energy-charts.info.
 *
 * Data conventions across tools:
 * - Time series are timestamp-aligned: the `unix_seconds` array runs parallel to each
 *   series' `data` array (index i of `data` is the value at `unix_seconds[i]`, UTC epoch seconds).
 * - `country` is a 2-letter lowercase code (e.g. "de", "fr", "es", "pl") or "all" for the EU aggregate.
 * - `bzn` is a bidding-zone code (e.g. "DE-LU", "FR", "AT", "ES").
 * - Power values are in MW; prices are in EUR/MWh.
 * - Dates are YYYY-MM-DD.
 */


const BASE = 'https://api.energy-charts.info';
const UA = 'pipeworx-mcp-energy-charts/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'generation_mix',
    description:
      'The CURRENT ELECTRICITY GENERATION MIX BY FUEL for a European country — how much power is coming from solar, wind, nuclear, gas, coal, hydro, biomass right now, with each fuel\'s MW and percentage share. Answers "what is Germany\'s generation mix", "how much of France\'s electricity is nuclear", "Germany power generation by source", "what fuels are generating electricity in <country>". Accepts a country NAME ("Germany", "France") or 2-letter code. Also returns renewable vs fossil vs nuclear totals. Source: Fraunhofer ISE energy-charts, keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name ("Germany", "France", "Spain", "Poland") or 2-letter code ("de", "fr"). Use "eu" for the EU aggregate.' },
        at: { type: 'string', description: 'Optional date YYYY-MM-DD for a historical mix (defaults to the latest available data).' },
      },
      required: ['country'],
    },
  },
  {
    name: 'public_power',
    description:
      'Electricity generation broken down by production type (solar, wind, nuclear, gas, etc.) for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; each series\' data array is timestamp-aligned to unix_seconds. Power in MW.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter lowercase country code, e.g. "de", "fr", "es", "pl", or "all" for the EU aggregate.' },
        start: { type: 'string', description: 'Optional start date, YYYY-MM-DD. Defaults to 7 days ago.' },
        end: { type: 'string', description: 'Optional end date, YYYY-MM-DD. Defaults to today.' },
      },
      required: ['country'],
    },
  },
  {
    name: 'electricity_price',
    description:
      'Day-ahead spot electricity prices for a bidding zone over a date range. Returns {unix_seconds, price, unit}; the price array is timestamp-aligned to unix_seconds. Prices in EUR/MWh.',
    inputSchema: {
      type: 'object',
      properties: {
        bzn: { type: 'string', description: 'Bidding-zone code, e.g. "DE-LU", "FR", "AT", "ES".' },
        start: { type: 'string', description: 'Optional start date, YYYY-MM-DD. Defaults to 7 days ago.' },
        end: { type: 'string', description: 'Optional end date, YYYY-MM-DD. Defaults to today.' },
      },
      required: ['bzn'],
    },
  },
  {
    name: 'total_power',
    description:
      'Total electricity generation / load for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; data arrays are timestamp-aligned to unix_seconds. Power in MW.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter lowercase country code, e.g. "de", "fr", or "all" for the EU aggregate.' },
        start: { type: 'string', description: 'Optional start date, YYYY-MM-DD. Defaults to 7 days ago.' },
        end: { type: 'string', description: 'Optional end date, YYYY-MM-DD. Defaults to today.' },
      },
      required: ['country'],
    },
  },
  {
    name: 'installed_power',
    description:
      'Installed generation capacity by production type for a country, as an annual or monthly series. Returns {time:["2002",...], production_types:[{name, data}]}; data arrays are aligned to the time array. Capacity in GW.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter lowercase country code, e.g. "de", "fr", "es".' },
        time_step: { type: 'string', enum: ['yearly', 'monthly'], description: 'Granularity of the capacity series. Default "yearly".' },
      },
      required: ['country'],
    },
  },
  {
    name: 'renewable_share',
    description:
      "Renewable share of a country's electricity load — what share / percent of load is currently being covered by renewables (wind, solar, hydro combined). Keyless, no API key. Answers \"what share of Germany's electricity load is renewable right now\". Returns a list of series [{name, data, ...}] where each data point is a percent of load; values are timestamp-ordered, most recent last (read the last value for the current share). Dates optional (defaults to the last 7 days).",
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter lowercase country code, e.g. "de", "fr", or "all" for the EU aggregate.' },
        start: { type: 'string', description: 'Optional start date, YYYY-MM-DD. Defaults to 7 days ago.' },
        end: { type: 'string', description: 'Optional end date, YYYY-MM-DD. Defaults to today.' },
      },
      required: ['country'],
    },
  },
];

// Series returned by /public_power that are NOT generation — summing them would
// corrupt the mix. Load/Residual load are demand; the share rows are percentages;
// cross-border trading is import/export; pumped-storage CONSUMPTION is negative load.
const NON_GENERATION = new Set([
  'Load',
  'Residual load',
  'Renewable share of load',
  'Renewable share of generation',
  'Cross border electricity trading',
  'Hydro pumped storage consumption',
]);

const RENEWABLE = /solar|wind|hydro|biomass|geothermal/i;
const FOSSIL = /fossil|waste/i;
const NUCLEAR = /nuclear/i;

// Agents say "Germany", the API wants "de".
const COUNTRY_NAMES: Record<string, string> = {
  germany: 'de', deutschland: 'de', france: 'fr', spain: 'es', italy: 'it', poland: 'pl',
  netherlands: 'nl', belgium: 'be', austria: 'at', switzerland: 'ch', denmark: 'dk',
  sweden: 'se', norway: 'no', finland: 'fi', portugal: 'pt', czechia: 'cz',
  'czech republic': 'cz', greece: 'gr', ireland: 'ie', hungary: 'hu', romania: 'ro',
  bulgaria: 'bg', croatia: 'hr', slovakia: 'sk', slovenia: 'si', estonia: 'ee',
  latvia: 'lv', lithuania: 'lt', luxembourg: 'lu', 'united kingdom': 'uk', uk: 'uk',
  eu: 'all', europe: 'all', 'european union': 'all',
};

function resolveCountry(raw: string): string {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) throw new Error('generation_mix requires a country, e.g. { country: "Germany" }.');
  if (COUNTRY_NAMES[t]) return COUNTRY_NAMES[t];
  if (/^[a-z]{2}$/.test(t)) return t;
  throw new Error(`Unrecognized country "${raw}". Pass a name like "Germany" or a 2-letter code like "de".`);
}

async function generationMix(args: Record<string, unknown>): Promise<unknown> {
  const country = resolveCountry(String(args.country ?? ''));
  const at = typeof args.at === 'string' && args.at.trim() ? args.at.trim() : '';
  const params: Record<string, string> = { country };
  if (at) { params.start = at; params.end = at; }
  const raw = (await ecGet('/public_power', params)) as {
    unix_seconds?: number[];
    production_types?: Array<{ name: string; data: Array<number | null> }>;
  };

  const times = raw.unix_seconds ?? [];
  const types = raw.production_types ?? [];
  if (!times.length || !types.length) {
    return { country, error: 'no_data', message: `No generation data returned for "${args.country}"${at ? ` on ${at}` : ''}.` };
  }

  // Latest index where the generation series actually carry values (the tail of
  // the array is often null while the current interval is still settling).
  const gen = types.filter((t) => !NON_GENERATION.has(t.name));
  let idx = -1;
  for (let i = times.length - 1; i >= 0; i--) {
    if (gen.some((t) => typeof t.data?.[i] === 'number')) { idx = i; break; }
  }
  if (idx < 0) return { country, error: 'no_data', message: 'Generation series contained no numeric values.' };

  const rows = gen
    .map((t) => ({ fuel: t.name, megawatts: typeof t.data?.[idx] === 'number' ? (t.data[idx] as number) : null }))
    .filter((r) => r.megawatts !== null && r.megawatts !== 0) as Array<{ fuel: string; megawatts: number }>;

  // Shares are over POSITIVE generation only (pumped storage can be negative).
  const totalGen = rows.reduce((sum, r) => sum + Math.max(0, r.megawatts), 0);
  const withShare = rows
    .map((r) => ({
      fuel: r.fuel,
      megawatts: Math.round(r.megawatts * 10) / 10,
      share_pct: totalGen > 0 ? Math.round((Math.max(0, r.megawatts) / totalGen) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.megawatts - a.megawatts);

  const bucket = (re: RegExp) =>
    Math.round(rows.filter((r) => re.test(r.fuel)).reduce((s, r) => s + Math.max(0, r.megawatts), 0) * 10) / 10;
  const renewable = bucket(RENEWABLE);
  const fossil = bucket(FOSSIL);
  const nuclear = bucket(NUCLEAR);

  const shareRow = types.find((t) => t.name === 'Renewable share of generation');
  const reportedRenewShare = typeof shareRow?.data?.[idx] === 'number' ? (shareRow.data[idx] as number) : null;

  return {
    country,
    as_of: new Date(times[idx] * 1000).toISOString(),
    total_generation_mw: Math.round(totalGen * 10) / 10,
    by_fuel: withShare,
    summary: {
      renewable_mw: renewable,
      fossil_mw: fossil,
      nuclear_mw: nuclear,
      renewable_share_pct: totalGen > 0 ? Math.round((renewable / totalGen) * 1000) / 10 : null,
      reported_renewable_share_of_generation_pct: reportedRenewShare,
    },
    note: 'Instantaneous generation by fuel (MW) at the latest settled interval. Shares are over positive generation; load, cross-border trade and pumped-storage consumption are excluded from the mix. Source: Fraunhofer ISE energy-charts.',
    source: 'https://energy-charts.info',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'generation_mix':
      return generationMix(args);
    case 'public_power':
      return ecGet('/public_power', {
        country: reqStr(args, 'country', '"de"'),
        ...dateRange(args),
      });
    case 'electricity_price':
      return ecGet('/price', {
        bzn: reqStr(args, 'bzn', '"DE-LU"'),
        ...dateRange(args),
      });
    case 'total_power':
      return ecGet('/total_power', {
        country: reqStr(args, 'country', '"de"'),
        ...dateRange(args),
      });
    case 'installed_power':
      return ecGet('/installed_power', {
        country: reqStr(args, 'country', '"de"'),
        time_step: (args.time_step as string | undefined)?.trim() || 'yearly',
        installation_decommission: 'false',
      });
    case 'renewable_share':
      return ecGet('/ren_share', {
        country: reqStr(args, 'country', '"de"'),
        ...dateRange(args),
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function ecGet(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Energy-Charts: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v.trim();
}

// start/end are OPTIONAL for the time-series tools: the router (and most agents)
// ask "what's Germany's renewable share" without dates. Default to the last 7
// days ending today so the call succeeds and returns a useful recent window,
// rather than throwing "Required argument start is missing". Explicit dates
// still override. YYYY-MM-DD, UTC.
function dateRange(args: Record<string, unknown>): { start: string; end: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const end = typeof args.end === 'string' && args.end.trim() ? (args.end as string).trim() : iso(now);
  const start = typeof args.start === 'string' && args.start.trim() ? (args.start as string).trim() : iso(new Date(now.getTime() - 7 * 86400_000));
  return { start, end };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
