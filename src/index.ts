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
    name: 'public_power',
    description:
      'Electricity generation broken down by production type (solar, wind, nuclear, gas, etc.) for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; each series\' data array is timestamp-aligned to unix_seconds. Power in MW.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter lowercase country code, e.g. "de", "fr", "es", "pl", or "all" for the EU aggregate.' },
        start: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD.' },
      },
      required: ['country', 'start', 'end'],
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
        start: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD.' },
      },
      required: ['bzn', 'start', 'end'],
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
        start: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD.' },
      },
      required: ['country', 'start', 'end'],
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
      'Renewable share of electricity load for a country over a date range. Returns a list of series [{name, data, ...}] where each data point is a percentage; values are timestamp-ordered. Percent of load.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter lowercase country code, e.g. "de", "fr", or "all" for the EU aggregate.' },
        start: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD.' },
      },
      required: ['country', 'start', 'end'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'public_power':
      return ecGet('/public_power', {
        country: reqStr(args, 'country', '"de"'),
        start: reqStr(args, 'start', '"2026-05-30"'),
        end: reqStr(args, 'end', '"2026-05-30"'),
      });
    case 'electricity_price':
      return ecGet('/price', {
        bzn: reqStr(args, 'bzn', '"DE-LU"'),
        start: reqStr(args, 'start', '"2026-05-30"'),
        end: reqStr(args, 'end', '"2026-05-30"'),
      });
    case 'total_power':
      return ecGet('/total_power', {
        country: reqStr(args, 'country', '"de"'),
        start: reqStr(args, 'start', '"2026-05-30"'),
        end: reqStr(args, 'end', '"2026-05-30"'),
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
        start: reqStr(args, 'start', '"2026-05-30"'),
        end: reqStr(args, 'end', '"2026-05-30"'),
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

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
