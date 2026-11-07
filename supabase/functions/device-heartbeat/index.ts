const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase function environment is incomplete.');
    const body = await request.json();
    const registrationId = String(body.device_id || '');
    const credential = String(body.credential || '');
    if (!/^DEV-[\dA-F-]{36}$/i.test(registrationId) || credential.length < 40 || credential.length > 100) {
      return jsonResponse({ error: 'Device credentials are invalid.' }, 401);
    }

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential)));
    const credentialHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_device_heartbeat`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_registration_id: registrationId, p_credential_hash: credentialHash }),
    });
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 400 && /Device registration is invalid or revoked/i.test(message)) {
        return jsonResponse({ error: 'Device registration is invalid or revoked.' }, 401);
      }
      return jsonResponse({ error: 'The heartbeat could not be recorded. Retry later.' }, 502);
    }
    return jsonResponse({ status: 'ONLINE', received_at: new Date().toISOString() });
  } catch (error) {
    console.error('Device heartbeat failed:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Device heartbeat failed.' }, 500);
  }
});
