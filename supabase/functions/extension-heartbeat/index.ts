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
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Supabase function environment is incomplete.');
    }

    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Employee authentication is required.' }, 401);
    }

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
    if (!authResponse.ok) {
      return jsonResponse({ error: 'Employee authentication is invalid or expired.' }, 401);
    }
    const user = await authResponse.json();

    const body = await request.json();
    const employeeId = String(body.employee_id || '');
    const laptopId = String(body.laptop_id || '');
    const registrationId = String(body.device_registration_id || '');
    const extensionVersion = String(body.extension_version || '');

    if (
      !/^[\da-f-]{36}$/i.test(employeeId)
      || !/^[\da-f-]{36}$/i.test(laptopId)
      || !/^DEV-[\dA-F-]{36}$/i.test(registrationId)
      || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(extensionVersion)
      || extensionVersion.length > 32
    ) {
      return jsonResponse({ error: 'Heartbeat device details are invalid.' }, 400);
    }

    const heartbeatResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/record_extension_heartbeat`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_profile_id: user.id,
        p_employee_id: employeeId,
        p_laptop_id: laptopId,
        p_registration_id: registrationId,
        p_extension_version: extensionVersion,
      }),
    });

    if (!heartbeatResponse.ok) {
      const details = await heartbeatResponse.text();
      if (/inactive or mismatched|not actively assigned|invalid or revoked|active Employee account is required|authenticated profile does not match/i.test(details)) {
        return jsonResponse({ error: 'An active Employee account on an assigned registered laptop is required.' }, 403);
      }
      console.error('Extension heartbeat database update failed:', details);
      return jsonResponse({ error: 'The heartbeat could not be recorded. Retry on the next alarm.' }, 502);
    }

    return jsonResponse({
      status: 'ONLINE',
      received_at: await heartbeatResponse.json(),
    });
  } catch (error) {
    console.error('Extension heartbeat failed:', error);
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Extension heartbeat failed.',
    }, 500);
  }
});
