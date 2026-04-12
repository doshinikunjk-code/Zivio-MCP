# Zivio MCP Trading Intelligence Server

> Pre-market gap scanner, SEC filing alerts, news sentiment, momentum alerts, and insider scanning — packaged as an MCP server for AI agents.

## 5 Tools Available

| Tool | Description |
|------|-------------|
| `gap_scan` | Pre-market gap stocks — price, gap%, volume, float, relative volume |
| `sec_alert` | SEC 8-K/S-1 filings with Gemini AI summary |
| `news_sentiment` | News headlines with BULLISH/BEARISH/NEUTRAL scoring |
| `momentum_alerts` | Live squeeze, HOD, VWAP reclaim, volume spike detection |
| `insider_scan` | Insider purchase activity sorted by transaction value |

## Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zivio-trading": {
      "url": "https://zivio-mcp-production.up.railway.app",
      "headers": {
        "x-api-key": "YOUR_API_KEY"
      }
    }
  }
}
```

## Connect to Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "zivio-trading": {
      "url": "https://zivio-mcp-production.up.railway.app",
      "headers": {
        "x-api-key": "YOUR_API_KEY"
      }
    }
  }
}
```

## Example Usage (once connected)

Ask your AI agent:
- *"Scan for pre-market gappers above 10% with volume over 500K"*
- *"Get latest 8-K filings for NVDA with summary"*
- *"What's the news sentiment for TSLA today?"*
- *"Show me recent insider buying activity"*
- *"Find all MEGA SQUEEZE momentum alerts right now"*

## Deploy on Railway

```bash
# 1. Push to GitHub
git init
git add .
git commit -m "Zivio MCP v1.0"
git remote add origin https://github.com/doshinikunjk-code/Zivio-MCP.git
git push -u origin main

# 2. Create Railway service from GitHub repo
# 3. Set environment variables (see below)
```

## Environment Variables

Set these in Railway dashboard:

```
POLYGON_KEY=your_polygon_key
SEC_API_KEY=your_sec_api_key
BENZINGA_KEY=your_benzinga_key
GEMINI_KEY=your_gemini_key
STRIPE_SECRET=your_stripe_webhook_secret
BREVO_KEY=your_brevo_api_key
VALID_KEYS=comma,separated,initial,keys
ADMIN_SECRET=your_admin_secret_for_key_generation
```

## Stripe Setup

1. Create product in Stripe: "Zivio MCP — Trading Intelligence"
2. Set price: $49/mo or $99/mo
3. Add webhook endpoint: `https://zivio-mcp-production.up.railway.app/webhooks/stripe`
4. Listen for: `checkout.session.completed`, `invoice.paid`
5. Customer pays → webhook fires → API key auto-generated → Brevo emails key to customer

## Generate Test Key (Admin)

```bash
curl -X POST https://zivio-mcp-production.up.railway.app/admin/generate-key \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

## API Reference

All tool endpoints: `POST /tools/{tool_name}`
Required header: `x-api-key: YOUR_API_KEY`

### gap_scan
```json
{
  "min_gap_pct": 5,
  "min_volume": 100000,
  "max_price": 60,
  "limit": 10
}
```

### sec_alert
```json
{
  "ticker": "AAPL",
  "form_type": "8-K",
  "hours": 24,
  "limit": 10,
  "summarize": true
}
```

### news_sentiment
```json
{
  "ticker": "TSLA",
  "limit": 10
}
```

### momentum_alerts
```json
{
  "alert_types": ["SQUEEZE", "NEW_HOD", "VOL_SPIKE"],
  "limit": 20
}
```

### insider_scan
```json
{
  "ticker": "",
  "limit": 20
}
```

---

**Subscribe:** https://zivio.ca  
**Built by:** Nikunj Doshi, Zivio
