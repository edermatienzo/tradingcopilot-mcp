import "dotenv/config";
import crypto from "crypto";
import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY         = process.env.MASSIVE_API_KEY;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const JWT_SECRET      = process.env.JWT_SECRET;
const TOKEN_TTL       = parseInt(process.env.TOKEN_TTL_SECONDS ?? "3600", 10); // 1 h default
// DEBUG_LEVEL: "silent" | "info" (default) | "verbose"
const DEBUG_LEVEL     = process.env.DEBUG_LEVEL ?? "info";
const PORT            = parseInt(process.env.PORT ?? "3000", 10);
// PUBLIC_URL: explicit env var → Railway auto-domain → localhost fallback
const PUBLIC_URL = (
  process.env.PUBLIC_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ??
  `http://localhost:${PORT}`
).replace(/\/$/, "");
const BASE_URL        = "https://api.massive.com";

for (const [name, val] of [
  ["MASSIVE_API_KEY",    API_KEY],
  ["OAUTH_CLIENT_ID",    OAUTH_CLIENT_ID],
  ["OAUTH_CLIENT_SECRET",OAUTH_CLIENT_SECRET],
  ["JWT_SECRET",         JWT_SECRET],
]) {
  if (!val) {
    console.error(`ERROR: ${name} is not set in environment variables.`);
    process.exit(1);
  }
}

// ── Axios client ──────────────────────────────────────────────────────────────
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: { Authorization: `Bearer ${API_KEY}` },
  timeout: 15_000,
});

async function callApi(path, params = {}) {
  try {
    const { data } = await apiClient.get(path, { params });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message ?? err.message;
    throw new Error(`Massive API error ${status ?? "unknown"}: ${message}`);
  }
}

// ── MCP server factory (one instance per client session) ─────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "massive-trading-copilot",
    version: "1.0.0",
  });

// ── Tool: get_ticker_info ─────────────────────────────────────────────────────
server.tool(
  "get_ticker_info",
  "Retrieve comprehensive reference information for a stock ticker: company name, description, SIC code, market cap, exchange, share counts, address, branding, and more.",
  {
    ticker: z.string().describe("Case-sensitive ticker symbol, e.g. AAPL"),
    date: z
      .string()
      .optional()
      .describe(
        "Point-in-time date (YYYY-MM-DD). Defaults to most recent available."
      ),
  },
  async ({ ticker, date }) => {
    const params = date ? { date } : {};
    const data = await callApi(`/v3/reference/tickers/${ticker}`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_ticker_snapshot ─────────────────────────────────────────────────
server.tool(
  "get_ticker_snapshot",
  "Retrieve the most recent real-time market data snapshot for a US stock ticker: last trade, last quote, minute bar, day bar, previous day bar, today's change, and fair market value.",
  {
    ticker: z
      .string()
      .describe("Case-sensitive ticker symbol, e.g. AAPL"),
  },
  async ({ ticker }) => {
    const data = await callApi(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_open_close ──────────────────────────────────────────────────────
server.tool(
  "get_open_close",
  "Retrieve the daily open, high, low, close, volume, pre-market, and after-hours prices for a US stock on a specific date.",
  {
    ticker: z.string().describe("Case-sensitive ticker symbol, e.g. AAPL"),
    date: z
      .string()
      .describe("Trading date in YYYY-MM-DD format, e.g. 2024-01-15"),
    adjusted: z
      .boolean()
      .optional()
      .describe(
        "Whether to adjust results for splits (default: true)"
      ),
  },
  async ({ ticker, date, adjusted }) => {
    const params = adjusted !== undefined ? { adjusted } : {};
    const data = await callApi(`/v1/open-close/${ticker}/${date}`, params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_aggregates ──────────────────────────────────────────────────────
server.tool(
  "get_aggregates",
  "Retrieve aggregated historical OHLCV candlestick bars for a stock over a custom date range and timeframe (e.g. 1 minute, 1 hour, 1 day). Returns open, high, low, close, volume, VWAP, and transaction count per bar.",
  {
    ticker: z.string().describe("Case-sensitive ticker symbol, e.g. AAPL"),
    multiplier: z
      .number()
      .int()
      .positive()
      .describe("Size multiplier for the timespan, e.g. 1, 5, 15"),
    timespan: z
      .enum(["minute", "hour", "day", "week", "month", "quarter", "year"])
      .describe("Time window unit"),
    from: z
      .string()
      .describe("Start date (YYYY-MM-DD) or millisecond Unix timestamp"),
    to: z
      .string()
      .describe("End date (YYYY-MM-DD) or millisecond Unix timestamp"),
    adjusted: z
      .boolean()
      .optional()
      .describe("Adjust for splits (default: true)"),
    sort: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort order for bars (default: asc)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .optional()
      .describe("Max number of bars to return (default: 5000, max: 50000)"),
  },
  async ({ ticker, multiplier, timespan, from, to, adjusted, sort, limit }) => {
    const params = {};
    if (adjusted !== undefined) params.adjusted = adjusted;
    if (sort) params.sort = sort;
    if (limit) params.limit = limit;

    const data = await callApi(
      `/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}`,
      params
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_income_statements ───────────────────────────────────────────────
server.tool(
  "get_income_statements",
  "Retrieve fundamental income statement data for one or more stocks: revenue, gross profit, operating income, EBITDA, net income, EPS, R&D, SG&A, taxes, and more.",
  {
    tickers: z
      .string()
      .optional()
      .describe("Comma-separated ticker symbols, e.g. AAPL,MSFT"),
    cik: z.string().optional().describe("SEC Central Index Key (CIK)"),
    timeframe: z
      .enum(["quarterly", "annual", "trailing_twelve_months"])
      .optional()
      .describe("Reporting period type"),
    fiscal_year: z
      .number()
      .int()
      .optional()
      .describe("Fiscal year, e.g. 2023"),
    fiscal_quarter: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe("Fiscal quarter (1-4)"),
    period_end: z
      .string()
      .optional()
      .describe("Period end date (YYYY-MM-DD)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .optional()
      .describe("Max results (default: 100)"),
    sort: z.string().optional().describe("Sort field, e.g. period_end.desc"),
  },
  async ({ tickers, cik, timeframe, fiscal_year, fiscal_quarter, period_end, limit, sort }) => {
    const params = {};
    if (tickers) params.tickers = tickers;
    if (cik) params.cik = cik;
    if (timeframe) params.timeframe = timeframe;
    if (fiscal_year !== undefined) params.fiscal_year = fiscal_year;
    if (fiscal_quarter !== undefined) params.fiscal_quarter = fiscal_quarter;
    if (period_end) params.period_end = period_end;
    if (limit) params.limit = limit;
    if (sort) params.sort = sort;

    const data = await callApi("/stocks/financials/v1/income-statements", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_balance_sheets ──────────────────────────────────────────────────
server.tool(
  "get_balance_sheets",
  "Retrieve balance sheet data for one or more stocks: total assets, cash, receivables, inventory, property/equipment, total liabilities, debt, accounts payable, equity, retained earnings, and more.",
  {
    tickers: z
      .string()
      .optional()
      .describe("Comma-separated ticker symbols, e.g. AAPL,MSFT"),
    cik: z.string().optional().describe("SEC Central Index Key (CIK)"),
    timeframe: z
      .enum(["quarterly", "annual", "trailing_twelve_months"])
      .optional()
      .describe("Reporting period type"),
    fiscal_year: z.number().int().optional().describe("Fiscal year, e.g. 2023"),
    fiscal_quarter: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe("Fiscal quarter (1-4)"),
    period_end: z.string().optional().describe("Period end date (YYYY-MM-DD)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .optional()
      .describe("Max results (default: 100)"),
    sort: z.string().optional().describe("Sort field, e.g. period_end.desc"),
  },
  async ({ tickers, cik, timeframe, fiscal_year, fiscal_quarter, period_end, limit, sort }) => {
    const params = {};
    if (tickers) params.tickers = tickers;
    if (cik) params.cik = cik;
    if (timeframe) params.timeframe = timeframe;
    if (fiscal_year !== undefined) params.fiscal_year = fiscal_year;
    if (fiscal_quarter !== undefined) params.fiscal_quarter = fiscal_quarter;
    if (period_end) params.period_end = period_end;
    if (limit) params.limit = limit;
    if (sort) params.sort = sort;

    const data = await callApi("/stocks/financials/v1/balance-sheets", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_cash_flow_statements ────────────────────────────────────────────
server.tool(
  "get_cash_flow_statements",
  "Retrieve cash flow statement data for one or more stocks: operating, investing, and financing cash flows, capex, dividends, debt issuances, depreciation, and net change in cash.",
  {
    tickers: z
      .string()
      .optional()
      .describe("Comma-separated ticker symbols, e.g. AAPL,MSFT"),
    cik: z.string().optional().describe("SEC Central Index Key (CIK)"),
    timeframe: z
      .enum(["quarterly", "annual", "trailing_twelve_months"])
      .optional()
      .describe("Reporting period type"),
    fiscal_year: z.number().int().optional().describe("Fiscal year, e.g. 2023"),
    fiscal_quarter: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe("Fiscal quarter (1-4)"),
    period_end: z.string().optional().describe("Period end date (YYYY-MM-DD)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .optional()
      .describe("Max results (default: 100)"),
    sort: z.string().optional().describe("Sort field, e.g. period_end.desc"),
  },
  async ({ tickers, cik, timeframe, fiscal_year, fiscal_quarter, period_end, limit, sort }) => {
    const params = {};
    if (tickers) params.tickers = tickers;
    if (cik) params.cik = cik;
    if (timeframe) params.timeframe = timeframe;
    if (fiscal_year !== undefined) params.fiscal_year = fiscal_year;
    if (fiscal_quarter !== undefined) params.fiscal_quarter = fiscal_quarter;
    if (period_end) params.period_end = period_end;
    if (limit) params.limit = limit;
    if (sort) params.sort = sort;

    const data = await callApi("/stocks/financials/v1/cash-flow-statements", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_financial_ratios ────────────────────────────────────────────────
server.tool(
  "get_financial_ratios",
  "Retrieve key financial valuation and profitability ratios for stocks: P/E, P/B, P/S, EV/EBITDA, EPS, ROE, ROA, debt-to-equity, current ratio, free cash flow, market cap, and more.",
  {
    ticker: z
      .string()
      .optional()
      .describe("Ticker symbol filter, e.g. AAPL"),
    cik: z.string().optional().describe("SEC Central Index Key (CIK)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50000)
      .optional()
      .describe("Max results (default: 100)"),
    sort: z
      .string()
      .optional()
      .describe("Sort field with direction, e.g. market_cap.desc"),
  },
  async ({ ticker, cik, limit, sort }) => {
    const params = {};
    if (ticker) params.ticker = ticker;
    if (cik) params.cik = cik;
    if (limit) params.limit = limit;
    if (sort) params.sort = sort;

    const data = await callApi("/stocks/financials/v1/ratios", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Tool: get_news ────────────────────────────────────────────────────────────
server.tool(
  "get_news",
  "Retrieve the most recent financial news articles for a ticker or the market. Includes article title, description, URL, publisher, keywords, publication date, and AI-generated sentiment analysis per mentioned ticker.",
  {
    ticker: z
      .string()
      .optional()
      .describe("Filter news by ticker symbol, e.g. AAPL"),
    published_utc: z
      .string()
      .optional()
      .describe(
        "Filter articles published on or after this date (ISO 8601 / RFC 3339)"
      ),
    "published_utc.gte": z
      .string()
      .optional()
      .describe("Published on or after date (ISO 8601)"),
    "published_utc.lte": z
      .string()
      .optional()
      .describe("Published on or before date (ISO 8601)"),
    order: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort order by publication date"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max articles to return (default: 10, max: 1000)"),
    sort: z
      .string()
      .optional()
      .describe("Sort field, e.g. published_utc"),
  },
  async ({ ticker, published_utc, order, limit, sort, ...rest }) => {
    const params = {};
    if (ticker) params.ticker = ticker;
    if (published_utc) params.published_utc = published_utc;
    if (rest["published_utc.gte"]) params["published_utc.gte"] = rest["published_utc.gte"];
    if (rest["published_utc.lte"]) params["published_utc.lte"] = rest["published_utc.lte"];
    if (order) params.order = order;
    if (limit) params.limit = limit;
    if (sort) params.sort = sort;

    const data = await callApi("/v2/reference/news", params);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

  return server;
}

// ── Express / StreamableHTTP transport ───────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Request logger middleware ─────────────────────────────────────────────────
app.use((req, res, next) => {
  if (DEBUG_LEVEL === "silent") return next();

  const start = Date.now();
  const ts = new Date().toISOString();

  if (DEBUG_LEVEL === "verbose") {
    const headers = { ...req.headers };
    if (headers.authorization) headers.authorization = "Bearer [REDACTED]";
    console.log(`[${ts}] --> ${req.method} ${req.originalUrl}`);
    console.log(`         headers: ${JSON.stringify(headers)}`);
    if (req.body && Object.keys(req.body).length > 0) {
      const body = { ...req.body };
      if (body.client_secret) body.client_secret = "[REDACTED]";
      console.log(`         body:    ${JSON.stringify(body)}`);
    }
  }

  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[${ts}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });

  next();
});

// ── In-memory auth code store { code → { client_id, redirect_uri, challenge, expires_at } }
const authCodes = new Map();

// ── OAuth 2.0 – Server metadata (RFC 8414) ────────────────────────────────────
// Claude.ai fetches this endpoint to discover authorization_endpoint and token_endpoint.
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const base = PUBLIC_URL;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    grant_types_supported: ["authorization_code", "client_credentials"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
});

// ── OAuth 2.0 – Authorization endpoint (RFC 6749 §4.1 + PKCE RFC 7636) ───────
// Claude.ai redirects the user here with client_id, redirect_uri, code_challenge.
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = req.query;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (client_id !== OAUTH_CLIENT_ID) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (!redirect_uri) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is required." });
    return;
  }

  // Generate a one-time authorization code (5-minute TTL)
  const code = crypto.randomBytes(32).toString("hex");
  authCodes.set(code, {
    client_id,
    redirect_uri,
    challenge: code_challenge ?? null,
    challenge_method: code_challenge_method ?? null,
    expires_at: Date.now() + 5 * 60 * 1000,
  });

  // Auto-approve and redirect back to Claude.ai with the code.
  const target = new URL(redirect_uri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  res.redirect(target.toString());
});

// ── OAuth 2.0 – Token endpoint (authorization_code + client_credentials) ──────
app.post("/token", (req, res) => {
  const { grant_type, client_id, client_secret, code, redirect_uri, code_verifier } = req.body;

  // ── Client Credentials (machine-to-machine) ──────────────────────────────
  if (grant_type === "client_credentials") {
    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
      res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_client"').json({ error: "invalid_client" });
      return;
    }
    const token = jwt.sign({ sub: client_id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL });
    return;
  }

  // ── Authorization Code (Claude.ai flow) ──────────────────────────────────
  if (grant_type === "authorization_code") {
    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) {
      res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_client"').json({ error: "invalid_client" });
      return;
    }

    const stored = authCodes.get(code);
    if (
      !stored ||
      stored.client_id !== client_id ||
      stored.expires_at < Date.now() ||
      (stored.redirect_uri && stored.redirect_uri !== redirect_uri)
    ) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // Verify PKCE code_verifier when a challenge was provided
    if (stored.challenge) {
      if (!code_verifier) {
        res.status(400).json({ error: "invalid_grant", error_description: "code_verifier is required." });
        return;
      }
      const digest = crypto.createHash("sha256").update(code_verifier).digest("base64url");
      if (digest !== stored.challenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch." });
        return;
      }
    }

    authCodes.delete(code); // single-use
    const token = jwt.sign({ sub: client_id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// ── OAuth middleware – validates Bearer JWT on protected routes ───────────────
function requireOAuth(req, res, next) {
  const bearer = req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  if (!bearer) {
    // Return the metadata URL so Claude.ai can discover the OAuth server.
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer realm="mcp", resource_metadata="${PUBLIC_URL}/.well-known/oauth-authorization-server"`
      )
      .json({ error: "unauthorized", error_description: "Missing Authorization: Bearer <token> header." });
    return;
  }

  try {
    jwt.verify(bearer, JWT_SECRET);
    next();
  } catch {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="mcp", error="invalid_token"')
      .json({ error: "invalid_token", error_description: "Access token is invalid or expired." });
  }
}

// ── StreamableHTTP sessions: sessionId → transport ───────────────────────────
const transports = new Map();

// POST /  — new session (no mcp-session-id) or message on existing session
app.post("/", requireOAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  let transport = sessionId ? transports.get(sessionId) : null;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => transports.set(sid, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await createMcpServer().connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /  — open SSE stream for server→client notifications
app.get("/", requireOAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : null;

  if (!transport) {
    res.status(400).json({ error: "Invalid or missing mcp-session-id header." });
    return;
  }

  await transport.handleRequest(req, res);
});

// DELETE /  — close session
app.delete("/", requireOAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : null;

  if (transport) {
    await transport.close();
    transports.delete(sessionId);
  }

  res.status(200).end();
});

// ── Health check (public) ─────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: transports.size });
});

app.listen(PORT, () => {
  console.log(`Massive Trading Copilot MCP server running on port ${PORT}`);
  console.log(`  MCP endpoint  : ${PUBLIC_URL}/`);
  console.log(`  Authorize     : ${PUBLIC_URL}/authorize`);
  console.log(`  Token         : ${PUBLIC_URL}/token`);
  console.log(`  OAuth metadata: ${PUBLIC_URL}/.well-known/oauth-authorization-server`);
  console.log(`  Health        : ${PUBLIC_URL}/health`);
});
