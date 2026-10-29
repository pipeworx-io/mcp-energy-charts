# mcp-energy-charts

Energy-Charts (Fraunhofer ISE) MCP — European electricity generation, prices, and capacity. Keyless public API at https://api.energy-charts.info.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `generation_mix` | The CURRENT ELECTRICITY GENERATION MIX BY FUEL for a European country — how much power is coming from solar, wind, nuclear, gas, coal, hydro, biomass right now, with each fuel's MW and percentage share. Answers "what is Germany's generation mix", "how much of France's electricity is nuclear", "Germany power generation by source", "what fuels are generating electricity in <country>". Accepts a country NAME ("Germany", "France") or 2-letter code. Also returns renewable vs fossil vs nuclear totals. Source: Fraunhofer ISE energy-charts, keyless. |
| `public_power` | Electricity generation broken down by production type (solar, wind, nuclear, gas, etc.) for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; each series' data array is timestamp-aligned to unix_seconds. Power in MW. |
| `electricity_price` | Day-ahead spot electricity prices for a bidding zone over a date range. Returns {unix_seconds, price, unit}; the price array is timestamp-aligned to unix_seconds. Prices in EUR/MWh. |
| `total_power` | Total electricity generation / load for a country over a date range. Returns {unix_seconds, production_types:[{name, data}]}; data arrays are timestamp-aligned to unix_seconds. Power in MW. |
| `installed_power` | Installed generation capacity by production type for a country, as an annual or monthly series. Returns {time:["2002",...], production_types:[{name, data}]}; data arrays are aligned to the time array. Capacity in GW. |
| `renewable_share` | Renewable share of a country's electricity LOAD, as a percent — how much of demand wind, solar, hydro and biomass are covering, now or over a past date range. Answers "what share of Germany's electricity is renewable right now", "how renewable was France's grid in July", "which days last month did renewables cover most of the load". Accepts a country NAME ("Germany") or 2-letter code, or "eu"/"all" for the EU aggregate. Returns the latest MEASURED reading with its timestamp, a min/avg/max summary for the window, and a per-day breakdown; 15-minute readings are included for windows of 3 days or less. Values are percent OF LOAD and legitimately exceed 100 when a country generates more renewable power than it consumes and exports the surplus. Measured settled data, not a forecast. Keyless. Source: Fraunhofer ISE energy-charts. |

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/energy-charts/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/generation_mix \
  -H 'Content-Type: application/json' \
  -d '{"country":"Germany"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/generation_mix`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-energy-charts` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/energy-charts/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "energy-charts": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-energy-charts"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Energy Charts data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
