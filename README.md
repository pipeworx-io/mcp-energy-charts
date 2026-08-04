# mcp-energy-charts

Energy-Charts (Fraunhofer ISE) MCP — European electricity generation, prices, and capacity.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `generation_mix` | The CURRENT ELECTRICITY GENERATION MIX BY FUEL for a European country — how much power is coming from solar, wind, nuclear, gas, coal, hydro, biomass right now, with each fuel's MW and percentage share. Answers "what is Germany's generation mix", "how much of France's electricity is nuclear", "Germany power generation by source", "what fuels are generating electricity in <country>". Accepts a country NAME ("Germany", "France") or 2-letter code. Also returns renewable vs fossil vs nuclear totals. Source: Fraunhofer ISE energy-charts, keyless. |
| `public_power` | Electricity generation broken down by production type (solar, wind, nuclear, gas, etc.) for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; each series' data array is timestamp-aligned to unix_seconds. Power in MW. |
| `electricity_price` | Day-ahead spot electricity prices for a bidding zone over a date range. Returns {unix_seconds, price, unit}; the price array is timestamp-aligned to unix_seconds. Prices in EUR/MWh. |
| `total_power` | Total electricity generation / load for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; data arrays are timestamp-aligned to unix_seconds. Power in MW. |
| `installed_power` | Installed generation capacity by production type for a country, as an annual or monthly series. Returns {time:["2002",...], production_types:[{name, data}]}; data arrays are aligned to the time array. Capacity in GW. |
| `renewable_share` | Renewable share of a country's electricity load — what share / percent of load is currently being covered by renewables (wind, solar, hydro combined). Keyless, no API key. Answers "what share of Germany's electricity load is renewable right now". Returns a list of series [{name, data, ...}] where each data point is a percent of load; values are timestamp-ordered, most recent last (read the last value for the current share). Dates optional (defaults to the last 7 days). |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "energy-charts": {
      "url": "https://gateway.pipeworx.io/energy-charts/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Energy Charts data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
