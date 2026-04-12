const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3100;
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// ZIVIO MCP SERVER — Trading Intelligence Layer
// Exposes gap scanner, SEC alerts, news sentiment as MCP tools
// Gated behind API key auth — Stripe webhook provisions keys
// ═══════════════════════════════════════════════════════════════

const POLYGON_KEY   = process.env.POLYGON_KEY   || 'mxAvet_qol5lXcIth14Hn8qviQS4p3Qj';
const SEC_API_KEY   = process.env.SEC_API_KEY   || '6a55a853d1d719d34ddf858d9706bdf3ef1188362483c458909c41158a089524';
const BENZINGA_KEY  = process.env.BENZINGA_KEY  || '49k3R513d89itAXMocZtrZVNOdmuSX17';
const GEMINI_KEY    = process.env.GEMINI_KEY    || 'AIzaSyC5mLY_5v-7YqOvJcPqNnbXsCyz47j9Txc';
const STRIPE_SECRET = process.env.STRIPE_SECRET || '';
const BREVO_KEY     = process.env.BREVO_KEY     || '';

// ── PERSISTENT KEY STORAGE ────────────────────────────────────
// Keys stored in keys.json — survives Railway redeploys
const KEYS_FILE = path.join(__dirname, 'keys.json');

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
      return new Set(data.keys || []);
    }
  } catch(e) { console.error('[KEYS] Load error:', e.message); }
  return new Set();
}

function saveKeys(keySet) {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: [...keySet], updated: new Date().toISOString() }, null, 2));
  } catch(e) { console.error('[KEYS] Save error:', e.message); }
}

// Load keys from file + seed from env
let validKeys = loadKeys();
// Also add any keys from VALID_KEYS env variable
(process.env.VALID_KEYS || '').split(',').map(k => k.trim()).filter(Boolean).forEach(k => validKeys.add(k));
console.log('[KEYS] Loaded', validKeys.size, 'keys from storage');

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !validKeys.has(apiKey)) {
    return res.status(401).json({
      error: 'Invalid or missing API key',
      hint: 'Subscribe at https://zivio.ca to get your API key'
    });
  }
  next();
}

// ── CORS (allow all MCP clients) ─────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════════════════════════
// MCP MANIFEST — tells AI agents what tools are available
// GET /.well-known/mcp — public, no auth needed
// ═══════════════════════════════════════════════════════════════
app.get('/.well-known/mcp', (req, res) => {
  res.json({
    schema_version: '1.0',
    name: 'zivio-trading-intelligence',
    display_name: 'Zivio Trading Intelligence',
    description: 'Pre-market gap scanner, SEC filing alerts, and news sentiment — processed trading intelligence for AI agents',
    version: '1.0.0',
    auth: {
      type: 'api_key',
      header: 'x-api-key',
      instructions: 'Get your API key at https://zivio.ca'
    },
    tools: [
      {
        name: 'gap_scan',
        description: 'Scan for pre-market gap stocks. Returns top gappers with price, gap%, volume, float, and relative volume. Filtered for $1-$60 range.',
        input_schema: {
          type: 'object',
          properties: {
            min_gap_pct: { type: 'number', description: 'Minimum gap percentage (default: 5)', default: 5 },
            min_volume: { type: 'number', description: 'Minimum volume (default: 100000)', default: 100000 },
            max_price: { type: 'number', description: 'Maximum stock price (default: 60)', default: 60 },
            limit: { type: 'number', description: 'Number of results (default: 10, max: 30)', default: 10 }
          }
        }
      },
      {
        name: 'sec_alert',
        description: 'Fetch latest SEC filings (8-K, S-1, 10-Q etc) for a ticker or scan recent high-value catalysts. Returns filing details with AI-generated summary.',
        input_schema: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'Stock ticker symbol (e.g. AAPL). Leave empty to scan all recent catalysts.' },
            form_type: { type: 'string', description: 'SEC form type: 8-K, S-1, 10-Q, 10-K (default: 8-K)', default: '8-K' },
            hours: { type: 'number', description: 'Look back N hours (default: 24)', default: 24 },
            limit: { type: 'number', description: 'Number of results (default: 10)', default: 10 },
            summarize: { type: 'boolean', description: 'Include AI summary of filing (default: true)', default: true }
          }
        }
      },
      {
        name: 'news_sentiment',
        description: 'Get latest news headlines for a ticker with sentiment scoring. Returns bullish/bearish/neutral rating per headline.',
        input_schema: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'Stock ticker symbol (e.g. TSLA)', required: true },
            limit: { type: 'number', description: 'Number of headlines (default: 10)', default: 10 }
          },
          required: ['ticker']
        }
      },
      {
        name: 'momentum_alerts',
        description: 'Get real-time momentum alerts — squeeze breakouts, new highs of day, VWAP reclaims, volume spikes. Live data from market hours.',
        input_schema: {
          type: 'object',
          properties: {
            alert_types: {
              type: 'array',
              items: { type: 'string', enum: ['SQUEEZE', 'MEGA_SQUEEZE', 'NEW_HOD', 'VOL_SPIKE', 'LOW_FLOAT', 'VWAP_RECLAIM'] },
              description: 'Filter by alert types. Empty = all types.'
            },
            limit: { type: 'number', description: 'Number of alerts (default: 20)', default: 20 }
          }
        }
      },
      {
        name: 'insider_scan',
        description: 'Scan for recent insider buying activity. Returns insider purchases sorted by transaction value — the smart money signal.',
        input_schema: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'Filter by ticker. Leave empty to scan all recent insider buys.' },
            limit: { type: 'number', description: 'Number of results (default: 20)', default: 20 }
          }
        }
      }
    ]
  });
});

// ═══════════════════════════════════════════════════════════════
// TOOL: gap_scan — GET version for browser testing
// GET /tools/gap_scan/:apikey
// ═══════════════════════════════════════════════════════════════
app.get('/tools/gap_scan/:apikey', async (req, res) => {
  if (!validKeys.has(req.params.apikey)) return res.status(401).json({ error: 'Invalid API key' });
  try {
    const PKEY = process.env.POLYGON_KEY || 'mxAvet_qol5lXcIth14Hn8qviQS4p3Qj';
    // Use previous day grouped aggregates — works on all Polygon plans
    const today = new Date();
    today.setDate(today.getDate() - 1);
    const date = today.toISOString().split('T')[0];
    const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${PKEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.results?.length) return res.json({ tool: 'gap_scan', results: [], message: 'No data', raw: data });
    const results = data.results
      .filter(t => t.o>0 && t.c>0 && t.c>=1 && t.c<=60 && t.v>=100000)
      .map(t => ({ ticker: t.T, price: +t.c.toFixed(2), open: +t.o.toFixed(2), gap_pct: +((t.c-t.o)/t.o*100).toFixed(1), volume: t.v, high: t.h, low: t.l, vwap: t.vw||0 }))
      .filter(t => t.gap_pct >= 5)
      .sort((a,b) => b.gap_pct - a.gap_pct)
      .slice(0, 10);
    res.json({ tool: 'gap_scan', date, count: results.length, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// TOOL: gap_scan
// POST /tools/gap_scan
// ═══════════════════════════════════════════════════════════════
app.post('/tools/gap_scan', authMiddleware, async (req, res) => {
  try {
    const { min_gap_pct = 5, min_volume = 100000, max_price = 60, limit = 10 } = req.body;

    // Use snapshot for specific tickers — works on all Polygon premium plans
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLYGON_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Polygon API error: ' + resp.status);
    const data = await resp.json();

    if (!data.tickers?.length) {
      return res.json({ tool: 'gap_scan', results: [], message: 'No snapshot data available' });
    }

    const results = data.tickers
      .filter(t => {
        const price = t.lastTrade?.p || t.day?.c || 0;
        const prevClose = t.prevDay?.c || 0;
        const volume = t.day?.v || 0;
        const gapPct = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
        return price >= 1 && price <= max_price && gapPct >= min_gap_pct && volume >= min_volume;
      })
      .map(t => {
        const price = t.lastTrade?.p || t.day?.c || 0;
        const prevClose = t.prevDay?.c || 0;
        const volume = t.day?.v || 0;
        const gapPct = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
        const avgVol = t.min?.av || 0;
        const relVol = avgVol > 0 ? (volume / avgVol) : 0;
        return {
          ticker: t.ticker,
          price: parseFloat(price.toFixed(2)),
          prev_close: parseFloat(prevClose.toFixed(2)),
          gap_pct: parseFloat(gapPct.toFixed(1)),
          volume,
          avg_volume: avgVol,
          relative_volume: parseFloat(relVol.toFixed(1)),
          vwap: t.day?.vw || 0,
          high: t.day?.h || 0,
          low: t.day?.l || 0
        };
      })
      .sort((a, b) => b.gap_pct - a.gap_pct)
      .slice(0, Math.min(limit, 30));

    res.json({
      tool: 'gap_scan',
      timestamp: new Date().toISOString(),
      count: results.length,
      filters: { min_gap_pct, min_volume, max_price },
      results
    });

  } catch (e) {
    console.error('[gap_scan] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TOOL: sec_alert — GET version for browser testing
// GET /tools/sec_alert/:apikey
// ═══════════════════════════════════════════════════════════════
app.get('/tools/sec_alert/:apikey', async (req, res) => {
  if (!validKeys.has(req.params.apikey)) return res.status(401).json({ error: 'Invalid API key' });
  try {
    const SKEY = process.env.SEC_API_KEY || '6a55a853d1d719d34ddf858d9706bdf3ef1188362483c458909c41158a089524';
    const secResp = await fetch('https://api.sec-api.io?token=' + SKEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { query_string: { query: 'formType:"8-K" AND filedAt:{now-72h TO now}' } },
        from: '0', size: '5',
        sort: [{ filedAt: { order: 'desc' } }]
      })
    });
    const data = await secResp.json();
    const filings = (data.filings || []).map(f => ({
      ticker: f.ticker, company: f.companyName,
      form_type: f.formType, filed_at: f.filedAt,
      description: f.description
    }));
    res.json({ tool: 'sec_alert', count: filings.length, results: filings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// TOOL: sec_alert
// POST /tools/sec_alert
// ═══════════════════════════════════════════════════════════════
app.post('/tools/sec_alert', authMiddleware, async (req, res) => {
  try {
    const { ticker = '', form_type = '8-K', hours = 24, limit = 10, summarize = true } = req.body;

    // Build SEC query
    let query = `formType:"${form_type}" AND filedAt:{now-${hours}h TO now}`;
    if (ticker) query = `ticker:"${ticker.toUpperCase()}" AND ` + query;

    const secResp = await fetch('https://api.sec-api.io?token=' + SEC_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: { query_string: { query } },
        from: '0',
        size: String(Math.min(limit, 20)),
        sort: [{ filedAt: { order: 'desc' } }]
      })
    });
    const secData = await secResp.json();
    const filings = secData.filings || [];

    // Optionally summarize each filing with Gemini
    const results = await Promise.all(filings.map(async (f) => {
      const base = {
        ticker: f.ticker || '',
        company: f.companyName || '',
        form_type: f.formType || '',
        filed_at: f.filedAt || '',
        description: f.description || '',
        url: f.linkToFilingDetails || f.linkToHtmlAnnouncement || ''
      };

      if (summarize && f.description) {
        try {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
          const gemResp = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `You are a trading analyst. Summarize this SEC ${f.formType} filing in 2 sentences. Focus on catalyst impact for traders. Filing: ${f.description || f.formType + ' by ' + f.companyName}`
                }]
              }],
              generationConfig: { maxOutputTokens: 100 }
            })
          });
          const gemData = await gemResp.json();
          base.ai_summary = gemData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } catch (e) {
          base.ai_summary = '';
        }
      }

      return base;
    }));

    res.json({
      tool: 'sec_alert',
      timestamp: new Date().toISOString(),
      count: results.length,
      filters: { ticker, form_type, hours },
      results
    });

  } catch (e) {
    console.error('[sec_alert] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TOOL: news_sentiment
// POST /tools/news_sentiment
// ═══════════════════════════════════════════════════════════════
app.post('/tools/news_sentiment', authMiddleware, async (req, res) => {
  try {
    const { ticker, limit = 10 } = req.body;
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const url = `https://api.polygon.io/v2/reference/news?ticker=${ticker.toUpperCase()}&limit=${Math.min(limit, 20)}&apiKey=${POLYGON_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Polygon news API error: ' + resp.status);
    const data = await resp.json();

    const articles = data.results || [];

    // Score sentiment per headline using simple keyword approach + Gemini
    const results = await Promise.all(articles.map(async (a) => {
      const base = {
        headline: a.title || '',
        publisher: a.publisher?.name || '',
        published_at: a.published_utc || '',
        url: a.article_url || '',
        tickers: a.tickers || []
      };

      // Quick keyword sentiment
      const title = (a.title || '').toLowerCase();
      const bullish = ['beats', 'surge', 'jump', 'soar', 'record', 'upgrade', 'buy', 'strong', 'gain', 'rally', 'bull', 'profit', 'growth'];
      const bearish = ['miss', 'fall', 'drop', 'plunge', 'downgrade', 'sell', 'weak', 'loss', 'crash', 'bear', 'debt', 'cut', 'layoff'];
      const bScore = bullish.filter(w => title.includes(w)).length;
      const rScore = bearish.filter(w => title.includes(w)).length;
      base.sentiment = bScore > rScore ? 'BULLISH' : rScore > bScore ? 'BEARISH' : 'NEUTRAL';
      base.sentiment_score = bScore - rScore;

      return base;
    }));

    // Overall sentiment summary
    const bullCount = results.filter(r => r.sentiment === 'BULLISH').length;
    const bearCount = results.filter(r => r.sentiment === 'BEARISH').length;
    const overall = bullCount > bearCount ? 'BULLISH' : bearCount > bullCount ? 'BEARISH' : 'NEUTRAL';

    res.json({
      tool: 'news_sentiment',
      ticker: ticker.toUpperCase(),
      timestamp: new Date().toISOString(),
      overall_sentiment: overall,
      bullish_count: bullCount,
      bearish_count: bearCount,
      neutral_count: results.length - bullCount - bearCount,
      count: results.length,
      results
    });

  } catch (e) {
    console.error('[news_sentiment] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TOOL: momentum_alerts
// POST /tools/momentum_alerts
// ═══════════════════════════════════════════════════════════════
app.post('/tools/momentum_alerts', authMiddleware, async (req, res) => {
  try {
    const { alert_types = [], limit = 20 } = req.body;

    // Pull live top gainers + snapshot for momentum context
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${POLYGON_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Polygon API error');
    const data = await resp.json();

    const tickers = (data.tickers || []).slice(0, 50);
    const alerts = [];

    for (const t of tickers) {
      const price = t.lastTrade?.p || t.day?.c || 0;
      const prevClose = t.prevDay?.c || 0;
      const volume = t.day?.v || 0;
      const avgVol = t.min?.av || 0;
      const vwap = t.day?.vw || 0;
      const high = t.day?.h || 0;
      const relVol = avgVol > 0 ? volume / avgVol : 0;
      const changePct = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;

      if (price < 1 || price > 60) continue;

      // Detect alert types
      const detectedTypes = [];
      if (changePct >= 20) detectedTypes.push('MEGA_SQUEEZE');
      else if (changePct >= 10) detectedTypes.push('SQUEEZE');
      if (price >= high * 0.998) detectedTypes.push('NEW_HOD');
      if (relVol >= 5) detectedTypes.push('VOL_SPIKE');
      if (price > vwap && vwap > 0) detectedTypes.push('VWAP_RECLAIM');

      if (detectedTypes.length === 0) continue;

      // Filter by requested types
      const matchedTypes = alert_types.length > 0
        ? detectedTypes.filter(t => alert_types.includes(t))
        : detectedTypes;

      if (matchedTypes.length === 0) continue;

      alerts.push({
        ticker: t.ticker,
        price: parseFloat(price.toFixed(2)),
        change_pct: parseFloat(changePct.toFixed(1)),
        volume,
        relative_volume: parseFloat(relVol.toFixed(1)),
        vwap: parseFloat(vwap.toFixed(2)),
        high_of_day: parseFloat(high.toFixed(2)),
        alert_types: matchedTypes
      });
    }

    // Sort by change_pct descending
    alerts.sort((a, b) => b.change_pct - a.change_pct);

    res.json({
      tool: 'momentum_alerts',
      timestamp: new Date().toISOString(),
      count: alerts.slice(0, limit).length,
      results: alerts.slice(0, limit)
    });

  } catch (e) {
    console.error('[momentum_alerts] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// TOOL: insider_scan
// POST /tools/insider_scan
// ═══════════════════════════════════════════════════════════════
app.post('/tools/insider_scan', authMiddleware, async (req, res) => {
  try {
    const { ticker = '', limit = 20 } = req.body;

    let url = `https://api.sec-api.io/insider-trading?token=${SEC_API_KEY}&transactionType=P-Purchase&limit=${Math.min(limit, 50)}&sort=-transactionValue`;
    if (ticker) url += `&ticker=${ticker.toUpperCase()}`;

    const resp = await fetch(url);
    const data = await resp.json();
    const transactions = data.data || [];

    const results = transactions.map(tx => ({
      ticker: tx.ticker || '',
      company: tx.companyName || '',
      insider_name: tx.reportingOwnerName || '',
      insider_title: tx.reportingOwnerRelationship || '',
      transaction_type: tx.transactionType || 'Purchase',
      shares: tx.numberOfShares || 0,
      price_per_share: tx.transactionPricePer || 0,
      total_value: tx.totalValue || (tx.numberOfShares * tx.transactionPricePer) || 0,
      filed_at: tx.filedAt || '',
      ownership_type: tx.ownershipType || ''
    }));

    res.json({
      tool: 'insider_scan',
      timestamp: new Date().toISOString(),
      count: results.length,
      filter: ticker || 'all',
      results
    });

  } catch (e) {
    console.error('[insider_scan] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// STRIPE WEBHOOK — auto-provision API key on payment
// POST /webhooks/stripe
// ═══════════════════════════════════════════════════════════════
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());

    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      const email = event.data?.object?.customer_details?.email
        || event.data?.object?.customer_email
        || '';

      if (email) {
        // Generate unique API key
        const newKey = 'zivio_' + crypto.randomBytes(24).toString('hex');
        validKeys.add(newKey);
        saveKeys(validKeys);

        console.log(`[STRIPE] New customer: ${email} → Key provisioned`);

        // Send key via Brevo email
        if (BREVO_KEY) {
          await sendKeyEmail(email, newKey);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      // TODO: revoke key on cancellation
      // Requires storing email→key mapping (add in v2)
      console.log('[STRIPE] Subscription cancelled — manual key revocation needed for now');
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE] Webhook error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── BREVO EMAIL — send API key to new customer ────────────────
async function sendKeyEmail(email, apiKey) {
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_KEY
      },
      body: JSON.stringify({
        sender: { name: 'Zivio', email: 'doshinikunjk@gmail.com' },
        to: [{ email }],
        subject: 'Your Zivio MCP API Key',
        htmlContent: `
          <h2>Welcome to Zivio Trading Intelligence</h2>
          <p>Your MCP server API key:</p>
          <code style="background:#f4f4f4;padding:12px;display:block;font-size:16px;">${apiKey}</code>
          <h3>Connect to Claude Desktop</h3>
          <p>Add this to your Claude Desktop MCP config:</p>
          <pre style="background:#1a1a1a;color:#00ff88;padding:12px;">{
  "mcpServers": {
    "zivio-trading": {
      "url": "https://zivio-mcp-production.up.railway.app",
      "headers": {
        "x-api-key": "${apiKey}"
      }
    }
  }
}</pre>
          <h3>Available Tools</h3>
          <ul>
            <li><strong>gap_scan</strong> — Pre-market gap scanner</li>
            <li><strong>sec_alert</strong> — SEC filing alerts with AI summary</li>
            <li><strong>news_sentiment</strong> — News sentiment scoring</li>
            <li><strong>momentum_alerts</strong> — Live squeeze/HOD/VWAP alerts</li>
            <li><strong>insider_scan</strong> — Insider buying scanner</li>
          </ul>
          <p>Questions? Reply to this email.</p>
          <p>— Nikunj, Zivio</p>
        `
      })
    });
    console.log(`[BREVO] Key email sent to ${email}`);
  } catch (e) {
    console.error('[BREVO] Email error:', e.message);
  }
}

// ── ADMIN: Generate test key (protect in production) ─────────
app.get('/admin/generate-key/:secret', (req, res) => {
  const adminSecret = req.params.secret;
  if (adminSecret !== process.env.ADMIN_SECRET && adminSecret !== 'zivio2026') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const newKey = 'zivio_' + require('crypto').randomBytes(24).toString('hex');
  validKeys.add(newKey);
  saveKeys(validKeys);
  res.json({ key: newKey, total_keys: validKeys.size });
});

app.post('/admin/generate-key', (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const newKey = 'zivio_' + crypto.randomBytes(24).toString('hex');
  validKeys.add(newKey);
  saveKeys(validKeys);
  res.json({ key: newKey, total_keys: validKeys.size });
});

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Zivio MCP Trading Intelligence',
    version: '1.0.0',
    active_keys: validKeys.size,
    tools: ['gap_scan', 'sec_alert', 'news_sentiment', 'momentum_alerts', 'insider_scan'],
    uptime: process.uptime()
  });
});

// ── ROOT ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Zivio Trading Intelligence MCP Server',
    version: '1.0.0',
    docs: 'https://github.com/doshinikunjk-code/Zivio-MCP',
    subscribe: 'https://zivio.ca',
    manifest: '/.well-known/mcp'
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Zivio MCP Trading Intelligence Server`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Tools: gap_scan, sec_alert, news_sentiment,`);
  console.log(`         momentum_alerts, insider_scan`);
  console.log(`  Active keys: ${validKeys.size}`);
  console.log(`═══════════════════════════════════════════════\n`);
});
