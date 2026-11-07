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

function getServiceConfig() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceRoleKey || !anonKey) throw new Error('Supabase function environment is incomplete.');
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ''), serviceRoleKey, anonKey };
}

async function authorizeSupportStaff(request: Request, config: ReturnType<typeof getServiceConfig>) {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const userResponse = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.anonKey, Authorization: authorization },
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json();
  const roleUrl = new URL(`${config.supabaseUrl}/rest/v1/user_roles`);
  roleUrl.searchParams.set('profile_id', `eq.${user.id}`);
  roleUrl.searchParams.set('revoked_at', 'is.null');
  roleUrl.searchParams.set('select', 'role_name');
  roleUrl.searchParams.set('limit', '10');
  const roleResponse = await fetch(
    roleUrl,
    { headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` } },
  );
  if (!roleResponse.ok) throw new Error('Could not verify the administrator role.');
  const roles = await roleResponse.json();
  return roles.some((role: { role_name: string }) => role.role_name === 'Administrator' || role.role_name === 'IT Staff')
    ? user
    : null;
}

async function rpc(config: ReturnType<typeof getServiceConfig>, name: string, values: Record<string, unknown>) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(values),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Database request failed (${response.status}).`);
  }
}

function toHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  try {
    const config = getServiceConfig();
    const user = await authorizeSupportStaff(request, config);
    if (!user) return jsonResponse({ error: 'Administrator or IT staff access is required.' }, 403);
    const body = await request.json();
    const laptopId = String(body.laptop_id || '');
    if (!/^[\da-f-]{36}$/i.test(laptopId)) return jsonResponse({ error: 'A valid laptop ID is required.' }, 400);

    if (body.action === 'revoke') {
      await rpc(config, 'revoke_laptop_device', { p_laptop_id: laptopId, p_revoked_by: user.id });
      return jsonResponse({ message: 'Device registration revoked.' });
    }
    if (body.action !== 'register') return jsonResponse({ error: 'Choose a supported registration action.' }, 400);

    const macAddress = body.mac_address ? String(body.mac_address).trim().toUpperCase() : null;
    if (macAddress && !/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/.test(macAddress)) {
      return jsonResponse({ error: 'Enter a valid MAC address.' }, 400);
    }
    const registrationId = `DEV-${crypto.randomUUID().toUpperCase()}`;
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const credential = btoa(String.fromCharCode(...secretBytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const credentialHash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential))));
    await rpc(config, 'register_laptop_device', {
      p_laptop_id: laptopId,
      p_registration_id: registrationId,
      p_credential_hash: credentialHash,
      p_mac_address: macAddress,
      p_registered_by: user.id,
    });
    return jsonResponse({
      device_id: registrationId,
      credential,
      message: 'Registration created. Configure the authorized Windows monitoring agent with this device ID and credential.',
    });
  } catch (error) {
    console.error('Device registration request failed:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Device registration failed.' }, 400);
  }
});
