import { getJson, getTx, isAddress, rpc } from "./core.js";
import { assess, gather } from "./assess.js";
import { load, screen } from "./screen.js";
import { findPools, loadTrades, summarize } from "./whales.js";
import { parseWalletTx, tokenInfo } from "./swaps.js";
import { fetchHolders, summarize as holderSummary } from "./holders.js";

const SITE = "https://blixvip.com";
const mintArg = { mint: { type: "string", description: "Solana token mint address (base58)." } };
const need = (v, name) => { if (!isAddress(v)) throw new Error(`${name} must be a Solana address.`); return v; };
const round = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Number(Number(n).toFixed(d)));

/** Every tool: name, description, JSON schema, and handler returning plain JSON. */
export const TOOLS = [
  {
    name: "token_info",
    title: "Token Info",
    description: "Price, market cap, liquidity, volume, price change and age for a Solana token, from its deepest DEX pool.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: { type: "object", properties: mintArg, required: ["mint"] },
    async run({ mint }) {
      need(mint, "mint");
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
      const p = (Array.isArray(pairs) ? pairs : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (!p) return { mint, found: false, note: "No DEX pool found. A pump.fun coin may still be on its bonding curve." };
      return {
        mint, found: true, name: p.baseToken.name, symbol: p.baseToken.symbol, dex: p.dexId, pool: p.pairAddress,
        priceUsd: Number(p.priceUsd) || null, marketCapUsd: p.marketCap ?? p.fdv ?? null, liquidityUsd: p.liquidity?.usd ?? null,
        volumeUsd: p.volume, priceChangePct: p.priceChange, txns: p.txns,
        ageHours: p.pairCreatedAt ? round((Date.now() - p.pairCreatedAt) / 3600_000, 1) : null,
        links: { dexscreener: p.url, blix: `${SITE}/meme-coin-analyzer` },
      };
    },
  },
  {
    name: "rug_check",
    title: "Rug Check",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: "Rug pull risk check for a Solana token: mint and freeze authority, Token-2022 traps, holder concentration, liquidity, honeypot pattern. Returns a 0-100 risk score with findings.",
    inputSchema: { type: "object", properties: mintArg, required: ["mint"] },
    async run({ mint }) {
      need(mint, "mint");
      const data = await gather(mint);
      const r = assess(data);
      return { mint, name: data.report?.tokenMeta?.name ?? data.pair?.baseToken?.name ?? null, symbol: data.report?.tokenMeta?.symbol ?? data.pair?.baseToken?.symbol ?? null, ...r, sourcesUnavailable: data.unavailable, note: "A low score is not a guarantee." };
    },
  },
  {
    name: "top_holders",
    title: "Top Holders",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: "Top holders of a Solana token with share of supply, pool and insider labels, and concentration summary.",
    inputSchema: { type: "object", properties: { ...mintArg, limit: { type: "integer", minimum: 5, maximum: 20, default: 20 } }, required: ["mint"] },
    async run({ mint, limit = 20 }) {
      need(mint, "mint");
      const d = await fetchHolders(mint, Math.max(5, Math.min(20, limit)));
      const s = holderSummary(d.holders, []);
      return { mint, name: d.name, symbol: d.symbol, totalHolders: d.totalHolders, top10WalletPct: round(s.top10Pct), largestWalletPct: round(s.largestWalletPct), poolPct: round(s.poolPct), insiders: s.insiderCount,
        holders: d.holders.map((h) => ({ rank: h.rank, owner: h.owner, pct: round(h.pct, 3), label: h.label, insider: h.insider })) };
    },
  },
  {
    name: "screen_tokens",
    title: "Screen Tokens",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: "Screen live Solana memecoins (trending, new or boosted) by liquidity, market cap, volume, age and 1h change. Ages are in minutes.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["trending", "new", "boosted"], default: "trending" },
        minLiquidityUsd: { type: "number" }, maxMarketCapUsd: { type: "number" }, minMarketCapUsd: { type: "number" },
        minVolume24hUsd: { type: "number" }, maxAgeMinutes: { type: "number" }, minChange1hPct: { type: "number" },
        pumpOnly: { type: "boolean" }, sort: { type: "string", enum: ["vol", "vol1h", "liq", "mcap", "chg5m", "chg1h", "chg24h", "buyers", "age"], default: "vol" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
      },
    },
    async run(a = {}) {
      const rows = screen(await load(a.source || "trending", 2), {
        minLiq: a.minLiquidityUsd, maxMcap: a.maxMarketCapUsd, minMcap: a.minMarketCapUsd, minVol: a.minVolume24hUsd,
        maxAge: a.maxAgeMinutes !== undefined ? a.maxAgeMinutes * 60_000 : undefined, minChange1h: a.minChange1hPct,
        pumpOnly: Boolean(a.pumpOnly), sort: a.sort || "vol", limit: Math.max(1, Math.min(50, a.limit || 15)),
      });
      return { source: a.source || "trending", count: rows.length, tokens: rows.map((r) => ({ ...r, ageMinutes: r.ageMs === null ? null : Math.round(r.ageMs / 60000), ageMs: undefined })) };
    },
  },
  {
    name: "whale_trades",
    title: "Whale Traders",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: "Large buys and sells on a Solana token over the last 24 hours, with net flow and the biggest net buyers and sellers.",
    inputSchema: { type: "object", properties: { ...mintArg, minUsd: { type: "number", default: 1000 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, required: ["mint"] },
    async run({ mint, minUsd = 1000, limit = 20 }) {
      need(mint, "mint");
      const token = await findPools(mint, 3);
      const trades = await loadTrades(token.pools, Math.max(1, minUsd), mint);
      const s = summarize(trades);
      const pick = (w) => ({ wallet: w.wallet, netUsd: round(w.netUsd), buyUsd: round(w.buyUsd), sellUsd: round(w.sellUsd), trades: w.buys + w.sells });
      return {
        mint, symbol: token.symbol, minUsd, buys: s.buys, sells: s.sells, buyUsd: round(s.buyUsd), sellUsd: round(s.sellUsd), netUsd: round(s.netUsd), wallets: s.wallets,
        topBuyers: s.topBuyers.slice(0, 5).map(pick), topSellers: s.topSellers.slice(0, 5).map(pick),
        recent: trades.slice(0, Math.min(100, limit)).map((t) => ({ time: new Date(t.time).toISOString(), side: t.side, usd: round(t.usd), wallet: t.wallet, signature: t.signature })),
      };
    },
  },
  {
    name: "wallet_trades",
    title: "Wallet Trades",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    description: "Recent memecoin buys and sells by a Solana wallet, read from its on-chain transactions. Slow on the public RPC (about one transaction per second).",
    inputSchema: { type: "object", properties: { wallet: { type: "string", description: "Solana wallet address." }, transactions: { type: "integer", minimum: 5, maximum: 100, default: 25 } }, required: ["wallet"] },
    async run({ wallet, transactions = 25 }) {
      need(wallet, "wallet");
      const sigs = (await rpc("getSignaturesForAddress", [wallet, { limit: Math.max(5, Math.min(100, transactions)) }])).filter((s) => !s.err);
      const trades = [];
      for (const s of sigs) {
        try { const t = parseWalletTx(await getTx(s.signature), wallet); if (t && !t.type.startsWith("transfer")) trades.push(t); } catch { /* skip unreadable */ }
      }
      const info = await tokenInfo(trades.map((t) => t.mint));
      return {
        wallet, transactionsRead: sigs.length,
        trades: trades.map((t) => ({ time: t.time ? new Date(t.time).toISOString() : null, type: t.type, mint: t.mint, symbol: info.get(t.mint)?.symbol ?? null, tokenAmount: t.tokenAmount, quote: t.quote, quoteAmount: round(t.quoteAmount, 6), signature: t.signature })),
      };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
