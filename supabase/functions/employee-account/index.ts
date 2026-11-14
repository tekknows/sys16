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

function getConfig() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new Error('Supabase function environment is incomplete.');
  }
  return { supabaseUrl, serviceRoleKey, anonKey };
}

async function authorizeAdministrator(request: Request, config: ReturnType<typeof getConfig>) {
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
  roleUrl.searchParams.set('role_name', 'eq.Administrator');
  roleUrl.searchParams.set('select', 'role_name');
  roleUrl.searchParams.set('limit', '1');
  const roleResponse = await fetch(roleUrl, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
  });
  if (!roleResponse.ok) throw new Error('Could not verify the administrator role.');
  return (await roleResponse.json()).length ? user : null;
}

async function restRequest(
  config: ReturnType<typeof getConfig>,
  path: string,
  options: RequestInit = {},
) {
  const response = await fetch(`${config.supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const responseText = await response.text();
  let body: unknown = null;
  if (responseText.trim()) {
    try {
      body = JSON.parse(responseText);
    } catch {
      body = responseText;
    }
  }
  if (!response.ok) {
    const message = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(message || `Database request failed (${response.status}).`);
  }
  return body;
}

async function deleteAuthUser(config: ReturnType<typeof getConfig>, userId: string) {
  await restRequest(config, `/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  let createdUserId: string | null = null;
  try {
    const config = getConfig();
    const admin = await authorizeAdministrator(request, config);
    if (!admin) return jsonResponse({ error: 'Administrator access is required.' }, 403);

    const body = await request.json();
    if (body.action === 'reset_password') {
      const userId = String(body.user_id || '').trim();
      const password = String(body.password || '');
      if (!userId || password.length < 8) return jsonResponse({ error: 'A valid user and password with at least 8 characters are required.' }, 400);
      await restRequest(config, `/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      });
      return jsonResponse({ user_id: userId, password, message: 'Employee password reset.' });
    }
    if (body.action === 'delete_employee') {
      const userId = String(body.user_id || '').trim();
      if (!userId) return jsonResponse({ error: 'A valid employee user is required.' }, 400);
      await restRequest(config, `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      await deleteAuthUser(config, userId);
      return jsonResponse({ user_id: userId, message: 'Employee account deleted.' });
    }
    if (body.action) return jsonResponse({ error: 'Unsupported employee account action.' }, 400);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const fullName = String(body.full_name || '').trim();
    const department = String(body.department || '').trim();
    const position = String(body.position || '').trim();
    const role = String(body.role || 'Employee');
    const active = body.active !== false;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400);
    if (password.length < 8) return jsonResponse({ error: 'Use a temporary password with at least 8 characters.' }, 400);
    if (!fullName || !department || !position) return jsonResponse({ error: 'Name, department, and job title are required.' }, 400);
    if (!['Employee', 'IT Staff', 'Administrator'].includes(role)) return jsonResponse({ error: 'Invalid account role.' }, 400);
    const authResponse = await restRequest(config, '/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
    });
    createdUserId = authResponse.id;

    await restRequest(config, '/rest/v1/profiles', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: createdUserId,
        full_name: fullName,
        email,
        department,
        position,
        account_status: active ? 'Active' : 'Suspended',
      }),
    });
    const employee = await restRequest(config, '/rest/v1/employees?select=user_id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ profile_id: createdUserId, department, position, active }),
    });
    await restRequest(config, '/rest/v1/user_roles', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        profile_id: createdUserId,
        role_name: role,
        assigned_by: admin.id,
        revoked_at: null,
      }),
    });

    return jsonResponse({ user_id: employee[0]?.user_id || null, message: 'Employee account created.' });
  } catch (error) {
    if (createdUserId) {
      try {
        await deleteAuthUser(getConfig(), createdUserId);
      } catch (cleanupError) {
        console.error('Employee account cleanup failed:', cleanupError);
      }
    }
    console.error('Employee account creation failed:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'Employee account creation failed.' }, 400);
  }
});
