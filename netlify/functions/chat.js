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

    // ── Fetch KB + properties in parallel from Supabase ──
    const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
    const sbHeaders = {
      'apikey': sbKey,
      'Authorization': `Bearer ${sbKey}`,
    };

    let kbRows = [];
    let properties = [];

    if (sbUrl && sbKey) {
      const [kbRes, propsRes] = await Promise.allSettled([
        fetch(`${sbUrl}/rest/v1/knowledge_base?select=*&order=category.asc`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/properties?select=*&archived=eq.false&order=created_at.desc`, { headers: sbHeaders }),
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

    // ── Build dynamic system prompt ──
    const system = `You are the Coldwater Assistant — permanent AI consigliere for Reece Smith, owner of Coldwater Property Group LLC. The knowledge base below contains his exact business rules — these always override your general training.

KNOWLEDGE BASE:
${formatKB(kbRows)}

ACTIVE PIPELINE:
${formatProperties(properties)}

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

// ── Knowledge extraction ──────────────────────────────────────────────────────
async function extractAndSaveKnowledge(messages, assistantReply) {
  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!sbUrl || !sbKey) return; // silently skip if not configured

  // Build the exchange text from the last user message + assistant reply
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUser
    ? (typeof lastUser.content === 'string'
        ? lastUser.content
        : (lastUser.content.find(b => b.type === 'text')?.text || ''))
    : '';
  if (!userText && !assistantReply) return;

  const exchange = `User: ${userText}\n\nAssistant: ${assistantReply}`;

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
        max_tokens: 512,
        system: 'You are a knowledge extraction agent for a land investment business. Review this conversation exchange and identify any specific business rules, preferences, market insights, contact details, or operational procedures that should be permanently remembered. If you find something worth saving, respond with a JSON array of objects with fields: category, key, value. If nothing new is worth saving, respond with an empty array []. Be selective — only save genuinely new, specific, reusable information.',
        messages: [{ role: 'user', content: exchange }],
      }),
    });
    if (!res.ok) return;
    const result = await res.json();
    const raw = result.content?.[0]?.text || '[]';
    // Extract JSON array from the response (may be wrapped in markdown)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return;
    extracted = JSON.parse(match[0]);
    if (!Array.isArray(extracted) || !extracted.length) return;
  } catch (e) {
    console.warn('[kb-extract] Extraction API call failed:', e.message);
    return;
  }

  // Upsert each item to knowledge_base via Supabase
  const SB_HEADERS = {
    'apikey': sbKey,
    'Authorization': `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  };

  for (const item of extracted) {
    const { category, key, value } = item;
    if (!category || !key || !value) continue;
    try {
      const r = await fetch(`${sbUrl}/rest/v1/knowledge_base?on_conflict=category,key`, {
        method: 'POST',
        headers: SB_HEADERS,
        body: JSON.stringify({ category, key, value }),
      });
      if (!r.ok) {
        console.warn('[kb-extract] Upsert failed for', key, ':', r.status, await r.text());
      }
    } catch (e) {
      console.warn('[kb-extract] Upsert error for', key, ':', e.message);
    }
  }
}
