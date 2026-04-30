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

    const { messages, system } = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        system,
        messages,
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
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ error: true, message: 'API error: ' + e.message }),
    };
  }
};
