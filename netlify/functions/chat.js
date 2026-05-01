exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'Method not allowed' }),
    };
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ error: true, message: 'API key not configured' }),
      };
    }

    const { messages } = JSON.parse(event.body);

    // Limit to last 8 messages server-side
    const trimmedMessages = Array.isArray(messages) ? messages.slice(-8) : [];

    // ── Check for direct "save to knowledge base:" command ──
    const lastMsg = trimmedMessages[trimmedMessages.length - 1];
    const lastText = lastMsg && lastMsg.role === 'user'
      ? (typeof lastMsg.content === 'string'
          ? lastMsg.content
          : (lastMsg.content.find(b => b.type === 'text')?.text || ''))
      : '';

    const KB_PREFIX_RE = /^save\s+to\s+knowledge\s+base\s*:\s*/i;
    if (KB_PREFIX_RE.test(lastText.trim())) {
      const payload = lastText.trim().replace(KB_PREFIX_RE, '');
      directSaveToKB(payload).catch(e =>
        console.warn('[kb-direct] save failed:', e.message)
      );
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ text: '✅ Saving that directly to the knowledge base now. It will be available in the next message.' }),
      };
    }

    // ── Fetch KB + properties in parallel from Supabase ──
    const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
    const sbHeaders = {
      'apikey': sbKey,
      'Authorization': `Bearer ${sbKey}`,
    };

    let kbRows = [];
    let properties = [];
    let marketData = [];

    if (sbUrl && sbKey) {
      const [kbRes, propsRes, mdRes] = await Promise.allSettled([
        fetch(`${sbUrl}/rest/v1/knowledge_base?select=*&order=category.asc`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/properties?select=*&archived=eq.false&order=created_at.desc`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/market_data?select=*&order=state.asc,county.asc`, { headers: sbHeaders }),
      ]);

      if (kbRes.status === 'fulfilled' && kbRes.value.ok) {
        try { kbRows = await kbRes.value.json(); } catch {}
      } else {
        console.warn('[chat] KB fetch failed:', kbRes.reason || kbRes.value?.status);
      }

      if (propsRes.status === 'fulfilled' && propsRes.value.ok) {
        try { properties = await propsRes.value.json(); } catch {}
      } else {
        console.warn('[chat] Properties fetch failed:', propsRes.reason || propsRes.value?.status);
      }

      if (mdRes.status === 'fulfilled' && mdRes.value.ok) {
        try { marketData = await mdRes.value.json(); } catch {}
      } else {
        console.warn('[chat] Market data fetch failed:', mdRes.reason || mdRes.value?.status);
      }
    }

    // ── Format knowledge base ──
    function formatKB(rows) {
      if (!Array.isArray(rows) || !rows.length) return '(none)';
      const grouped = {};
      rows.forEach(r => {
        const cat = r.category || 'General';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(`  ${r.key}: ${r.value}`);
      });
      return Object.entries(grouped)
        .map(([cat, items]) => `${cat}:\n${items.join('\n')}`)
        .join('\n\n');
    }

    // ── Format properties ──
    function formatProperties(rows) {
      if (!Array.isArray(rows) || !rows.length) return '(none)';
      return rows.map(p => {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || '—';
        const addr = [p.address, p.city, p.county, p.state].filter(Boolean).join(', ') || '—';
        const acres = p.acres ? `${p.acres}ac` : '—';
        const status = p.status || '—';
        const arv = p.arv ? `$${p.arv}` : '—';
        const offer = p.offer_amount ? `$${p.offer_amount}` : '—';
        return `${name} | ${addr} | ${acres} | Status: ${status} | ARV: ${arv} | Offer: ${offer}`;
      }).join('\n');
    }

    // ── Format market data ──
    function formatMarketData(rows) {
      if (!Array.isArray(rows) || !rows.length) return '(none)';
      // Group by state → county
      const byState = {};
      rows.forEach(r => {
        const st = r.state || 'Unknown';
        const geo = r.county || r.city || r.zip_code || r.geography_type || '—';
        if (!byState[st]) byState[st] = [];
        const parts = [geo];
        if (r.median_ppa != null)  parts.push(`PPA: $${r.median_ppa}/ac`);
        if (r.sales_count != null) parts.push(`Sales: ${r.sales_count}`);
        if (r.median_dom != null)  parts.push(`DOM: ${r.median_dom}d`);
        if (r.trend)               parts.push(`Trend: ${r.trend}`);
        if (r.tier)                parts.push(`Tier: ${r.tier}`);
        if (r.notes)               parts.push(`Notes: ${r.notes}`);
        byState[st].push('  ' + parts.join(' | '));
      });
      return Object.entries(byState)
        .map(([state, lines]) => `${state}:\n${lines.join('\n')}`)
        .join('\n\n');
    }

    // ── Build dynamic system prompt ──
    const system = `You are the Coldwater Assistant — permanent AI consigliere for Reece Smith, owner of Coldwater Property Group LLC. The knowledge base below contains his exact business rules — these always override your general training.

KNOWLEDGE BASE:
${formatKB(kbRows)}

ACTIVE PIPELINE:
${formatProperties(properties)}

MARKET DATA:
${formatMarketData(marketData)}

RULES:
- Knowledge base always wins over general real estate knowledge
- Opening offer = ARV x 0.35, MAO = ARV x 0.50, never exceed MAO
- Raw vacant land only — never mention repair costs or rehab
- Be direct and specific`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system,
        messages: trimmedMessages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ error: true, message: 'API error: ' + (data.error?.message || response.statusText) }),
      };
    }

    const text = data.content?.[0]?.text || '';

    // ── Background knowledge extraction (fire-and-forget) ──
    extractAndSaveKnowledge(trimmedMessages, text).catch(e =>
      console.warn('[kb-extract] background task failed:', e.message)
    );

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'API error: ' + e.message }),
    };
  }
};

// ── Direct KB save (bypasses AI extraction) ──────────────────────────────────
async function directSaveToKB(rawText) {
  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!sbUrl || !sbKey) return;

  // Use Haiku to parse the raw text into structured KB entries
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: 'You are a knowledge extraction agent for a land investment business. The user is directly telling you what to save. Parse ALL of the provided text into structured knowledge base entries. Extract every piece of data — market statistics, price per acre, county data, contact info, procedures, deal criteria, anything. Return a JSON array of objects with fields: category, key, value. The value field should contain the complete data verbatim — do not summarize or truncate. Never return []. Find a way to structure everything provided.',
      messages: [{ role: 'user', content: rawText }],
    }),
  });

  if (!res.ok) {
    console.warn('[kb-direct] Haiku parse failed:', res.status);
    return;
  }
  const result = await res.json();
  const raw = result.content?.[0]?.text || '[]';
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return;
  let items;
  try { items = JSON.parse(match[0]); } catch { return; }
  if (!Array.isArray(items) || !items.length) return;

  await batchUpsertKB(items);
  console.log('[kb-direct] saved', items.length, 'entries');
}

// ── Knowledge extraction ──────────────────────────────────────────────────────
async function extractAndSaveKnowledge(messages, assistantReply) {
  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!sbUrl || !sbKey) return;

  // Build exchange text from last 4 messages (2 exchanges) + assistant reply
  const last4 = messages.slice(-4);
  const exchangeLines = last4.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = typeof m.content === 'string'
      ? m.content
      : (m.content.find(b => b.type === 'text')?.text || '');
    return `${role}: ${text}`;
  });
  exchangeLines.push(`Assistant: ${assistantReply}`);
  const exchange = exchangeLines.join('\n\n');

  if (!exchange.trim()) return;

  // Call Haiku for extraction
  let extracted = [];
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: 'You are a knowledge extraction agent for a land investment business. Review the ENTIRE conversation exchange and extract ALL specific data worth saving permanently. Be comprehensive, not selective. Save everything including: market data, county statistics, price per acre figures, days on market, sales volume, property addresses, APNs, offer calculations, funder criteria, contact information, operational procedures, and deal outcomes. Return a JSON array of objects with fields: category, key, value. The value field should contain the complete data — do not summarize or truncate. Return [] only if there is genuinely nothing new. When in doubt, save it.',
        messages: [{ role: 'user', content: exchange }],
      }),
    });
    if (!res.ok) return;
    const result = await res.json();
    const raw = result.content?.[0]?.text || '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    extracted = JSON.parse(match[0]);
    if (!Array.isArray(extracted) || !extracted.length) return;
  } catch (e) {
    console.warn('[kb-extract] Extraction API call failed:', e.message);
    return;
  }

  await batchUpsertKB(extracted);
  console.log('[kb-extract] saved', extracted.length, 'entries');
}

// ── Batch upsert to knowledge_base ───────────────────────────────────────────
async function batchUpsertKB(items) {
  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!sbUrl || !sbKey) return;

  const valid = items.filter(({ category, key, value }) => category && key && value);
  if (!valid.length) return;

  try {
    const r = await fetch(`${sbUrl}/rest/v1/knowledge_base?on_conflict=category,key`, {
      method: 'POST',
      headers: {
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(valid),
    });
    if (!r.ok) {
      console.warn('[kb-upsert] Batch upsert failed:', r.status, await r.text());
    }
  } catch (e) {
    console.warn('[kb-upsert] Batch upsert error:', e.message);
  }
}
