importScripts('config.js');

const blockRuleIdStart = 1001;
const extensionSessionKey = 'mindlock-extension-session';
const policySyncAlarm = 'mindlock-policy-sync';
const policySyncPeriodMinutes = 1;
const usageSyncAlarm = 'mindlock-usage-sync';
const activeUsage = new Map();

function isScheduleActive(rule, now = new Date()) {
  const timezone = rule.timezone || 'Asia/Manila';
  const parts = getZonedClock(now, timezone);
  const rawDays = Array.isArray(rule.days_of_week) ? rule.days_of_week : String(rule.days_of_week || '').split(',');
  const days = rawDays.flatMap((value) => String(value).split(/[,\s]+/)).map((value) => value.slice(0, 3).toLowerCase()).filter(Boolean);
  const current = parts.time;
  const start = String(rule.start_time || '00:00').slice(0, 5);
  const end = String(rule.end_time || '23:59').slice(0, 5);
  const overnight = start > end;
  const afterStart = current >= start;
  const beforeEnd = current <= end;
  if (overnight && !afterStart && !beforeEnd) return false;
  if (!overnight && !(current >= start && current <= end)) return false;
  const scheduleDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (overnight && beforeEnd && !afterStart) scheduleDate.setUTCDate(scheduleDate.getUTCDate() - 1);
  const day = scheduleDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toLowerCase();
  if (!days.includes(day)) return false;
  const date = `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, '0')}-${String(scheduleDate.getDate()).padStart(2, '0')}`;
  return (!rule.starts_on || date >= rule.starts_on) && (!rule.expires_on || date <= rule.expires_on);
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
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function logBlocking(message, details = {}) {
  console.info(`[LOCTIV BLOCKING] ${message}`, details);
}

function getTrackedDomain(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return normalizeDomain(parsed.hostname);
  } catch {
    return null;
  }
}

async function flushWebsiteUsage() {
  const session = await getValidExtensionSession();
  if (!session?.access_token) return;
  const config = globalThis.MINDLOCK_CONFIG;
  const now = Date.now();
  const rows = [...activeUsage.values()]
    .map((entry) => ({
      profile_id: session.user.id,
      domain: entry.domain,
      visit_count: entry.visitCount,
      total_seconds: Math.max(0, Math.floor((now - entry.startedAt) / 1000)),
      bytes_used: 0,
      recorded_at: new Date(now).toISOString(),
    }))
    .filter((row) => row.domain && (row.visit_count || row.total_seconds));
  if (!rows.length) return;
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/website_usage_logs`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`Usage synchronization failed (${response.status}).`);
  activeUsage.clear();
}

function trackTabVisit(tabId, url) {
  const domain = getTrackedDomain(url);
  if (!domain) return;
  const current = activeUsage.get(tabId);
  if (current?.domain === domain) return;
  activeUsage.set(tabId, { domain, startedAt: Date.now(), visitCount: 1 });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url) trackTabVisit(tabId, tab.url);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) trackTabVisit(tabId, tab.url);
});

async function loadBlockingSchedules(session) {
  const config = globalThis.MINDLOCK_CONFIG;
  if (!session?.access_token) {
    throw new Error('The employee session does not contain an access token.');
  }
  const headers = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${session.access_token}`,
  };
  const request = async (path) => {
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`, { headers });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  try {
    const employees = await request(`employees?profile_id=eq.${encodeURIComponent(session.user.id)}&select=id&limit=1`);
    const employeeId = employees[0]?.id;
    if (!employeeId) {
      throw new Error(`No employee record found for authenticated profile ${session.user.id}`);
    }
    const laptopAssignments = employeeId
      ? await request(`laptop_assignments?employee_id=eq.${encodeURIComponent(employeeId)}&status=eq.Active&select=laptop_id`)
      : [];
    const laptopIds = laptopAssignments.map((assignment) => assignment.laptop_id).filter(Boolean);
    const assignmentFilters = [
      employeeId ? `employee_id.eq.${encodeURIComponent(employeeId)}` : null,
      ...laptopIds.map((laptopId) => `laptop_id.eq.${encodeURIComponent(laptopId)}`),
    ].filter(Boolean);
    const assignmentRequest = assignmentFilters.length
      ? request(`blocking_schedule_assignments?or=(${assignmentFilters.join(',')})&select=id,schedule_id,employee_id,laptop_id`)
        .catch((error) => {
          logBlocking('Assignment retrieval failed; employee-specific schedules will not apply', {
            error: error.message || String(error),
          });
          return null;
        })
      : Promise.resolve([]);
    const [schedules, assignments] = await Promise.all([
      request('blocking_schedules?is_active=eq.true&select=id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on,timezone')
        .catch(() => request('blocking_schedules?is_active=eq.true&select=id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on')),
      assignmentRequest,
    ]);
    logBlocking('Required policy tables retrieved', {
      employeeId,
      scheduleCount: schedules.length,
      assignmentCount: assignments?.length ?? 0,
    });
    let rules = [];
    try {
      rules = await request('website_blocking_rules?is_active=eq.true&select=domain,schedule_id,target_profile_id,start_time,end_time,days_of_week');
    } catch (error) {
      logBlocking('Optional blocking-rule columns unavailable; retrying with required domain column', {
        error: error.message || String(error),
      });
      rules = await request('website_blocking_rules?is_active=eq.true&select=domain');
    }
    let linkedRules = [];
    try {
      linkedRules = await request('website_blocking_rules?is_active=eq.true&select=domain,schedule_id,target_profile_id');
    } catch (error) {
      logBlocking('schedule_id column unavailable; matching schedule names to rule domains', {
        error: error.message || String(error),
      });
    }
    const linkedRuleByDomain = new Map(linkedRules.map((rule) => [normalizeDomain(rule.domain), rule]));
    const scheduleMap = new Map(schedules.map((schedule) => [schedule.id, schedule]));
    const assignedScheduleIds = new Set((assignments || []).map((assignment) => assignment.schedule_id));
    const rulesByDomain = new Map();
    rules.forEach((rule) => {
      const domain = normalizeDomain(rule.domain);
      if (!rulesByDomain.has(domain)) rulesByDomain.set(domain, []);
      rulesByDomain.get(domain).push(rule);
    });
    const policies = schedules.flatMap((schedule) => {
      const linkedScheduleRules = linkedRules.filter((rule) => rule.schedule_id === schedule.id);
      const matchingRules = linkedScheduleRules.length
        ? linkedScheduleRules
        : (rulesByDomain.get(normalizeDomain(schedule.name)) || []).map((rule) => ({
          ...rule,
          schedule_id: linkedRuleByDomain.get(normalizeDomain(rule.domain))?.schedule_id || null,
        }));
      return matchingRules
        .filter((rule) => {
          const scope = String(schedule.scope || '').toLowerCase();
          const isGlobal = !scope || scope === 'global' || scope === 'all';
          return isGlobal || (assignments !== null && assignedScheduleIds.has(schedule.id));
        })
        .map((rule) => ({ ...schedule, ...rule, schedule_id: schedule.id }));
    });
    logBlocking('Retrieved policy records', {
      authenticatedUserId: session.user.id,
      employeeId,
      employeeProfileId: session.user.id,
      assignedLaptopIds: laptopIds,
      globalSchedules: schedules.filter((schedule) => ['global', 'all', ''].includes(String(schedule.scope || '').toLowerCase())).length,
      employeeSchedules: schedules.filter((schedule) => !['global', 'all', ''].includes(String(schedule.scope || '').toLowerCase())).length,
      assignments: assignments || [],
      domains: policies.map((policy) => policy.domain),
    });
    return policies;
  } catch (error) {
    try {
      const legacy = await request('website_blocking_rules?is_active=eq.true&select=domain,start_time,end_time,days_of_week,target_profile_id');
      logBlocking('Canonical policy retrieval failed; using legacy rules', { error: error.message || String(error) });
      return legacy.filter((rule) => !rule.target_profile_id || rule.target_profile_id === session.user.id);
    } catch (legacyError) {
      throw new Error(`Policy retrieval failed after canonical and legacy queries: ${error.message || error}; legacy: ${legacyError.message || legacyError}`);
    }
  }
}

async function syncBlockingRules(sessionOverride = null) {
  const cached = await chrome.storage.local.get(['mindlock-blocking-policies']);
  const session = sessionOverride || await getValidExtensionSession();
  let schedules = [];
  if (session) {
    try {
      schedules = await loadBlockingSchedules(session);
      await chrome.storage.local.set({ 'mindlock-blocking-policies': schedules });
    } catch (error) {
      schedules = cached['mindlock-blocking-policies'] || [];
      if (!schedules.length) throw new Error(`Could not synchronize website policies: ${error.message || error}`);
      console.warn('[LOCTIV BLOCKING] Using cached website blocking policies after synchronization failure:', error);
    }
  }
  logBlocking('Synchronization summary', {
    employeeId: session?.user?.id || null,
    retrievedPolicyCount: schedules.length,
    applicableScheduleCount: schedules.filter((rule) => isScheduleActive(rule)).length,
  });
  if (!session) {
    const installedRules = await chrome.declarativeNetRequest.getDynamicRules();
    const managedRules = installedRules.filter((rule) => rule.id >= blockRuleIdStart && rule.id < blockRuleIdStart + 100);
    const installedDomains = managedRules.flatMap((rule) => rule.condition?.requestDomains || []).sort();
    logBlocking('No authenticated session; preserving existing Chrome rules', {
      installedRuleCount: managedRules.length,
      installedDomains,
    });
    return {
      domains: installedDomains,
      installedRuleCount: managedRules.length,
      activePolicies: [],
      diagnostic: { retrievedPolicyCount: 0, applicableScheduleCount: 0, activeDomainCount: installedDomains.length },
    };
  }
  const domains = schedules.filter((rule) => {
    if (session && rule.target_profile_id && rule.target_profile_id !== session.user.id) return false;
    return isScheduleActive(rule);
  }).map((rule) => normalizeDomain(rule.domain));
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const managedRules = rules.filter((rule) => rule.id >= blockRuleIdStart && rule.id < blockRuleIdStart + 100);
  logBlocking('Before synchronization', {
    authenticatedUserId: session?.user?.id || null,
    chromeRules: managedRules,
  });
  const activeDomains = [...new Set(domains)]
    .map((domain) => String(domain).trim().toLowerCase().replace(/^www\./, ''))
    .filter((domain) => /^[a-z0-9.-]+$/.test(domain) && domain.includes('.'))
    .slice(0, 100);
  const addRules = activeDomains
    .map((domain, index) => ({
      id: blockRuleIdStart + index,
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame'] },
    }));
  const installedDomainsBeforeUpdate = managedRules
    .flatMap((rule) => rule.condition?.requestDomains || [])
    .sort();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: managedRules.map((rule) => rule.id),
      addRules,
    });
  } catch (error) {
    throw new Error(`Chrome could not install website blocking rules: ${error.message || error}`);
  }
  const installedRules = await chrome.declarativeNetRequest.getDynamicRules();
  const installedActiveDomains = installedRules
    .filter((rule) => rule.id >= blockRuleIdStart && rule.id < blockRuleIdStart + 100)
    .flatMap((rule) => rule.condition?.requestDomains || [])
    .sort();
  logBlocking('After synchronization', {
    activeDomains,
    installedRules: installedRules.filter((rule) => rule.id >= blockRuleIdStart && rule.id < blockRuleIdStart + 100),
    installedRuleCount: installedActiveDomains.length,
  });
  if (JSON.stringify(installedActiveDomains) !== JSON.stringify([...activeDomains].sort())) {
    throw new Error('The browser did not install the active website blocking rules. Reload the extension and try again.');
  }
  const normalizedDomains = [...activeDomains].sort();
  const newlyActiveDomains = normalizedDomains.filter((domain) => !installedDomainsBeforeUpdate.includes(domain));
  if (newlyActiveDomains.length) {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(tabs
      .filter((tab) => {
        if (!tab.id || !tab.url) return false;
        try {
          const hostname = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, '');
          return newlyActiveDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
        } catch {
          return false;
        }
      })
      .map((tab) => chrome.tabs.reload(tab.id).catch(() => undefined)));
  }
  return {
    domains: normalizedDomains,
    installedRuleCount: installedActiveDomains.length,
    activePolicies: schedules.filter((rule) => isScheduleActive(rule)),
    diagnostic: {
      retrievedPolicyCount: schedules.length,
      applicableScheduleCount: schedules.filter((rule) => isScheduleActive(rule)).length,
      activeDomainCount: activeDomains.length,
    },
  };
}

const notifiedRepliesKey = 'mindlock-notified-replies';
const notifiedStatusesKey = 'mindlock-notified-ticket-statuses';
const ticketCheckAlarm = 'mindlock-ticket-reply-check';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ticketCheckAlarm, { periodInMinutes: 1 });
  chrome.alarms.create(policySyncAlarm, { periodInMinutes: policySyncPeriodMinutes });
  chrome.alarms.create(usageSyncAlarm, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ticketCheckAlarm, { periodInMinutes: 1 });
  chrome.alarms.create(policySyncAlarm, { periodInMinutes: policySyncPeriodMinutes });
  chrome.alarms.create(usageSyncAlarm, { periodInMinutes: 1 });
});
chrome.runtime.onInstalled.addListener(() => syncBlockingRules().catch((error) => console.error('[LOCTIV BLOCKING] Unable to apply website blocking rules:', error)));
chrome.runtime.onStartup.addListener(() => syncBlockingRules().catch((error) => console.error('[LOCTIV BLOCKING] Unable to apply website blocking rules:', error)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[extensionSessionKey]) {
    syncBlockingRules().catch((error) => console.error('[LOCTIV BLOCKING] Unable to update website blocking rules:', error));
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'sync-blocking-rules') return false;
  if (!message.session?.access_token || !message.session?.user?.id) {
    sendResponse({ ok: false, error: 'The employee session is missing. Sign in again before synchronizing blocking policies.' });
    return false;
  }
  syncBlockingRules(message.session || null)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ticketCheckAlarm) checkForTicketReplies();
  if (alarm.name === policySyncAlarm) syncBlockingRules().catch((error) => console.error('[LOCTIV BLOCKING] Unable to refresh website blocking rules:', error));
  if (alarm.name === usageSyncAlarm) flushWebsiteUsage().catch((error) => console.error('[LOCTIV ANALYTICS] Unable to synchronize website usage:', error));
});

async function getValidExtensionSession() {
  const stored = await chrome.storage.local.get(extensionSessionKey);
  let session = stored[extensionSessionKey];
  logBlocking('Session lookup', {
    hasSession: Boolean(session),
    hasAccessToken: Boolean(session?.access_token),
    hasUserId: Boolean(session?.user?.id),
  });
  if (!session || !globalThis.MINDLOCK_CONFIG?.supabaseUrl || !globalThis.MINDLOCK_CONFIG?.supabaseAnonKey) return null;
  if (session.expires_at * 1000 <= Date.now() + 60000) {
    const response = await fetch(`${globalThis.MINDLOCK_CONFIG.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!response.ok) return null;
    const refreshed = await response.json();
    session = { ...refreshed, expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in };
    await chrome.storage.local.set({ [extensionSessionKey]: session });
  }
  return session;
}

async function checkForTicketReplies() {
  try {
    const session = await getValidExtensionSession();
    if (!session) return;
    const response = await fetch(`${globalThis.MINDLOCK_CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/ticket_messages?sender_role=neq.Employee&is_read=eq.false&select=id,ticket_id,message&order=created_at.desc&limit=10`, {
      headers: {
        apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    if (!response.ok) return;
    const unreadReplies = await response.json();
    const stored = await chrome.storage.local.get(notifiedRepliesKey);
    const notified = new Set(stored[notifiedRepliesKey] || []);
    const newReplies = unreadReplies.filter((reply) => !notified.has(reply.id));
    for (const reply of newReplies) {
      chrome.notifications.create(`mindlock-reply-${reply.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'New LOCTIV support reply',
        message: 'IT staff replied to your support ticket.',
      });
      notified.add(reply.id);
    }
    if (newReplies.length) await chrome.storage.local.set({ [notifiedRepliesKey]: [...notified].slice(-100) });

    const ticketResponse = await fetch(`${globalThis.MINDLOCK_CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/tickets?profile_id=eq.${encodeURIComponent(session.user.id)}&select=id,ticket_number,status&order=updated_at.desc&limit=50`, {
      headers: {
        apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    if (!ticketResponse.ok) throw new Error(`Ticket status check failed (${ticketResponse.status}).`);
    const tickets = await ticketResponse.json();
    const statusStorage = await chrome.storage.local.get(notifiedStatusesKey);
    const knownStatuses = statusStorage[notifiedStatusesKey] || {};
    for (const ticket of tickets) {
      if (knownStatuses[ticket.id] && knownStatuses[ticket.id] !== ticket.status) {
        chrome.notifications.create(`mindlock-status-${ticket.id}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'Ticket status updated',
          message: `${ticket.ticket_number} is now ${ticket.status}.`,
        });
      }
      knownStatuses[ticket.id] = ticket.status;
    }
    await chrome.storage.local.set({ [notifiedStatusesKey]: knownStatuses });
  } catch (error) {
    console.error('Unable to check for ticket replies:', error);
  }
}
