// netlify/functions/save-preferences.js
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
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
      body: '',
    };
  }

  const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const sbKey = process.env.SUPABASE_SERVICE_KEY || '';

  if (!sbUrl || !sbKey) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Supabase not configured' }) };
  }

  const sbHeaders = {
    'apikey': sbKey,
    'Authorization': `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };

  // ── GET: return current preferences ──
  if (event.httpMethod === 'GET') {
    try {
      const res = await fetch(`${sbUrl}/rest/v1/user_preferences?user_id=eq.reece&limit=1`, {
        headers: sbHeaders,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.warn('[save-preferences] GET failed:', res.status, err.slice(0, 200));
        return { statusCode: 200, headers: CORS, body: JSON.stringify(null) };
      }
      const rows = await res.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify(Array.isArray(rows) && rows.length ? rows[0] : null) };
    } catch (e) {
      console.warn('[save-preferences] GET exception:', e.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify(null) };
    }
  }

  // ── POST: upsert preferences ──
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const prefs = { ...body, user_id: 'reece' };

    try {
      const res = await fetch(`${sbUrl}/rest/v1/user_preferences?on_conflict=user_id`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.warn('[save-preferences] POST failed:', res.status, err.slice(0, 200));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: err.slice(0, 120) }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      console.warn('[save-preferences] POST exception:', e.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
