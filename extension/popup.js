const EXTENSION_SESSION_KEY = 'mindlock-extension-session';
let extensionSession = null;
let employeeProfile = null;
let employeeRecord = null;
let employeeRole = null;
let assignedDevice = null;
let activeTicket = null;
let ticketRefreshTimer = null;
let ticketRealtimeTimer = null;
let lastPolicySyncAt = null;
let employeeTheme = 'light';
const workSessionStorageKey = 'mindlock-work-session';
let currentWorkSchedule = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'extension-heartbeat-success' && assignedDevice && message.received_at) {
    assignedDevice.last_seen_at = message.received_at;
    updateDeviceStatus();
  }
  if (message?.type === 'extension-heartbeat-status') renderHeartbeatStatus(message.status);
});

function renderHeartbeatStatus(status) {
  const help = document.getElementById('heartbeatConnectionHelp');
  if (!help || !status?.message) return;
  help.textContent = status.message;
  help.classList.toggle('error-text', status.state === 'error');
}

function renderExtensionReleaseVersion() {
  const versionLabel = document.getElementById('extensionReleaseVersion');
  if (versionLabel) versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
}

function isSupabaseConfigured() {
  return Boolean(globalThis.MINDLOCK_CONFIG?.supabaseUrl && globalThis.MINDLOCK_CONFIG?.supabaseAnonKey);
}

function extensionStorageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function extensionStorageSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

function extensionStorageRemove(key) {
  return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
}

function apiUrl(path) {
  return `${globalThis.MINDLOCK_CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`;
}

async function authRequest(path, body) {
  const config = globalThis.MINDLOCK_CONFIG;
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.msg || result.message || result.error_description || 'Authentication failed.');
  return result;
}

async function restRequest(path, { method = 'GET', body, prefer, session = extensionSession } = {}) {
  if (!session?.access_token) throw new Error('Sign in to your company account first.');
  const headers = {
    apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey,
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(apiUrl(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const message = payload?.message || payload?.details || payload?.hint || payload?.error_description || `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload;
}

async function storageRequest(path, { method = 'POST', file, session = extensionSession } = {}) {
  if (!session?.access_token) throw new Error('Sign in to upload attachments.');
  const config = globalThis.MINDLOCK_CONFIG;
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${path}`, {
    method,
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: file,
  });
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.message || `Attachment upload failed (${response.status}).`);
  }
}

async function ensureFreshSession() {
  const stored = await extensionStorageGet(EXTENSION_SESSION_KEY);
  extensionSession = stored[EXTENSION_SESSION_KEY] || null;
  if (!extensionSession) return false;
  if (extensionSession.expires_at && extensionSession.expires_at * 1000 > Date.now() + 60000) return true;
  try {
    const refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: extensionSession.refresh_token });
    extensionSession = { ...refreshed, expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in };
    await extensionStorageSet({ [EXTENSION_SESSION_KEY]: extensionSession });
    return true;
  } catch {
    await signOut(false);
    return false;
  }
}

async function signOut(updateUi = true) {
  if (extensionSession?.access_token && isSupabaseConfigured()) {
    fetch(`${globalThis.MINDLOCK_CONFIG.supabaseUrl.replace(/\/$/, '')}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` },
    }).catch(() => {});
  }
  extensionSession = null;
  employeeProfile = null;
  employeeRecord = null;
  employeeRole = null;
  assignedDevice = null;
  await extensionStorageRemove(EXTENSION_SESSION_KEY);
  if (updateUi) showLogin();
}

function showLogin(message = '') {
  document.getElementById('extensionLoginView').classList.remove('hidden');
  document.getElementById('extensionApp').classList.add('hidden');
  document.getElementById('extensionLoginState').textContent = message;
  if (ticketRefreshTimer) clearInterval(ticketRefreshTimer);
  if (ticketRealtimeTimer) clearInterval(ticketRealtimeTimer);
}

function setExtensionTheme(theme) {
  employeeTheme = theme;
  document.body.classList.toggle('dark-mode', theme === 'dark');
  document.getElementById('themeToggle').textContent = theme === 'dark' ? '☀' : '☾';
  document.getElementById('themeToggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  chrome.storage.local.set({ 'mindlock-extension-theme': theme });
}

async function loadCurrentEmployee() {
  const roles = await restRequest(`user_roles?profile_id=eq.${extensionSession.user.id}&revoked_at=is.null&select=role_name&limit=10`);
  employeeRole = ['Administrator', 'IT Staff', 'Employee']
    .find((role) => roles.some((row) => row.role_name === role));
  if (!employeeRole) throw new Error('This account does not have an active MINDLOCK role.');
  const profiles = await restRequest(`profiles?id=eq.${extensionSession.user.id}&select=id,full_name,email&limit=1`);
  if (!profiles.length) throw new Error('Your account profile is not set up. Contact IT.');
  const employees = await restRequest(`employees?profile_id=eq.${extensionSession.user.id}&select=id,user_id,department,position,active&limit=1`);
  employeeProfile = profiles[0];
  employeeRecord = employees[0] || null;
  if (employeeRole === 'Employee' && !employeeRecord) {
    throw new Error('Your employee record is not set up. Contact IT.');
  }
  if (employeeRole === 'Employee' && !employeeRecord.active) {
    throw new Error('This employee account is inactive. Contact IT to restore access.');
  }
}

async function requireActiveLaptopAssignment() {
  if (employeeRole !== 'Employee') {
    await chrome.runtime.sendMessage({ type: 'work-session-changed', active: false });
  }
  if (!employeeRecord) {
    if (employeeRole !== 'Employee') return null;
  }
  if (!employeeRecord) {
    const error = new Error('An active laptop must be assigned to your account before you can use the employee extension. Contact IT.');
    error.code = 'LAPTOP_NOT_ASSIGNED';
    throw error;
  }
  const assignments = await restRequest(`laptop_assignments?employee_id=eq.${employeeRecord.id}&status=eq.Active&select=laptop_id,expires_at,laptop:laptops(id,laptop_id,active,status)&order=assigned_at.desc&limit=10`);
  const now = Date.now();
  const assignment = assignments.find((row) => row.laptop
    && row.laptop.active
    && row.laptop.status !== 'Retired'
    && (!row.expires_at || new Date(row.expires_at).getTime() > now));
  if (assignment) return assignment;

  await chrome.runtime.sendMessage({ type: 'work-session-changed', active: false });
  if (employeeRole !== 'Employee') return null;
  const error = new Error('An active laptop must be assigned to your account before you can use the employee extension. Contact IT.');
  error.code = 'LAPTOP_NOT_ASSIGNED';
  throw error;
}

async function loadAssignedDevice() {
  try {
    if (!employeeRecord) {
      assignedDevice = null;
      document.getElementById('endpointEmployee').textContent = employeeProfile.full_name || employeeProfile.email;
      document.getElementById('endpointDevice').textContent = 'Not assigned';
      document.getElementById('endpointModel').textContent = '—';
      updateDeviceStatus();
      return;
    }
    const assignment = await requireActiveLaptopAssignment();
    const laptops = assignment
      ? await restRequest(`laptops?id=eq.${assignment.laptop_id}&active=eq.true&status=neq.Retired&select=id,laptop_id,device_registration_id,model,manufacturer,device_name,operating_system,active,last_seen_at,connectivity_status&limit=1`)
      : [];
    assignedDevice = laptops[0] || null;
    document.getElementById('endpointEmployee').textContent = employeeProfile.full_name || employeeRecord?.user_id || employeeProfile.email;
    document.getElementById('endpointDevice').textContent = assignedDevice?.laptop_id || 'Not assigned';
    document.getElementById('endpointModel').textContent = assignedDevice
      ? [assignedDevice.manufacturer, assignedDevice.model].filter(Boolean).join(' ') || assignedDevice.device_name || assignedDevice.operating_system || '—'
      : '—';
    updateDeviceStatus();
    const heartbeatState = await extensionStorageGet('mindlock-extension-heartbeat-status');
    renderHeartbeatStatus(heartbeatState['mindlock-extension-heartbeat-status']);
  } catch (error) {
    document.getElementById('endpointDevice').textContent = 'Unavailable';
    document.getElementById('endpointModel').textContent = '—';
    document.getElementById('deviceConnectionStatus').textContent = 'Unavailable';
    document.getElementById('deviceConnectionStatus').classList.add('is-offline');
    document.getElementById('endpointStatus').textContent = 'Unavailable';
    document.getElementById('endpointStatus').classList.add('is-offline');
    console.error('Could not load assigned device details:', error);
  }
}

function updateDeviceStatus() {
  const connectionStatus = document.getElementById('deviceConnectionStatus');
  const endpointStatus = document.getElementById('endpointStatus');
  const lastSeen = assignedDevice?.last_seen_at ? new Date(assignedDevice.last_seen_at).getTime() : NaN;
  const age = Date.now() - lastSeen;
  const isOnline = Boolean(assignedDevice?.device_registration_id)
    && assignedDevice?.connectivity_status === 'Online'
    && Number.isFinite(lastSeen) && age >= 0 && age <= 2 * 60 * 1000;
  connectionStatus.textContent = !assignedDevice
    ? 'Not assigned'
    : !assignedDevice.device_registration_id
      ? 'Not registered'
      : isOnline ? 'Online' : 'Offline';
  connectionStatus.classList.toggle('is-offline', !isOnline);
  endpointStatus.textContent = assignedDevice && assignedDevice.active !== false ? 'Active' : 'Inactive';
  endpointStatus.classList.toggle('is-offline', !assignedDevice || assignedDevice.active === false);
}

async function refreshClockStatus() {
  if (employeeRole !== 'Employee') return null;
  const state = document.getElementById('clockState');
  try {
    const status = await restRequest('rpc/get_my_work_status', { method: 'POST', body: {} });
    currentWorkSchedule = status.schedule || null;
    document.getElementById('clockEmployee').textContent = employeeProfile.full_name || employeeRecord.user_id;
    document.getElementById('clockWorkStatus').textContent = status.work_status || 'Clocked Out';
    document.getElementById('clockWorkStatus').classList.toggle('is-offline', status.work_status === 'Offline');

    const schedule = status.schedule;
    document.getElementById('clockSchedule').textContent = schedule
      ? `${String(schedule.start_time).slice(0, 5)}–${String(schedule.end_time).slice(0, 5)} · ${(schedule.working_days || []).join(', ')}${schedule.lunch_enabled ? ` · Lunch ${String(schedule.lunch_start).slice(0, 5)}–${String(schedule.lunch_end).slice(0, 5)}` : ''}`
      : 'No authorized schedule';

    const active = status.active_session;
    document.getElementById('clockInTime').textContent = active?.clock_in_at
      ? new Date(active.clock_in_at).toLocaleString()
      : '—';
    const clockInButton = document.getElementById('clockInButton');
    clockInButton.classList.toggle('hidden', Boolean(active));
    clockInButton.disabled = !schedule;
    clockInButton.title = schedule ? '' : 'Clock In requires an active assigned schedule.';
    document.getElementById('clockOutButton').classList.toggle('hidden', !active);
    state.textContent = !active && !schedule
      ? 'Clock In is disabled until an active work schedule is assigned. You can still submit support tickets.'
      : '';

    if (active) {
      await extensionStorageSet({
        [workSessionStorageKey]: {
          session_id: active.id,
          scheduled_end_at: active.scheduled_end_at,
          clock_in_at: active.clock_in_at,
          lunch_enabled: Boolean(schedule?.lunch_enabled),
          lunch_start: schedule?.lunch_start || null,
          lunch_end: schedule?.lunch_end || null,
        },
      });
    } else {
      await extensionStorageRemove(workSessionStorageKey);
    }
    await chrome.runtime.sendMessage({ type: 'work-session-changed', active: Boolean(active) });
    return status;
  } catch (error) {
    state.textContent = error.message;
    return null;
  }
}

async function clockIn() {
  const state = document.getElementById('clockState');
  state.textContent = 'Validating schedule…';
  try {
    const session = await restRequest('rpc/clock_in_employee', { method: 'POST', body: {} });
    const status = await refreshClockStatus();
    if (status === null) {
      if (!session?.session_id || !session.scheduled_end_at) {
        throw new Error('Clock In was recorded, but the active session could not be synchronized. Reopen the extension while online.');
      }
      await extensionStorageSet({
        [workSessionStorageKey]: {
          session_id: session.session_id,
          scheduled_end_at: session.scheduled_end_at,
          clock_in_at: session.clock_in_at,
          lunch_enabled: Boolean(session.lunch_enabled ?? currentWorkSchedule?.lunch_enabled),
          lunch_start: session.lunch_start || currentWorkSchedule?.lunch_start || null,
          lunch_end: session.lunch_end || currentWorkSchedule?.lunch_end || null,
        },
      });
      await chrome.runtime.sendMessage({ type: 'work-session-changed', active: true });
    } else if (!status.active_session) {
      throw new Error('Clock In was recorded, but the server reports no active work session. Refresh your status before continuing.');
    }
    await syncBlockingRulesInBackground();
    state.textContent = 'Clocked In. Analytics and authorized blocking are active.';
  } catch (error) {
    state.textContent = error.message;
  }
}

async function clockOut() {
  const state = document.getElementById('clockState');
  state.textContent = 'Ending work session…';
  try {
    const result = await restRequest('rpc/clock_out_employee', { method: 'POST', body: {} });
    await extensionStorageRemove(workSessionStorageKey);
    await chrome.runtime.sendMessage({ type: 'work-session-changed', active: false });
    await syncBlockingRulesInBackground();
    const status = await refreshClockStatus();
    state.textContent = result.status === 'Auto-ended'
      ? 'Your schedule ended this work session automatically. Analytics and scheduled blocking are stopped.'
      : 'Clocked Out. Analytics and scheduled blocking are stopped.';
    if (status === null) state.textContent += ' Status refresh failed; the local session was still stopped.';
  } catch (error) {
    state.textContent = error.message;
  }
}

function updateSyncStatus() {
  const syncStatus = document.getElementById('syncStatus');
  if (!lastPolicySyncAt) {
    syncStatus.textContent = '—';
    return;
  }
  const elapsedMinutes = Math.floor((Date.now() - lastPolicySyncAt) / 60000);
  syncStatus.textContent = elapsedMinutes < 1 ? 'Now' : `${elapsedMinutes}m`;
}

function isRuleActiveNow(rule, now = new Date()) {
  const timezone = rule.timezone || 'Asia/Manila';
  const parts = getZonedClock(now, timezone);
  const rawDays = Array.isArray(rule.days_of_week) ? rule.days_of_week : String(rule.days_of_week || '').split(',');
  const days = rawDays.flatMap((value) => String(value).split(/[,\s]+/)).map((value) => value.slice(0, 3).toLowerCase()).filter(Boolean);
  const time = parts.time;
  const start = String(rule.start_time || '00:00').slice(0, 5);
  const end = String(rule.end_time || '23:59').slice(0, 5);
  const overnight = start > end;
  const afterStart = time >= start;
  const beforeEnd = time <= end;
  if (overnight && !afterStart && !beforeEnd) return false;
  if (!overnight && !(time >= start && time <= end)) return false;
  const scheduleDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (overnight && beforeEnd && !afterStart) scheduleDate.setUTCDate(scheduleDate.getUTCDate() - 1);
  const scheduleDay = scheduleDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toLowerCase();
  if (!days.includes(scheduleDay)) return false;
  const scheduleDateValue = `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, '0')}-${String(scheduleDate.getDate()).padStart(2, '0')}`;
  return (!rule.starts_on || scheduleDateValue >= rule.starts_on) && (!rule.expires_on || scheduleDateValue <= rule.expires_on);
}

function getZonedClock(date, timezone) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    time: `${values.hour}:${values.minute}`,
  };
}

async function syncBlockingRulesInBackground() {
  const result = await chrome.runtime.sendMessage({
    type: 'sync-blocking-rules',
    session: extensionSession,
  });
  if (!result?.ok) throw new Error(result?.error || 'The extension could not install the active blocking rules.');
  if (result.installedRuleCount !== result.domains.length) {
    throw new Error(`Only ${result.installedRuleCount} of ${result.domains.length} active website rules were installed by Chrome.`);
  }
  return result;
}

async function loadEmployeeBlockingPolicies() {
  const state = document.getElementById('blockingPolicyState');
  try {
    const syncResult = await syncBlockingRulesInBackground();
    const activeRules = syncResult.activePolicies || [];
    document.getElementById('websiteStatus').textContent = String(syncResult.installedRuleCount);
    document.getElementById('blockedList').innerHTML = activeRules.map((rule) => (
      `<li>${escapeHtml(rule.domain)} · ${escapeHtml(String(rule.start_time).slice(0, 5))}–${escapeHtml(String(rule.end_time).slice(0, 5))}</li>`
    )).join('');
    console.info('[LOCTIV BLOCKING] Employee dashboard synchronization', {
      installedRuleCount: syncResult.installedRuleCount,
      activeDomains: syncResult.domains,
      diagnostic: syncResult.diagnostic,
    });
    state.textContent = syncResult.installedRuleCount
      ? 'These website rules are installed and active for your account right now.'
      : 'No website blocking rules are active for your account right now.';
    state.classList.remove('error-text');
  } catch (error) {
    document.getElementById('websiteStatus').textContent = 'Unavailable';
    document.getElementById('syncStatus').textContent = 'Unavailable';
    document.getElementById('blockedList').innerHTML = '';
    state.textContent = `Could not load website policies: ${error.message}`;
    state.classList.add('error-text');
  }
}

function formatUsageDuration(totalSeconds) {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

async function loadEmployeeUsageSummary() {
  const state = document.getElementById('usageSummaryState');
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((values, part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
    return values;
  }, {});
  const start = new Date(`${dateParts.year}-${dateParts.month}-${dateParts.day}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - 6);
  try {
    const logs = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await restRequest(
        `website_usage_logs?profile_id=eq.${encodeURIComponent(extensionSession.user.id)}&recorded_at=gte.${encodeURIComponent(start.toISOString())}&select=id,domain,visit_count,total_seconds,bytes_used,recorded_at&order=recorded_at.desc,id.desc&offset=${offset}&limit=1000`,
      );
      logs.push(...page);
      if (page.length < 1000) break;
    }
    const totalSeconds = logs.reduce((sum, row) => sum + (Number(row.total_seconds) || 0), 0);
    const totalBytes = logs.reduce((sum, row) => sum + (Number(row.bytes_used) || 0), 0);
    const totalVisits = logs.reduce((sum, row) => sum + (Number(row.visit_count) || 0), 0);
    const usageByDomain = new Map();
    logs.forEach((row) => {
      if (!row.domain) return;
      const domainUsage = usageByDomain.get(row.domain) || { visits: 0, seconds: 0 };
      domainUsage.visits += Number(row.visit_count) || 0;
      domainUsage.seconds += Number(row.total_seconds) || 0;
      usageByDomain.set(row.domain, domainUsage);
    });
    const mostVisited = [...usageByDomain.entries()]
      .sort((a, b) => b[1].visits - a[1].visits || b[1].seconds - a[1].seconds)[0]?.[0];
    document.getElementById('todayVisitCount').textContent = String(totalVisits);
    const usageVisitCount = document.getElementById('usageVisitCount');
    const todayUsage = document.getElementById('todayUsage');
    const usageDataMb = document.getElementById('usageDataMb');
    const mostVisitedSite = document.getElementById('mostVisitedSite');
    if (usageVisitCount) usageVisitCount.textContent = String(totalVisits);
    if (todayUsage) todayUsage.textContent = logs.length ? formatUsageDuration(totalSeconds) : 'No data';
    if (usageDataMb) usageDataMb.textContent = `${(totalBytes / (1024 * 1024)).toFixed(2)} MB`;
    if (mostVisitedSite) mostVisitedSite.textContent = mostVisited || '—';
    if (state) {
      state.textContent = logs.length ? 'Based on the last seven Philippine calendar days.' : 'No website usage has been recorded in the last seven days.';
      state.classList.remove('error-text');
    }
  } catch (error) {
    document.getElementById('todayVisitCount').textContent = 'Unavailable';
    const usageVisitCount = document.getElementById('usageVisitCount');
    const todayUsage = document.getElementById('todayUsage');
    const usageDataMb = document.getElementById('usageDataMb');
    const mostVisitedSite = document.getElementById('mostVisitedSite');
    if (usageVisitCount) usageVisitCount.textContent = 'Unavailable';
    if (todayUsage) todayUsage.textContent = 'Unavailable';
    if (usageDataMb) usageDataMb.textContent = 'Unavailable';
    if (mostVisitedSite) mostVisitedSite.textContent = '—';
    if (state) {
      state.textContent = `Could not load usage summary: ${error.message}`;
      state.classList.add('error-text');
    }
  }
}

async function loadEmployeeHomeData() {
  await Promise.all([loadAssignedDevice(), loadEmployeeBlockingPolicies(), loadEmployeeUsageSummary()]);
  if (employeeRole === 'Employee') {
    await refreshClockStatus();
  } else {
    document.getElementById('clockWidget').classList.add('hidden');
    document.getElementById('clockState').textContent = `${employeeRole} access is enabled. Work sessions and employee monitoring require an Employee account assigned to this laptop.`;
  }
}

async function loadMyTickets() {
  const state = document.getElementById('myTicketsState');
  if (!extensionSession) return;
  state.textContent = 'Loading your tickets…';
  state.classList.remove('error-text');
  try {
    const tickets = await restRequest(`tickets?profile_id=eq.${extensionSession.user.id}&select=id,ticket_number,subject,issue_category,status,priority,created_at,updated_at&order=updated_at.desc&limit=1000`);
    document.getElementById('openTicketCount').textContent = String(
      tickets.filter((ticket) => !['Resolved', 'Closed'].includes(ticket.status)).length,
    );
    const visibleTickets = tickets.slice(0, 50);
    const unreadByTicket = new Map();
    if (visibleTickets.length) {
      const unread = await restRequest(`ticket_messages?ticket_id=in.(${visibleTickets.map((ticket) => ticket.id).join(',')})&sender_role=neq.Employee&is_read=eq.false&select=ticket_id`);
      unread.forEach((message) => unreadByTicket.set(message.ticket_id, (unreadByTicket.get(message.ticket_id) || 0) + 1));
    }
    document.getElementById('myTicketsList').innerHTML = visibleTickets.map((ticket) => `
      <li><button type="button" class="ticket-list-button" data-ticket-id="${escapeHtml(ticket.id)}">
        <span class="ticket-list-top"><strong>${escapeHtml(ticket.ticket_number)}</strong><span class="status-pill">${escapeHtml(ticket.status)}</span></span>
        <span>${escapeHtml(ticket.subject)}</span>
        <small>${escapeHtml(ticket.issue_category)} · ${escapeHtml(formatDate(ticket.updated_at))}</small>
        ${unreadByTicket.get(ticket.id) ? '<span class="unread-label">New IT reply</span>' : ''}
      </button></li>`).join('');
    state.textContent = tickets.length ? '' : 'You have not submitted any tickets yet.';
    state.classList.toggle('hidden', tickets.length > 0);
  } catch (error) {
    document.getElementById('openTicketCount').textContent = 'Unavailable';
    state.textContent = `Unable to load tickets: ${error.message}`;
    state.classList.add('error-text');
    state.classList.remove('hidden');
  }
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

async function openEmployeeTicket(ticketId) {
  const tickets = await restRequest(`tickets?id=eq.${ticketId}&profile_id=eq.${extensionSession.user.id}&select=id,ticket_number,subject,issue_category,status,description,priority,created_at,updated_at&limit=1`);
  if (!tickets.length) throw new Error('Ticket was not found or is not available to your account.');
  activeTicket = tickets[0];
  document.getElementById('employeeTicketDetail').classList.remove('hidden');
  document.getElementById('employeeTicketInfo').innerHTML = `
    <h3>${escapeHtml(activeTicket.ticket_number)} · ${escapeHtml(activeTicket.subject)}</h3>
    <p>${escapeHtml(activeTicket.description)}</p>
    <p class="ticket-detail-meta">${escapeHtml(activeTicket.issue_category)} · ${escapeHtml(activeTicket.status)} · ${escapeHtml(activeTicket.priority || 'Normal')}</p>`;
  renderEmployeeTicketActions();
  await loadEmployeeConversation();
  if (ticketRealtimeTimer) clearInterval(ticketRealtimeTimer);
  ticketRealtimeTimer = setInterval(loadEmployeeConversation, 10000);
}

async function loadEmployeeConversation() {
  if (!activeTicket) return;
  const state = document.getElementById('employeeConversationState');
  try {
    const messages = await restRequest(`ticket_messages?ticket_id=eq.${activeTicket.id}&select=id,sender_id,sender_name,sender_role,message,created_at,is_read&order=created_at.asc`);
    const unread = messages.filter((message) => message.sender_role !== 'Employee' && !message.is_read);
    if (unread.length) {
      await restRequest('ticket_messages?id=in.(' + unread.map((message) => message.id).join(',') + ')', {
        method: 'PATCH',
        body: { is_read: true, read_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });
    }
    let attachments = [];
    let attachmentLinkError = false;
    try {
      attachments = await restRequest(`ticket_attachments?ticket_id=eq.${activeTicket.id}&select=id,file_name,storage_path,message_id`);
    } catch {
      attachmentLinkError = true;
    }
    const attachmentRows = await Promise.all(attachments.map(async (attachment) => {
      try {
        return { ...attachment, signedUrl: await createSignedAttachmentUrl(attachment.storage_path) };
      } catch {
        attachmentLinkError = true;
        return { ...attachment, signedUrl: '' };
      }
    }));
    const attachmentsByMessage = new Map();
    attachmentRows.forEach((attachment) => {
      if (!attachmentsByMessage.has(attachment.message_id)) attachmentsByMessage.set(attachment.message_id, []);
      attachmentsByMessage.get(attachment.message_id).push(attachment);
    });
    document.getElementById('employeeConversation').innerHTML = messages.map((message) => `
      <article class="message-bubble ${message.sender_role === 'Employee' ? 'employee-message' : 'staff-message'}">
        <div class="message-meta"><strong>${message.sender_role === 'Employee'
          ? `${escapeHtml(message.sender_name || employeeProfile?.full_name || 'Employee')} · Employee`
          : `${escapeHtml(message.sender_name || 'IT staff')} · ${escapeHtml(message.sender_role)}`}</strong><time>${escapeHtml(formatDate(message.created_at))}</time></div>
        <p>${escapeHtml(message.message)}</p>
        ${(attachmentsByMessage.get(message.id) || []).map((attachment) => `<a class="attachment-link" href="${escapeHtml(attachment.signedUrl)}" target="_blank" rel="noopener">${escapeHtml(attachment.file_name)}</a>`).join('')}
        <small class="message-read">${message.sender_role === 'Employee'
          ? message.is_read ? 'Read by IT' : 'Sent'
          : message.is_read ? 'Read' : 'Sent'}</small>
      </article>`).join('');
    state.textContent = messages.length ? '' : 'No messages yet.';
    if (attachmentLinkError) state.textContent = 'Some attachment links could not be loaded.';
    state.classList.toggle('hidden', messages.length > 0 && !attachmentLinkError);
    await refreshEmployeeTicketStatus();
  } catch (error) {
    state.textContent = `Unable to load conversation: ${error.message}`;
    state.classList.add('error-text');
    state.classList.remove('hidden');
  }
}

async function refreshEmployeeTicketStatus() {
  if (!activeTicket) return;
  const rows = await restRequest(`tickets?id=eq.${activeTicket.id}&profile_id=eq.${extensionSession.user.id}&select=status,updated_at&limit=1`);
  if (rows.length) {
    activeTicket.status = rows[0].status;
    activeTicket.updated_at = rows[0].updated_at;
    renderEmployeeTicketActions();
  }
}

function renderEmployeeTicketActions() {
  const closed = activeTicket?.status === 'Closed';
  document.getElementById('employeeReplyForm').classList.toggle('hidden', closed);
  document.getElementById('reopenTicketBtn').classList.toggle(
    'hidden',
    employeeRole !== 'Employee' || activeTicket?.status !== 'Resolved',
  );
  const meta = document.querySelector('#employeeTicketInfo .ticket-detail-meta');
  if (meta && activeTicket) {
    meta.textContent = `${activeTicket.issue_category} · ${activeTicket.status} · ${activeTicket.priority || 'Normal'}`;
  }
  if (closed) {
    const state = document.getElementById('employeeConversationState');
    state.textContent = 'This ticket is closed. Replies and attachments are disabled.';
    state.classList.remove('hidden', 'error-text');
  }
}

async function uploadTicketAttachment(ticketId, messageId, file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('Attachments must be 10 MB or smaller.');
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${ticketId}/${crypto.randomUUID()}-${safeName}`;
  await storageRequest(`ticket-attachments/${path.split('/').map(encodeURIComponent).join('/')}`, { file });
  try {
    await restRequest('ticket_attachments', {
      method: 'POST',
      body: {
        ticket_id: ticketId,
        message_id: messageId,
        file_name: file.name,
        storage_path: path,
        content_type: file.type,
        uploaded_by: extensionSession.user.id,
      },
      prefer: 'return=minimal',
    });
  } catch (error) {
    throw new Error(`The message was saved, but the attachment could not be linked; IT may need to remove the unlinked file: ${error.message}`);
  }
}

async function createSignedAttachmentUrl(path) {
  const config = globalThis.MINDLOCK_CONFIG;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/sign/ticket-attachments/${encodedPath}`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'Could not load an attachment link.');
  const storageUrl = `${config.supabaseUrl.replace(/\/$/, '')}/storage/v1`;
  const signedUrl = payload.signedURL.startsWith('http')
    ? payload.signedURL
    : `${storageUrl}${payload.signedURL.startsWith('/') ? '' : '/'}${payload.signedURL}`;
  return new URL(signedUrl).href;
}

async function sendEmployeeReply(event) {
  event.preventDefault();
  if (!activeTicket) return;
  if (activeTicket.status === 'Closed') {
    renderEmployeeTicketActions();
    return;
  }
  const input = document.getElementById('employeeReplyInput');
  const fileInput = document.getElementById('employeeReplyFile');
  const file = fileInput.files[0];
  const message = input.value.trim();
  const button = document.getElementById('employeeReplyBtn');
  if (!message && !file) {
    input.setCustomValidity('Enter a reply or attach a file.');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  button.disabled = true;
  button.textContent = 'Sending…';
  let messageSent = false;
  try {
    const sentMessages = await restRequest('ticket_messages', {
      method: 'POST',
      body: {
        ticket_id: activeTicket.id,
        sender_id: extensionSession.user.id,
        sender_role: employeeRole,
        message: message || `Attached a file: ${file.name}`,
      },
      prefer: 'return=representation',
    });
    messageSent = true;
    if (file) await uploadTicketAttachment(activeTicket.id, sentMessages[0].id, file);
    input.value = '';
    fileInput.value = '';
    await loadEmployeeConversation();
  } catch (error) {
    const state = document.getElementById('employeeConversationState');
    if (messageSent) await loadEmployeeConversation();
    state.textContent = error.message;
    state.classList.remove('hidden');
    state.classList.add('error-text');
  } finally {
    button.disabled = false;
    button.textContent = 'Send reply';
  }
}

async function loadIssueCategories() {
  const select = document.getElementById('issueCategory');
  const categories = await restRequest('ticket_categories?is_active=eq.true&select=category_name&order=category_name.asc');
  if (!categories.length) throw new Error('No active ticket report categories are configured. Contact IT.');
  select.innerHTML = '<option value="">Select a category</option>' + categories
    .map(({ category_name }) => `<option value="${escapeHtml(category_name)}">${escapeHtml(category_name)}</option>`)
    .join('');
}

async function submitEmployeeTicket(event) {
  event.preventDefault();
  if (employeeRole !== 'Employee') {
    document.getElementById('issueSubmitState').textContent = 'Only Employee accounts can submit issue reports from the extension.';
    document.getElementById('issueSubmitState').classList.add('error-text');
    return;
  }
  const status = document.getElementById('issueSubmitState');
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  status.textContent = 'Submitting ticket…';
  status.classList.remove('error-text');
  submitButton.disabled = true;
  let createdTicket = null;
  try {
    const activeAssignment = await requireActiveLaptopAssignment();
    const descriptionParts = [
      document.getElementById('issueDescription').value.trim(),
      document.getElementById('issueAffectedService').value.trim()
        ? `Affected website or application: ${document.getElementById('issueAffectedService').value.trim()}`
        : '',
      document.getElementById('issueStartedAt').value
        ? `Issue started: ${new Date(document.getElementById('issueStartedAt').value).toISOString()}`
        : '',
      document.getElementById('issueStepsTried').value.trim()
        ? `Steps already tried:\n${document.getElementById('issueStepsTried').value.trim()}`
        : '',
    ].filter(Boolean);
    const payload = {
      profile_id: extensionSession.user.id,
      employee_id: employeeRecord.id,
      laptop_id: activeAssignment?.laptop_id || null,
      subject: document.getElementById('issueSubject').value.trim(),
      issue_category: document.getElementById('issueCategory').value,
      description: descriptionParts.join('\n\n'),
      status: 'Open',
    };
    const [ticket] = await restRequest('tickets', { method: 'POST', body: payload, prefer: 'return=representation' });
    createdTicket = ticket;
    const file = document.getElementById('issueAttachment').files[0];
    if (file) {
      const [openingMessage] = await restRequest(`ticket_messages?ticket_id=eq.${ticket.id}&sender_role=eq.Employee&select=id&order=created_at.asc&limit=1`);
      await uploadTicketAttachment(ticket.id, openingMessage.id, file);
    }
    form.reset();
    status.textContent = `Ticket ${ticket.ticket_number} submitted successfully.`;
    await loadMyTickets();
    await switchExtensionView('myTicketsView');
  } catch (error) {
    status.textContent = createdTicket
      ? `Ticket ${createdTicket.ticket_number} was submitted, but an attachment or follow-up step failed: ${error.message}`
      : `Ticket was not submitted: ${error.message}`;
    status.classList.add('error-text');
    if (createdTicket) {
      await loadMyTickets();
      await switchExtensionView('myTicketsView');
    }
  } finally {
    submitButton.disabled = false;
  }
}

async function signInEmployee(event) {
  event.preventDefault();
  const state = document.getElementById('extensionLoginState');
  if (!isSupabaseConfigured()) {
    state.textContent = 'Supabase is not configured. Add the project URL and anon key to extension/config.js.';
    state.classList.add('error-text');
    return;
  }
  state.textContent = 'Signing in…';
  state.classList.remove('error-text');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const session = await authRequest('token?grant_type=password', {
      email: document.getElementById('extensionEmail').value.trim(),
      password: document.getElementById('extensionPassword').value,
    });
    extensionSession = { ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in };
    await loadCurrentEmployee();
    await requireActiveLaptopAssignment();
    await extensionStorageSet({ [EXTENSION_SESSION_KEY]: extensionSession });
    await showEmployeeApp();
  } catch (error) {
    await signOut(false);
    state.textContent = error.message;
    state.classList.add('error-text');
  } finally {
    button.disabled = false;
  }
}

async function showEmployeeApp() {
  const isEmployee = employeeRole === 'Employee';
  document.getElementById('extensionLoginView').classList.add('hidden');
  document.getElementById('extensionApp').classList.remove('hidden');
  document.getElementById('clockWidget').classList.toggle('hidden', !isEmployee);
  document.getElementById('createTicketBtn').classList.toggle('hidden', !isEmployee);
  document.querySelector('.extension-tab[data-view="reportView"]')?.classList.toggle('hidden', !isEmployee);
  await switchExtensionView('homeView');
  await loadEmployeeHomeData();
  if (isEmployee) {
    try {
      await loadIssueCategories();
    } catch (error) {
      const status = document.getElementById('issueSubmitState');
      status.textContent = `Report categories could not load: ${error.message}`;
      status.classList.add('error-text');
    }
  }
  await loadMyTickets();
  if (ticketRefreshTimer) clearInterval(ticketRefreshTimer);
  ticketRefreshTimer = setInterval(refreshEmployeeApp, 30000);
}

async function refreshEmployeeApp() {
  if (employeeRole === 'Employee') {
    try {
      await requireActiveLaptopAssignment();
    } catch (error) {
      if (error.code === 'LAPTOP_NOT_ASSIGNED') {
        await signOut(false);
        showLogin(error.message);
        return;
      }
      const state = document.getElementById('heartbeatConnectionHelp');
      state.textContent = `Could not verify laptop assignment: ${error.message}`;
      state.classList.add('error-text');
      return;
    }
  }
  await loadEmployeeHomeData();
  await loadMyTickets();
}

async function switchExtensionView(viewId) {
  document.querySelectorAll('.extension-view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('.extension-tab[data-view]').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === viewId));
  if (viewId === 'myTicketsView') await loadMyTickets();
}

async function initPopup() {
  renderExtensionReleaseVersion();
  const theme = await extensionStorageGet('mindlock-extension-theme');
  setExtensionTheme(theme['mindlock-extension-theme'] || 'light');
  document.getElementById('themeToggle').addEventListener('click', () => setExtensionTheme(employeeTheme === 'dark' ? 'light' : 'dark'));
  document.getElementById('extensionLoginForm').addEventListener('submit', signInEmployee);
  const passwordInput = document.getElementById('extensionPassword');
  const passwordToggle = document.getElementById('toggleExtensionPassword');
  passwordToggle.addEventListener('click', () => {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    passwordToggle.textContent = isHidden ? 'Hide' : 'Show';
    passwordToggle.setAttribute('aria-pressed', String(isHidden));
    passwordToggle.setAttribute('aria-label', `${isHidden ? 'Hide' : 'Show'} password`);
  });
  document.getElementById('issueForm').addEventListener('submit', submitEmployeeTicket);
  document.getElementById('employeeReplyForm').addEventListener('submit', sendEmployeeReply);
  document.getElementById('reloadMyTicketsBtn').addEventListener('click', () => loadMyTickets());
  document.getElementById('clockInButton').addEventListener('click', clockIn);
  document.getElementById('clockOutButton').addEventListener('click', clockOut);
  document.getElementById('extensionLogoutBtn').addEventListener('click', () => signOut());
  document.getElementById('employeeTicketBackBtn').addEventListener('click', () => {
    activeTicket = null;
    if (ticketRealtimeTimer) clearInterval(ticketRealtimeTimer);
    ticketRealtimeTimer = null;
    document.getElementById('employeeTicketDetail').classList.add('hidden');
    loadMyTickets();
  });
  document.getElementById('reopenTicketBtn').addEventListener('click', async () => {
    try {
      await restRequest('rpc/reopen_own_resolved_ticket', { method: 'POST', body: { target_ticket_id: activeTicket.id } });
      await loadEmployeeConversation();
      await loadMyTickets();
    } catch (error) {
      document.getElementById('employeeConversationState').textContent = `Could not reopen ticket: ${error.message}`;
      document.getElementById('employeeConversationState').classList.add('error-text');
    }
  });
  document.getElementById('myTicketsList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ticket-id]');
    if (!button) return;
    const state = document.getElementById('myTicketsState');
    state.textContent = 'Loading ticket…';
    state.classList.remove('hidden', 'error-text');
    try {
      await openEmployeeTicket(button.dataset.ticketId);
      state.textContent = '';
    } catch (error) {
      state.textContent = error.message;
      state.classList.add('error-text');
    }
  });
  document.getElementById('extensionApp').addEventListener('click', (event) => {
    const tab = event.target.closest('.extension-tab[data-view]');
    if (tab) switchExtensionView(tab.dataset.view);
  });
  document.getElementById('createTicketBtn').addEventListener('click', async () => {
    if (employeeRole !== 'Employee') return;
    try {
      await requireActiveLaptopAssignment();
      await switchExtensionView('reportView');
    } catch (error) {
      if (error.code === 'LAPTOP_NOT_ASSIGNED') {
        await signOut(false);
        showLogin(error.message);
      } else {
        const state = document.getElementById('heartbeatConnectionHelp');
        state.textContent = `Could not verify laptop assignment: ${error.message}`;
        state.classList.add('error-text');
      }
    }
  });

  if (!isSupabaseConfigured()) {
    showLogin('Configure Supabase in extension/config.js to sign in and access your tickets.');
    return;
  }
  if (!(await ensureFreshSession())) {
    showLogin();
    return;
  }
  try {
    await loadCurrentEmployee();
    await requireActiveLaptopAssignment();
    await showEmployeeApp();
  } catch (error) {
    await signOut(false);
    showLogin(error.message);
  }
}

document.addEventListener('DOMContentLoaded', initPopup);
