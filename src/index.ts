interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Energy-Charts');
}

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
      "Renewable share of a country's electricity LOAD, as a percent — how much of demand wind, solar, hydro and biomass are covering, now or over a past date range. Answers \"what share of Germany's electricity is renewable right now\", \"how renewable was France's grid in July\", \"which days last month did renewables cover most of the load\". Accepts a country NAME (\"Germany\") or 2-letter code, or \"eu\"/\"all\" for the EU aggregate. Returns the latest MEASURED reading with its timestamp, a min/avg/max summary for the window, and a per-day breakdown; 15-minute readings are included for windows of 3 days or less. Values are percent OF LOAD and legitimately exceed 100 when a country generates more renewable power than it consumes and exports the surplus. Measured settled data, not a forecast. Keyless. Source: Fraunhofer ISE energy-charts.",
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name ("Germany", "France") or 2-letter code ("de", "fr", "es", "pl"). Use "eu" or "all" for the EU aggregate.' },
        start: { type: 'string', description: 'Optional start date, YYYY-MM-DD. Honoured — a past window returns that window. Defaults to 7 days ago. Maximum span 366 days.' },
        end: { type: 'string', description: 'Optional end date, YYYY-MM-DD, inclusive. Defaults to today.' },
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
  if (!t) throw new Error('user_error: a country is required, e.g. { country: "Germany" }.');
  if (COUNTRY_NAMES[t]) return COUNTRY_NAMES[t];
  // "all" is the upstream's own code for the EU aggregate, and several tool
  // schemas name it. It is three letters, so the 2-letter test below rejects it.
  if (t === 'all') return 'all';
  if (/^[a-z]{2}$/.test(t)) return t;
  throw new Error(`user_error: unrecognized country "${raw}". Pass a name like "Germany", a 2-letter code like "de", or "eu" for the EU aggregate.`);
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

/**
 * Renewable share of load, over a window that is actually honoured.
 *
 * This used to hit `/ren_share`, which is not in the upstream OpenAPI spec at
 * all — it is the chart widget's feed. Measured 2026-08-27: it takes no date
 * parameters (start/end for July and for June returned byte-identical bodies),
 * carries no `unix_seconds` axis, 404s on `country=all`, and splits its payload
 * into a MEASURED series padded with nulls plus a second, unlabelled FORECAST
 * series running a day into the future. Our schema meanwhile advertised
 * start/end, a "defaults to 7 days ago" window, `all` for the EU, and told the
 * caller to "read the last value for the current share" — which is a null, or
 * tomorrow night's forecast. An agent asking how renewable July was got today's
 * numbers back as a clean 200 with nothing to indicate otherwise.
 *
 * `/public_power` publishes the same measured series under `Renewable share of
 * load`, IS documented, IS timestamped, DOES honour start/end (verified over
 * three windows), and DOES serve `all`. Same data, none of the lies.
 */
const SHARE_OF_LOAD = 'Renewable share of load';
const SHARE_OF_GENERATION = 'Renewable share of generation';
const MAX_WINDOW_DAYS = 366;
// A 31-day window is 2,976 readings / 442 KB raw; a year is 35,040 / 5.2 MB.
// Above this span we return daily aggregates only — the per-day rows are what
// answers a historical question anyway, and 5 MB of quarter-hours is not.
const RAW_SERIES_MAX_DAYS = 3;

const DAY_MS = 86_400_000;

async function renewableShare(args: Record<string, unknown>): Promise<unknown> {
  const country = resolveCountry(String(args.country ?? ''));
  const { start, end } = dateRange(args);

  const t0 = Date.parse(`${start}T00:00:00Z`);
  const t1 = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(t0) || Number.isNaN(t1)) {
    throw new Error(`user_error: start and end must be YYYY-MM-DD dates. Got start="${start}", end="${end}".`);
  }
  if (t1 < t0) throw new Error(`user_error: end (${end}) is before start (${start}).`);
  const spanDays = Math.round((t1 - t0) / DAY_MS) + 1;
  if (spanDays > MAX_WINDOW_DAYS) {
    throw new Error(
      `user_error: ${start}..${end} spans ${spanDays} days; the maximum is ${MAX_WINDOW_DAYS}. Ask for a narrower window.`,
    );
  }

  const raw = (await ecGet('/public_power', { country, start, end })) as {
    unix_seconds?: number[];
    production_types?: Array<{ name: string; data: Array<number | null> }>;
  };
  const times = raw.unix_seconds ?? [];
  const types = raw.production_types ?? [];
  const loadShare = types.find((t) => t.name === SHARE_OF_LOAD);

  const window = { start, end, days: spanDays };
  if (!times.length || !loadShare) {
    return {
      country,
      window,
      error: 'no_data',
      message: `No renewable-share data for "${args.country}" between ${start} and ${end}. Energy-Charts does not publish this series for every country.`,
      source: 'https://energy-charts.info',
    };
  }

  // Upstream windows are LOCAL-midnight-aligned, so a request for July 1-7 comes
  // back starting 2026-06-30T22:00Z. Left unfiltered that leaks a 2-hour stub
  // day into `daily` that an agent averaging the rows would weight like a real
  // one. Clip to the UTC days actually asked for, and derive every number below
  // from the clipped set so `summary`, `latest` and `daily` cannot disagree.
  const points: Array<{ t: number; pct: number }> = [];
  for (let i = 0; i < times.length; i++) {
    const v = loadShare.data?.[i];
    if (typeof v !== 'number') continue;
    const day = new Date(times[i] * 1000).toISOString().slice(0, 10);
    if (day < start || day > end) continue;
    points.push({ t: times[i], pct: v });
  }
  if (!points.length) {
    return {
      country,
      window,
      error: 'no_data',
      message: `The renewable-share series for "${args.country}" was empty over ${start}..${end}.`,
      source: 'https://energy-charts.info',
    };
  }

  const pcts = points.map((p) => p.pct);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const last = points[points.length - 1];

  // Daily means over UTC calendar days — the grain a "how was July" question wants.
  const byDay = new Map<string, number[]>();
  for (const p of points) {
    const day = new Date(p.t * 1000).toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(p.pct);
    else byDay.set(day, [p.pct]);
  }
  const daily = [...byDay.entries()].map(([date, vals]) => ({
    date,
    avg_pct: round1(vals.reduce((a, b) => a + b, 0) / vals.length),
    min_pct: round1(Math.min(...vals)),
    max_pct: round1(Math.max(...vals)),
    readings: vals.length,
  }));

  const genShare = types.find((t) => t.name === SHARE_OF_GENERATION);
  let genPct: number | null = null;
  for (let i = times.length - 1; i >= 0; i--) {
    const v = genShare?.data?.[i];
    if (typeof v !== 'number') continue;
    const day = new Date(times[i] * 1000).toISOString().slice(0, 10);
    if (day < start || day > end) continue;
    genPct = round1(v);
    break;
  }

  // `latest` carries the last reading IN THE WINDOW, which for a historical
  // query is not "now" — say which it is rather than letting the caller guess.
  // Settlement runs a couple of hours behind, so age alone would read as stale
  // on a perfectly fresh call; `is_latest_available` is the honest flag.
  const ageMinutes = Math.round((Date.now() - last.t * 1000) / 60_000);
  const todayUtc = new Date().toISOString().slice(0, 10);

  return {
    country,
    metric: 'renewable share of load (percent)',
    window,
    latest: {
      at: new Date(last.t * 1000).toISOString(),
      share_pct: round1(last.pct),
      is_latest_available: end >= todayUtc,
      age_minutes: ageMinutes,
    },
    summary: {
      avg_pct: round1(pcts.reduce((a, b) => a + b, 0) / pcts.length),
      min_pct: round1(Math.min(...pcts)),
      max_pct: round1(Math.max(...pcts)),
      readings: pcts.length,
    },
    renewable_share_of_generation_pct: genPct,
    daily,
    series:
      spanDays <= RAW_SERIES_MAX_DAYS
        ? points.map((p) => ({ at: new Date(p.t * 1000).toISOString(), share_pct: round1(p.pct) }))
        : undefined,
    note:
      `Percent of LOAD covered by renewables, measured at 15-minute resolution (settled data, not a forecast). ` +
      `Values above 100 are real: the country generated more renewable power than it consumed and exported the surplus. ` +
      `Days in \`daily\` are UTC calendar days, so the first and last can be partial \u2014 \`readings\` says how many. ` +
      (spanDays <= RAW_SERIES_MAX_DAYS
        ? 'Quarter-hourly readings are in `series`.'
        : `Window spans ${spanDays} days, so only daily aggregates are returned; ask for 3 days or fewer to get quarter-hourly readings.`),
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
      return renewableShare(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function ecGet(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await pwFetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
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
//
// Only pass this to an endpoint that HONOURS it. Verified 2026-08-27 against
// the upstream OpenAPI spec and by fetching three different windows from each:
// /public_power, /total_power and /price declare start+end and return the
// window asked for. /ren_share is not in the spec and ignores them silently,
// which is what fleet #554 was — a tool sending parameters that did nothing and
// reporting today's numbers for a question about July. Before adding a date
// range to a new endpoint here, fetch two different windows and diff them.
function dateRange(args: Record<string, unknown>): { start: string; end: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const end = typeof args.end === 'string' && args.end.trim() ? (args.end as string).trim() : iso(now);
  const start = typeof args.start === 'string' && args.start.trim() ? (args.start as string).trim() : iso(new Date(now.getTime() - 7 * 86400_000));
  return { start, end };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
