import "dotenv/config";
import express from "express";
import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY = process.env.MASSIVE_API_KEY;
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE_URL = "https://api.massive.com";

if (!API_KEY) {
  console.error("ERROR: MASSIVE_API_KEY is not set in environment variables.");
  process.exit(1);
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

// ── MCP server ────────────────────────────────────────────────────────────────
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

// ── Express / SSE transport ───────────────────────────────────────────────────
const app = express();
app.use(express.json());

/** Map of sessionId → SSEServerTransport (one per connected client) */
const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(400).json({ error: `No active SSE session for id: ${sessionId}` });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: transports.size });
});

app.listen(PORT, () => {
  console.log(`Massive Trading Copilot MCP server running on port ${PORT}`);
  console.log(`  SSE endpoint : http://localhost:${PORT}/sse`);
  console.log(`  Messages     : http://localhost:${PORT}/messages`);
  console.log(`  Health       : http://localhost:${PORT}/health`);
});
