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
    let prefsRow = null;

    if (sbUrl && sbKey) {
      const [kbRes, propsRes, mdRes, prefsRes] = await Promise.allSettled([
        fetch(`${sbUrl}/rest/v1/knowledge_base?select=*&order=category.asc`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/properties?select=*&order=created_at.desc`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/market_data?select=*&order=state.asc,county.asc`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/user_preferences?user_id=eq.reece&limit=1`, { headers: sbHeaders }),
      ]);

      if (kbRes.status === 'fulfilled' && kbRes.value.ok) {
        try { kbRows = await kbRes.value.json(); } catch {}
      } else {
        console.warn('[chat] KB fetch failed — status:', kbRes.value?.status, '| reason:', kbRes.reason?.message || kbRes.reason || '(none)');
      }

      if (propsRes.status === 'fulfilled' && propsRes.value.ok) {
        try { properties = await propsRes.value.json(); } catch {}
      } else {
        console.warn('[chat] Properties fetch failed — status:', propsRes.value?.status, '| reason:', propsRes.reason?.message || propsRes.reason || '(none)');
      }

      if (mdRes.status === 'fulfilled') {
        const mdStatus = mdRes.value.status;
        const mdBodyText = await mdRes.value.clone().text().catch(() => '(could not read body)');
        console.log('[chat] market_data response — status:', mdStatus, '| body:', mdBodyText.slice(0, 200));
        if (mdRes.value.ok) {
          try { marketData = JSON.parse(mdBodyText); } catch (e) {
            console.warn('[chat] market_data JSON parse failed:', e.message);
          }
        }
      } else {
        console.warn('[chat] Market data fetch rejected — reason:', mdRes.reason?.message || mdRes.reason || '(none)');
      }

      if (prefsRes.status === 'fulfilled' && prefsRes.value.ok) {
        try {
          const prefsArr = await prefsRes.value.json();
          if (Array.isArray(prefsArr) && prefsArr.length) prefsRow = prefsArr[0];
        } catch {}
      }
    }

    // ── User preferences (with defaults) ──
    const userPrefs = {
      min_acres:         prefsRow?.min_acres         ?? 2,
      max_acres:         prefsRow?.max_acres         ?? 20,
      min_buildability:  prefsRow?.min_buildability  ?? 70,
      max_wetlands:      prefsRow?.max_wetlands       ?? 15,
      min_road_frontage: prefsRow?.min_road_frontage  ?? 300,
      min_dom:           prefsRow?.min_dom            ?? 0,
      max_ppa:           prefsRow?.max_ppa            ?? 25000,
      include_fema:      prefsRow?.include_fema       ?? false,
      sort_by:           prefsRow?.sort_by            ?? 'lowest_price_per_acre',
      target_states:     prefsRow?.target_states      ?? 'AR, OK',
    };
    console.log('[chat] userPrefs:', JSON.stringify(userPrefs));

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

    // ── State name → 2-letter abbreviation map ──
    const STATE_ABBR = {
      'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
      'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
      'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
      'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
      'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
      'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
      'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
      'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
      'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
      'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
      'west virginia':'WV','wisconsin':'WI','wyoming':'WY',
    };
    function toStateAbbr(s) {
      if (!s) return '';
      if (/^[A-Z]{2}$/.test(s.trim())) return s.trim(); // already abbreviated
      return (STATE_ABBR[s.trim().toLowerCase()] || s.trim()).toUpperCase();
    }

    // ── Format market data ──
    function formatMarketData(rows) {
      if (!Array.isArray(rows) || !rows.length) return '(none)';
      // Group by state → county
      const byState = {};
      rows.forEach(r => {
        const st = toStateAbbr(r.state) || 'Unknown';
        const geo = r.county || r.city || r.zip_code || r.geography_type || '—';
        if (!byState[st]) byState[st] = [];
        const parts = [geo];
        if (r.median_ppa != null)   parts.push(`PPA: $${r.median_ppa}/ac`);
        if (r.median_acres != null) parts.push(`MedianAcres: ${r.median_acres}`);
        if (r.sales_count != null)  parts.push(`Sales: ${r.sales_count}`);
        if (r.median_dom != null)   parts.push(`DOM: ${r.median_dom}d`);
        if (r.trend)                parts.push(`Trend: ${r.trend}`);
        if (r.tier)                 parts.push(`Tier: ${r.tier}`);
        if (r.notes)                parts.push(`Notes: ${r.notes}`);
        byState[st].push('  ' + parts.join(' | '));
      });
      return Object.entries(byState)
        .map(([state, lines]) => `${state}:\n${lines.join('\n')}`)
        .join('\n\n');
    }

    // ── Pre-compute price ceilings (median_ppa × median_acres × 2) ──
    function buildPriceCeilingTable(rows) {
      if (!Array.isArray(rows) || !rows.length) return '(none — use $100,000 default for all counties)';
      const lines = [];
      rows.forEach(r => {
        const county = r.county || r.city || r.geography_type;
        if (!county) return;
        const st = toStateAbbr(r.state);
        if (r.median_ppa != null && r.median_acres != null) {
          const ceiling = Math.round(r.median_ppa * r.median_acres * 2);
          lines.push(`  ${county}, ${st}: $${ceiling.toLocaleString()} (${r.median_ppa}/ac × ${r.median_acres}ac × 2)`);
        } else {
          lines.push(`  ${county}, ${st}: $100,000 (default — missing PPA or median acres)`);
        }
      });
      return lines.length ? lines.join('\n') : '(none — use $100,000 default for all counties)';
    }

    // ── Preferences-derived prompt variables ──
    const sortDisplayMap = {
      'lowest_price_per_acre': 'lowest price/acre',
      'highest_buildability': 'highest buildability',
      'longest_dom': 'longest DOM',
    };
    const sortDisplay = sortDisplayMap[userPrefs.sort_by] || userPrefs.sort_by || 'lowest price/acre';
    const domFlag = userPrefs.min_dom > 0 ? userPrefs.min_dom : 60;
    const femaLine = userPrefs.include_fema ? '' : ', no FEMA';
    const slopeRisk = 100 - userPrefs.min_buildability;

    // ── Build dynamic system prompt ──
    const system = `DATA ACCESS STATUS: Knowledge base rows loaded: ${kbRows.length}. Properties loaded: ${properties.length}. Market data rows loaded: ${marketData.length}. Preferences: ${prefsRow ? 'loaded' : 'using defaults'}.

You are the Coldwater Assistant — permanent AI consigliere for Reece Smith, owner of Coldwater Property Group LLC. The knowledge base below contains his exact business rules — these always override your general training.

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
- Be direct and specific

LAND PORTAL PROMPTS — GENERATED FROM YOUR SAVED PREFERENCES:
Current preferences: Acreage ${userPrefs.min_acres}-${userPrefs.max_acres} acres, Min buildability ${userPrefs.min_buildability}%, Max wetlands ${userPrefs.max_wetlands}%, Min road frontage ${userPrefs.min_road_frontage}ft, Min DOM ${userPrefs.min_dom}, Max PPA $${userPrefs.max_ppa}, FEMA ${userPrefs.include_fema ? 'Yes' : 'No'}, Sort by ${sortDisplay}

When Reece asks for active listings in any county, respond with ONLY this prompt — nothing else:
"Active MLS listings, [COUNTY] County [STATE ABBR], vacant land, ${userPrefs.min_acres}-${userPrefs.max_acres} acres, under $[PRICE CEILING]${femaLine}, not landlocked, no structures, no commercial. Show: address, APN, acres, list price, LP estimate, price/acre, DOM, MLS ID, buildability%, road frontage ft, wetlands Y/N, FEMA Y/N. Sort ${sortDisplay}. Flag: price cuts 90 days, DOM ${domFlag}+."

When Reece asks for market analysis on any county, respond with ONLY this prompt — nothing else:
"[COUNTY] County [STATE ABBR], vacant land sold 12 months, ${userPrefs.min_acres}-${userPrefs.max_acres} acres, exclude waterfront structures utilities paved roads. Show: median PPA, sales count, median DOM, 25th/50th/75th percentile PPA."

PRE-CALCULATED PRICE CEILINGS (median_ppa × median_acres × 2) — use exact values below:
${buildPriceCeilingTable(marketData)}

RULES FOR THESE PROMPTS:
- Never add extra fields
- Never change the format
- Never add commentary before or after
- Never create a custom prompt
- Look up the county in PRE-CALCULATED PRICE CEILINGS above and use that exact dollar value
- If the county is not listed above, use $100,000 as the default price ceiling
- STATE ABBR must always be the 2-letter USPS abbreviation — AR not Arkansas, OK not Oklahoma, TX not Texas, FL not Florida
- Keep total prompt under 400 characters always

OPPORTUNITY SCORING — AUTOMATIC:
When Reece pastes a Land Portal listing table into the conversation, immediately score every property without being asked. Use LP estimate as ARV if provided. If not provided use county median PPA x acres. Calculate gap (ARV minus list price) and score (gap divided by list price as percentage). Rate as: HOT = list price below 50% ARV, GOOD = 50-65%, MARGINAL = 65-80%, PASS = above 80%. Add risk flags: SLOPE RISK = buildability under ${slopeRisk}%, ACCESS RISK = road frontage under ${userPrefs.min_road_frontage}ft, WETLANDS RISK = wetlands over ${userPrefs.max_wetlands}%. Present ranked table sorted by score highest first with columns: Address, Acres, List Price, LP Estimate, Gap, Score, Rating, Flags. Then identify top 2-3 targets and give the Land Portal parcel detail prompt for each one.`;

    console.log('System prompt length:', system.length, 'KB rows:', kbRows.length, 'Market data rows:', marketData.length);

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

    let text = data.content?.[0]?.text || '';

    // ── Lead email detection (declared early so CRM check can skip it) ──
    const isLeadEmail = /Event:\s*(SMS|call)/i.test(lastText) || lastText.includes('letsgo@leadminingpros');

    // ── CRM command detection (blocks response — prepends status line) ──
    const CRM_COMMAND_RE = /\b(archive\s+it|mark\s+as\s+(dead|not\s+now)|update\s+(the\s+)?status|it\s+sold|it\s+closed|remove\s+from\s+pipeline|promote\s+to\s+acquisitions?|update\s+(the\s+)?offer|change\s+(the\s+)?status)\b/i;
    if (!isLeadEmail && CRM_COMMAND_RE.test(lastText)) {
      try {
        const crmResult = await executeCrmCommand(lastText, sbUrl, sbKey);
        if (crmResult.ok) {
          text = `✅ CRM updated — ${crmResult.summary}\n\n${text}`;
        } else {
          text = `⚠️ Could not find that property in the CRM — please update manually in REI Razor.\n\n${text}`;
          console.warn('[crm-cmd] failed:', crmResult.error);
        }
      } catch (e) {
        console.warn('[crm-cmd] exception:', e.message);
      }
    }

    // ── Lead auto-save (blocks response — prepends status line) ──
    if (isLeadEmail) {
      const saveResult = await saveLeadFromEmail(lastText, sbUrl, sbKey);
      if (saveResult.ok) {
        const l = saveResult.lead;
        text = `✅ Lead saved to REI Razor — ${l.first_name} ${l.last_name}, ${l.county} County ${l.state}, ${l.acres || '?'} acres. Status: ${l.status}.\n\n${text}`;
      } else {
        text = `⚠️ Lead analysis complete but CRM save failed — please add manually in REI Razor.\n\n${text}`;
        console.warn('[lead-save] failed:', saveResult.error);
      }
    }

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

// ── Lead email parser ─────────────────────────────────────────────────────────
function parseLeadEmail(raw) {
  const field = (label) => {
    const re = new RegExp(label + '[:\\s]+([^\\n]+)', 'i');
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };

  // Source / status from event type
  const isSMS  = /Event:\s*SMS/i.test(raw);
  const isCall = /Event:\s*call/i.test(raw);
  const source = isSMS ? 'Cold SMS' : isCall ? 'Lead Gen Call' : 'Cold SMS';
  const status = isSMS ? 'Call Needed' : 'Researching';

  // Name: "First Name" field — split on first space
  const fullFirst = field('First Name') || '';
  const fullLast  = field('Last Name')  || '';
  const nameParts = fullFirst.trim().split(/\s+/);
  const firstName = nameParts[0] || fullFirst || null;
  const lastName  = (nameParts.length > 1 ? nameParts.slice(1).join(' ') + ' ' : '') + fullLast;

  // Phone: strip +1, format XXX-XXX-XXXX
  let phone = field('Phone(?: Number)?') || field('Phone') || null;
  if (phone) {
    const digits = phone.replace(/\D/g, '').replace(/^1/, '');
    if (digits.length === 10) {
      phone = `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
    }
  }

  // Email
  let email = field('Email') || null;
  if (email && /none|no email/i.test(email)) email = null;

  // Address: parse street, city, state, zip from "Address" field
  const rawAddr = field('Address') || '';
  // Strip leading dashes/pipes
  const cleanAddr = rawAddr.replace(/^[\-–—|,\s]+/, '').trim();
  // Try to match "street, city, state zip" or "street city state zip"
  let street = cleanAddr, city = null, state = null, zip = null;
  const addrMatch = cleanAddr.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?/i);
  if (addrMatch) {
    street = addrMatch[1].trim();
    city   = addrMatch[2].trim();
    state  = addrMatch[3].toUpperCase();
    zip    = addrMatch[4] || null;
  } else {
    // Fallback: last two tokens may be STATE ZIP
    const tokens = cleanAddr.split(/[\s,]+/);
    const last = tokens[tokens.length - 1];
    const secondLast = tokens[tokens.length - 2];
    if (/^\d{5}$/.test(last)) {
      zip   = last;
      state = /^[A-Z]{2}$/i.test(secondLast) ? secondLast.toUpperCase() : null;
      street = tokens.slice(0, state ? -2 : -1).join(' ');
    } else if (/^[A-Z]{2}$/i.test(last)) {
      state  = last.toUpperCase();
      street = tokens.slice(0, -1).join(' ');
    }
  }

  // County
  const county = field('County') || null;

  // APN
  const apn = field('APN') || null;

  // Acres — null if N/A or empty
  let acres = field('Acres(?: \\(Land\\))?') || field('Acres') || null;
  if (acres && /n\/?a/i.test(acres)) acres = null;

  // Notes: everything after "Notes:" label
  const notesMatch = raw.match(/Notes?:\s*([\s\S]+)/i);
  const sellerNotes = notesMatch ? notesMatch[1].trim() : null;

  return {
    id: crypto.randomUUID(),
    first_name: firstName || null,
    last_name:  lastName.trim() || null,
    phone,
    email,
    address: street || null,
    city,
    county,
    state,
    zip,
    apn,
    acres,
    source,
    status,
    seller_notes: sellerNotes,
    archived: false,
    utilities: null,
    road_access: null,
    structures: null,
    landlocked: null,
    tax_delinquent: null,
    fema_checked: null,
    legal_description: null,
    slope_report_notes: null,
    slope_report_status: null,
    comp_report_notes: null,
    comp_report_status: null,
    arv: null,
    open_offer: null,
    mao: null,
    offer_amount: null,
    offer_status: null,
    seller2_name: null,
    seller2_email: null,
    seller2_phone: null,
    seller2_address: null,
    seller2_city_state_zip: null,
  };
}

async function saveLeadFromEmail(rawText, sbUrl, sbKey) {
  if (!sbUrl || !sbKey) return { ok: false, error: 'Supabase not configured' };

  let lead;
  try {
    lead = parseLeadEmail(rawText);
  } catch (e) {
    return { ok: false, error: 'Parse error: ' + e.message };
  }

  console.log('[lead-save] parsed lead:', JSON.stringify({ id: lead.id, first_name: lead.first_name, last_name: lead.last_name, phone: lead.phone, county: lead.county, state: lead.state, acres: lead.acres }));

  const SB_HEADERS_JSON = {
    'apikey': sbKey,
    'Authorization': `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };

  const [propRes, logRes] = await Promise.allSettled([
    fetch(`${sbUrl}/rest/v1/properties`, {
      method: 'POST',
      headers: {
        ...SB_HEADERS_JSON,
        'Prefer': 'resolution=merge-duplicates,return=representation',
        'on-conflict': 'id',
      },
      body: JSON.stringify(lead),
    }),
    fetch(`${sbUrl}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...SB_HEADERS_JSON, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        property_id: lead.id,
        entry: `Imported from lead email via Coldwater Assistant: ${lead.seller_notes || '(no notes)'}`,
      }),
    }),
  ]);

  const propOk = propRes.status === 'fulfilled' && propRes.value.ok;
  const logOk  = logRes.status  === 'fulfilled' && logRes.value.ok;

  if (!propOk) {
    const body = propRes.status === 'fulfilled' ? await propRes.value.text().catch(() => '') : String(propRes.reason);
    console.warn('[lead-save] properties upsert failed:', propRes.value?.status, body.slice(0, 300));
    return { ok: false, error: `properties upsert failed (${propRes.value?.status}): ${body.slice(0, 120)}` };
  }

  if (!logOk) {
    console.warn('[lead-save] activity_log insert failed:', logRes.value?.status || logRes.reason);
    // Not fatal — lead was saved, just log the warning
  }

  return { ok: true, lead };
}

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

// ── CRM command parser ────────────────────────────────────────────────────────
async function parseCrmCommand(userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'You are a CRM command parser. Extract the intended CRM action from this message and return a JSON object only, no other text. Fields: action (archive, status_update, offer_update, delete), property_search_term (name, address, or county to find the property), new_status (if status update), new_offer_amount (if offer update), archive_reason (Dead or Not Now if archiving), notes (any additional context to log). If you cannot determine the action return null.',
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) return null;
  const result = await res.json();
  const raw = result.content?.[0]?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ── CRM command executor ──────────────────────────────────────────────────────
async function executeCrmCommand(userText, sbUrl, sbKey) {
  if (!sbUrl || !sbKey) return { ok: false, error: 'Supabase not configured' };

  const cmd = await parseCrmCommand(userText);
  if (!cmd || !cmd.action || !cmd.property_search_term) {
    return { ok: false, error: 'Could not parse CRM command' };
  }
  console.log('[crm-cmd] parsed:', JSON.stringify(cmd));

  const SB_JSON = {
    'apikey': sbKey,
    'Authorization': `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };

  // ── Search for matching property ──
  const term = encodeURIComponent(`*${cmd.property_search_term}*`);
  const searchUrl = `${sbUrl}/rest/v1/properties?or=(address.ilike.${term},first_name.ilike.${term},last_name.ilike.${term},county.ilike.${term})&limit=5`;

  const searchRes = await fetch(searchUrl, {
    headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
  });
  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => '');
    console.warn('[crm-cmd] search failed:', searchRes.status, body.slice(0, 200));
    return { ok: false, error: `Search failed: ${searchRes.status}` };
  }
  const matches = await searchRes.json();
  if (!Array.isArray(matches) || !matches.length) {
    return { ok: false, error: 'No matching property found' };
  }

  const prop = matches[0];
  const propId = prop.id;
  const propAddr = [prop.address, prop.county, prop.state].filter(Boolean).join(', ') || propId;
  const propName = [prop.first_name, prop.last_name].filter(Boolean).join(' ');

  // ── Build patch payload and log entry ──
  let patch = {};
  let logEntry = '';

  if (cmd.action === 'archive') {
    const reason = (cmd.archive_reason || '').toLowerCase().includes('not now') ? 'Not Now' : 'Dead';
    patch = { archived: true, status: reason };
    logEntry = `Archived via Coldwater Assistant (${reason})${cmd.notes ? ': ' + cmd.notes : ''}`;
  } else if (cmd.action === 'status_update') {
    if (!cmd.new_status) return { ok: false, error: 'No new_status provided' };
    patch = { status: cmd.new_status };
    logEntry = `Status updated to "${cmd.new_status}" via Coldwater Assistant${cmd.notes ? ': ' + cmd.notes : ''}`;
  } else if (cmd.action === 'offer_update') {
    if (cmd.new_offer_amount) patch.offer_amount = cmd.new_offer_amount;
    if (cmd.notes) patch.offer_status = cmd.notes;
    if (!Object.keys(patch).length) return { ok: false, error: 'No offer fields to update' };
    logEntry = `Offer updated via Coldwater Assistant${cmd.new_offer_amount ? ': $' + cmd.new_offer_amount : ''}${cmd.notes ? ' — ' + cmd.notes : ''}`;
  } else {
    return { ok: false, error: `Unsupported action: ${cmd.action}` };
  }

  // ── Execute PATCH ──
  const patchRes = await fetch(`${sbUrl}/rest/v1/properties?id=eq.${propId}`, {
    method: 'PATCH',
    headers: { ...SB_JSON, 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!patchRes.ok) {
    const body = await patchRes.text().catch(() => '');
    console.warn('[crm-cmd] PATCH failed:', patchRes.status, body.slice(0, 200));
    return { ok: false, error: `PATCH failed: ${patchRes.status}` };
  }

  // ── Write activity log (fire-and-forget) ──
  fetch(`${sbUrl}/rest/v1/activity_log`, {
    method: 'POST',
    headers: { ...SB_JSON, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ property_id: propId, entry: logEntry }),
  }).catch(e => console.warn('[crm-cmd] activity_log insert failed:', e.message));

  const summary = `${propName ? propName + ' — ' : ''}${propAddr} — ${cmd.action.replace('_', ' ')}`;
  return { ok: true, summary };
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
