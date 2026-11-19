importScripts('config.js');

const blockRuleIdStart = 1001;
const extensionSessionKey = 'mindlock-extension-session';
const policySyncAlarm = 'mindlock-policy-sync';
const policySyncPeriodMinutes = 1;
const usageSyncAlarm = 'mindlock-usage-sync';
const usageSyncPeriodMinutes = 0.5;
const heartbeatAlarm = 'mindlock-extension-heartbeat';
const heartbeatPeriodMinutes = 0.5;
const heartbeatStatusKey = 'mindlock-extension-heartbeat-status';
const usageTrackingStorageKey = 'mindlock-website-usage-tracking';
const workSessionStorageKey = 'mindlock-work-session';
const activeUsage = new Map();
let nextUsageEntryId = 0;
let usageStateLoaded = false;
let usageStateLoading = null;
let usageSaveQueue = Promise.resolve();
let focusedWindowId = null;
let heartbeatInProgress = false;
let authorizedWorkSession = false;

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
  const startsOn = rule.starts_on || rule.start_date;
  const expiresOn = rule.expires_on || rule.end_date;
  return (!startsOn || date >= startsOn) && (!expiresOn || date <= expiresOn);
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
    .replace(/[/?#].*$/, '');
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
  if (!await isAuthorizedWorkSession()) {
    await ensureUsageStateLoaded();
    activeUsage.clear();
    await saveUsageState();
    return;
  }
  await ensureUsageStateLoaded();
  const session = await getValidExtensionSession();
  if (!session?.access_token) return;
  const config = globalThis.MINDLOCK_CONFIG;
  const now = Date.now();
  const headers = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${session.access_token}`,
  };
  const employeeResponse = await fetch(
    `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/employees?profile_id=eq.${encodeURIComponent(session.user.id)}&active=eq.true&select=id&limit=1`,
    { headers },
  );
  if (!employeeResponse.ok) throw new Error(`Employee analytics attribution failed (${employeeResponse.status}).`);
  const employees = await employeeResponse.json();
  const employeeId = employees[0]?.id;
  if (!employeeId) throw new Error('No active employee record is linked to the signed-in profile.');

  const pendingEntries = [...activeUsage.entries()];
  const rows = pendingEntries
    .map(([, entry]) => ({
      entry,
      profile_id: session.user.id,
      employee_id: employeeId,
      domain: entry.domain,
      visit_count: entry.visitCount,
      total_seconds: Math.max(0, entry.secondsPending + (entry.startedAt === null ? 0 : Math.floor((now - entry.startedAt) / 1000))),
      bytes_used: entry.bytesUsed,
    }))
    .filter((row) => row.domain && (row.visit_count || row.total_seconds || row.bytes_used));
  if (!rows.length) return;
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/website_usage_logs`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows.map(({ entry, ...row }) => row)),
  });
  if (!response.ok) throw new Error(`Usage synchronization failed (${response.status}).`);
  rows.forEach(({ entry }) => {
    for (const [entryId, current] of activeUsage) {
      if (current !== entry) continue;
      current.secondsPending = 0;
      current.visitCount = 0;
      current.bytesUsed = 0;
      if (current.startedAt !== null) current.startedAt = now;
      if (current.closed || current.ended) activeUsage.delete(entryId);
      break;
    }
  });
  await saveUsageState();
}

async function ensureUsageStateLoaded() {
  if (usageStateLoaded) return;
  if (!usageStateLoading) {
    usageStateLoading = (async () => {
      const saved = await chrome.storage.local.get(usageTrackingStorageKey);
      const entries = saved[usageTrackingStorageKey];
      if (Array.isArray(entries)) {
        entries.forEach(([entryId, entry]) => {
          if (!Number.isInteger(entryId) || !entry || !Number.isInteger(entry.tabId) || !entry.domain) return;
          activeUsage.set(entryId, entry);
          nextUsageEntryId = Math.max(nextUsageEntryId, entryId);
        });
      }
      usageStateLoaded = true;
    })().finally(() => {
      usageStateLoading = null;
    });
  }
  await usageStateLoading;
}

function saveUsageState() {
  if (!usageStateLoaded) return Promise.reject(new Error('Usage tracking state has not been loaded.'));
  const snapshot = [...activeUsage.entries()];
  usageSaveQueue = usageSaveQueue
    .catch((error) => console.error('[LOCTIV ANALYTICS] Previous usage-state save failed:', error))
    .then(() => chrome.storage.local.set({ [usageTrackingStorageKey]: snapshot }));
  return usageSaveQueue;
}

async function hasExtensionUsageSession() {
  const saved = await chrome.storage.local.get(extensionSessionKey);
  const session = saved[extensionSessionKey];
  return Boolean(session?.access_token && session?.user?.id);
}

async function isAuthorizedWorkSession() {
  const saved = await chrome.storage.local.get(workSessionStorageKey);
  const session = saved[workSessionStorageKey];
  if (!session?.session_id || !session?.scheduled_end_at) {
    authorizedWorkSession = false;
    return false;
  }
  const endAt = new Date(session.scheduled_end_at).getTime();
  if (!Number.isFinite(endAt) || endAt <= Date.now()) {
    authorizedWorkSession = false;
    await chrome.storage.local.remove(workSessionStorageKey);
    await ensureUsageStateLoaded();
    activeUsage.clear();
    await saveUsageState();
    return false;
  }
  if (session.lunch_enabled && session.lunch_start && session.lunch_end) {
    const parts = getZonedClock(new Date(), 'Asia/Manila');
    const inLunch = parts.time >= String(session.lunch_start).slice(0, 5)
      && parts.time < String(session.lunch_end).slice(0, 5);
    if (inLunch) {
      authorizedWorkSession = false;
      await ensureUsageStateLoaded();
      activeUsage.forEach((entry) => stopUsageEntry(entry));
      await saveUsageState();
      return false;
    }
  }
  authorizedWorkSession = true;
  return true;
}

function stopUsageEntry(entry, stoppedAt = Date.now()) {
  if (entry.startedAt !== null) {
    entry.secondsPending += Math.max(0, Math.floor((stoppedAt - entry.startedAt) / 1000));
    entry.startedAt = null;
  }
}

function getOpenUsageEntry(tabId) {
  return [...activeUsage.values()].find((entry) => entry.tabId === tabId && entry.current && !entry.closed);
}

function trackTabVisit(tabId, url, windowId) {
  if (!authorizedWorkSession) return;
  const domain = getTrackedDomain(url);
  if (!domain) return;
  const now = Date.now();
  const current = getOpenUsageEntry(tabId);
  if (current?.domain === domain) {
    current.windowId = windowId ?? current.windowId;
    if (current.startedAt === null) current.startedAt = now;
    return;
  }
  if (current) {
    stopUsageEntry(current, now);
    current.current = false;
    current.ended = true;
  }
  const entryId = ++nextUsageEntryId;
  activeUsage.set(entryId, {
    tabId,
    windowId,
    domain,
    startedAt: now,
    secondsPending: 0,
    visitCount: 1,
    bytesUsed: 0,
    closed: false,
    current: true,
    ended: false,
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  try {
    await ensureUsageStateLoaded();
    if (!await isAuthorizedWorkSession()) return;
    if (!await hasExtensionUsageSession()) return;
    if (await getFocusedWindowId() !== windowId) return;
    const now = Date.now();
    activeUsage.forEach((entry) => {
      if (entry.windowId === windowId && entry.tabId !== tabId) stopUsageEntry(entry, now);
    });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) trackTabVisit(tabId, tab.url, windowId);
    await saveUsageState();
  } catch (error) {
    console.error('[LOCTIV ANALYTICS] Could not update active tab tracking:', error);
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || !tab.active || !tab.url) return;
  try {
    await ensureUsageStateLoaded();
    if (!await isAuthorizedWorkSession()) return;
    if (!await hasExtensionUsageSession()) return;
    if (await getFocusedWindowId() !== tab.windowId) return;
    trackTabVisit(tabId, tab.url, tab.windowId);
    await saveUsageState();
  } catch (error) {
    console.error('[LOCTIV ANALYTICS] Could not record active website navigation:', error);
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await ensureUsageStateLoaded();
    const entry = getOpenUsageEntry(tabId);
    if (!entry) return;
    stopUsageEntry(entry);
    entry.closed = true;
    entry.current = false;
    await saveUsageState();
  } catch (error) {
    console.error('[LOCTIV ANALYTICS] Could not finish tracking a closed tab:', error);
  }
});
async function trackActiveTabs() {
  await ensureUsageStateLoaded();
  if (!await isAuthorizedWorkSession()) return;
  if (!await hasExtensionUsageSession()) return;
  const windowId = await getFocusedWindowId();
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const tabs = await chrome.tabs.query({ active: true, windowId });
  tabs.forEach((tab) => {
    if (Number.isInteger(tab.id) && tab.url) trackTabVisit(tab.id, tab.url, tab.windowId);
  });
  await saveUsageState();
}
async function getFocusedWindowId() {
  if (focusedWindowId === null) {
    const window = await chrome.windows.getLastFocused();
    focusedWindowId = window.id;
  }
  return focusedWindowId;
}
async function initializeUsageAfterBrowserStart() {
  await ensureUsageStateLoaded();
  activeUsage.forEach((entry) => {
    entry.startedAt = null;
  });
  await saveUsageState();
  await trackActiveTabs();
}
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  try {
    await ensureUsageStateLoaded();
    if (!await isAuthorizedWorkSession()) return;
    const now = Date.now();
    focusedWindowId = windowId;
    activeUsage.forEach((entry) => {
      if (entry.windowId !== windowId) stopUsageEntry(entry, now);
    });
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      if (await hasExtensionUsageSession()) {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        tabs.forEach((tab) => {
          if (Number.isInteger(tab.id) && tab.url) trackTabVisit(tab.id, tab.url, windowId);
        });
      }
    }
    await saveUsageState();
  } catch (error) {
    console.error('[LOCTIV ANALYTICS] Could not update focused-window tracking:', error);
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'work-session-changed') return false;
  isAuthorizedWorkSession()
    .then(async (active) => {
      if (!active) {
        await ensureUsageStateLoaded();
        activeUsage.forEach((entry) => stopUsageEntry(entry));
        activeUsage.clear();
        await saveUsageState();
      } else {
        await trackActiveTabs();
        await chrome.alarms.create(heartbeatAlarm, { periodInMinutes: heartbeatPeriodMinutes });
        sendExtensionHeartbeat();
      }
      await syncBlockingRules();
      sendResponse({ ok: true, active });
    })
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'usage-bytes') return false;
  const tabId = sender.tab?.id;
  const bytes = Number(message.bytes);
  if (!Number.isInteger(tabId) || !Number.isFinite(bytes) || bytes <= 0) {
    sendResponse({ ok: false });
    return false;
  }
  ensureUsageStateLoaded()
    .then(async () => {
      if (!await isAuthorizedWorkSession()) {
        sendResponse({ ok: false });
        return;
      }
      const entry = getOpenUsageEntry(tabId);
      if (entry) entry.bytesUsed += Math.floor(bytes);
      await saveUsageState();
      sendResponse({ ok: Boolean(entry) });
    })
    .catch((error) => {
      console.error('[LOCTIV ANALYTICS] Could not record browser transfer size:', error);
      sendResponse({ ok: false });
    });
  return true;
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
      request('blocking_schedules?is_active=eq.true&select=id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on,timezone,employee_schedule_id')
        .catch(() => request('blocking_schedules?is_active=eq.true&select=id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on,employee_schedule_id')
          .catch(() => request('blocking_schedules?is_active=eq.true&select=id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on'))),
      assignmentRequest,
    ]);
    const linkedEmployeeScheduleIds = [...new Set(schedules.map((schedule) => schedule.employee_schedule_id).filter(Boolean))];
    const employeeSchedules = linkedEmployeeScheduleIds.length
      ? await request(`employee_schedules?id=in.(${linkedEmployeeScheduleIds.map(encodeURIComponent).join(',')})&employee_id=eq.${encodeURIComponent(employeeId)}&is_active=eq.true&select=id,start_date,end_date,working_days,start_time,end_time,timezone`)
      : [];
    const employeeSchedulesById = new Map(employeeSchedules.map((schedule) => [schedule.id, schedule]));
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
        .map((rule) => {
          const policy = { ...schedule, ...rule, schedule_id: schedule.id };
          if (schedule.employee_schedule_id) {
            const employeeSchedule = employeeSchedulesById.get(schedule.employee_schedule_id);
            if (!employeeSchedule) return null;
            policy.start_time = employeeSchedule.start_time;
            policy.end_time = employeeSchedule.end_time;
            policy.days_of_week = employeeSchedule.working_days;
            policy.starts_on = employeeSchedule.start_date;
            policy.expires_on = employeeSchedule.end_date;
            policy.timezone = employeeSchedule.timezone || 'Asia/Manila';
          }
          return policy;
        })
        .filter(Boolean);
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
  if (!await isAuthorizedWorkSession()) {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const managedRules = rules.filter((rule) => rule.id >= blockRuleIdStart && rule.id < blockRuleIdStart + 100);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: managedRules.map((rule) => rule.id),
      addRules: [],
    });
    await chrome.storage.local.set({ 'mindlock-blocking-policies': [] });
    return {
      domains: [],
      installedRuleCount: 0,
      activePolicies: [],
      diagnostic: { retrievedPolicyCount: 0, applicableScheduleCount: 0, activeDomainCount: 0 },
    };
  }
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
  chrome.alarms.create(usageSyncAlarm, { periodInMinutes: usageSyncPeriodMinutes });
  chrome.alarms.create(heartbeatAlarm, { periodInMinutes: heartbeatPeriodMinutes });
  trackActiveTabs()
    .catch((error) => console.error('[LOCTIV ANALYTICS] Could not initialize active tab tracking:', error));
  sendExtensionHeartbeat();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ticketCheckAlarm, { periodInMinutes: 1 });
  chrome.alarms.create(policySyncAlarm, { periodInMinutes: policySyncPeriodMinutes });
  chrome.alarms.create(usageSyncAlarm, { periodInMinutes: usageSyncPeriodMinutes });
  chrome.alarms.create(heartbeatAlarm, { periodInMinutes: heartbeatPeriodMinutes });
  initializeUsageAfterBrowserStart()
    .catch((error) => console.error('[LOCTIV ANALYTICS] Could not restore browser usage tracking:', error));
  sendExtensionHeartbeat();
});
chrome.runtime.onInstalled.addListener(() => syncBlockingRules().catch((error) => console.error('[LOCTIV BLOCKING] Unable to apply website blocking rules:', error)));
chrome.runtime.onStartup.addListener(() => syncBlockingRules().catch((error) => console.error('[LOCTIV BLOCKING] Unable to apply website blocking rules:', error)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[workSessionStorageKey]) {
    isAuthorizedWorkSession()
      .then(async (active) => {
        if (!active) {
          await ensureUsageStateLoaded();
          activeUsage.forEach((entry) => stopUsageEntry(entry));
          activeUsage.clear();
          await saveUsageState();
        }
        await syncBlockingRules();
      })
      .catch((error) => console.error('[LOCTIV WORK SESSION] Could not update monitoring state:', error));
  }
  if (area === 'local' && changes[extensionSessionKey]) {
    const previousProfileId = changes[extensionSessionKey].oldValue?.user?.id;
    const nextSession = changes[extensionSessionKey].newValue;
    if (nextSession?.access_token) {
      if (previousProfileId !== nextSession.user?.id) {
        ensureUsageStateLoaded()
          .then(() => {
            activeUsage.clear();
            return saveUsageState();
          })
          .then(() => trackActiveTabs())
          .catch((error) => console.error('[LOCTIV ANALYTICS] Could not reset usage tracking for the signed-in employee:', error));
      }
      chrome.alarms.create(heartbeatAlarm, { periodInMinutes: heartbeatPeriodMinutes });
      sendExtensionHeartbeat();
    } else {
      chrome.alarms.clear(heartbeatAlarm);
      ensureUsageStateLoaded()
        .then(() => {
          activeUsage.clear();
          return saveUsageState();
        })
        .catch((error) => console.error('[LOCTIV ANALYTICS] Could not clear usage data after sign-out:', error));
    }
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
  if (alarm.name === heartbeatAlarm) sendExtensionHeartbeat();
});

async function sendExtensionHeartbeat() {
  if (heartbeatInProgress) return;
  heartbeatInProgress = true;
  try {
    const session = await getValidExtensionSession();
    if (!session?.access_token) {
      await chrome.alarms.clear(heartbeatAlarm);
      await setHeartbeatStatus('offline', 'Sign in to LOCTIV to connect this device.');
      return;
    }
    if (!await isAuthorizedWorkSession()) {
      await chrome.alarms.clear(heartbeatAlarm);
      await setHeartbeatStatus('offline', 'Off Duty. The work-session heartbeat is stopped.');
      return;
    }

    const config = globalThis.MINDLOCK_CONFIG;
    const headers = {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
    };
    const restUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1`;

    const employeeResponse = await fetch(
      `${restUrl}/employees?profile_id=eq.${encodeURIComponent(session.user.id)}&select=id&limit=1`,
      { headers },
    );
    if (!employeeResponse.ok) {
      await setHeartbeatStatus('error', `Could not verify the employee account (HTTP ${employeeResponse.status}). Sign in again or contact IT.`);
      return;
    }
    const employees = await employeeResponse.json();
    const employeeId = employees[0]?.id;
    if (!employeeId) {
      await setHeartbeatStatus('offline', 'This sign-in is not linked to an employee record.');
      return;
    }

    const assignmentResponse = await fetch(
      `${restUrl}/laptop_assignments?employee_id=eq.${encodeURIComponent(employeeId)}&status=eq.Active&select=laptop_id&limit=1`,
      { headers },
    );
    if (!assignmentResponse.ok) {
      await setHeartbeatStatus('error', `Could not load the laptop assignment (HTTP ${assignmentResponse.status}). Check employee access and database policies.`);
      return;
    }
    const assignments = await assignmentResponse.json();
    const laptopId = assignments[0]?.laptop_id;
    if (!laptopId) {
      await setHeartbeatStatus('offline', 'No active laptop is assigned to this employee. Ask an administrator to assign one.');
      return;
    }

    const laptopResponse = await fetch(
      `${restUrl}/laptops?id=eq.${encodeURIComponent(laptopId)}&active=eq.true&select=device_registration_id&limit=1`,
      { headers },
    );
    if (!laptopResponse.ok) {
      await setHeartbeatStatus('error', `Could not load the registered laptop (HTTP ${laptopResponse.status}). Check employee access and database policies.`);
      return;
    }
    const laptops = await laptopResponse.json();
    const registrationId = laptops[0]?.device_registration_id;
    if (!registrationId) {
      await setHeartbeatStatus('offline', 'The assigned laptop is not registered yet. Ask an administrator to register it.');
      return;
    }

    const heartbeatResponse = await fetch(
      `${restUrl}/rpc/record_authenticated_extension_heartbeat`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_employee_id: employeeId,
          p_laptop_id: laptopId,
          p_registration_id: registrationId,
          p_extension_version: chrome.runtime.getManifest().version,
        }),
      },
    );
    if (!heartbeatResponse.ok) {
      const result = await heartbeatResponse.json().catch(() => ({}));
      const databaseMessage = result.message || result.error || '';
      const message = heartbeatResponse.status === 404
        ? 'The authenticated heartbeat RPC is unavailable. Ask IT to apply migration 016_authenticated_extension_heartbeats.sql.'
        : heartbeatResponse.status === 401 || /permission denied for function/i.test(databaseMessage)
          ? 'The heartbeat RPC is not enabled for employee accounts. Ask IT to apply migration 016_authenticated_extension_heartbeats.sql.'
          : /not actively assigned|mismatched|invalid or revoked/i.test(databaseMessage)
            ? databaseMessage
            : result.error || databaseMessage || `The heartbeat RPC returned HTTP ${heartbeatResponse.status}.`;
      await setHeartbeatStatus('error', message);
      console.warn('[LOCTIV HEARTBEAT] Heartbeat rejected:', message);
      return;
    }
    const receivedAt = await heartbeatResponse.json();
    await setHeartbeatStatus('online', 'Connected. The latest heartbeat was received by LOCTIV.');
    chrome.runtime.sendMessage({
      type: 'extension-heartbeat-success',
      received_at: receivedAt,
    }).catch(() => {});
  } catch (error) {
    await setHeartbeatStatus('error', 'Could not reach LOCTIV. Check this device’s internet connection; the extension will retry.');
    console.warn('[LOCTIV HEARTBEAT] Heartbeat failed; the next alarm will retry:', error.message || error);
  } finally {
    heartbeatInProgress = false;
  }
}

async function setHeartbeatStatus(state, message) {
  const status = { state, message, checked_at: new Date().toISOString() };
  await chrome.storage.local.set({ [heartbeatStatusKey]: status });
  chrome.runtime.sendMessage({ type: 'extension-heartbeat-status', status }).catch(() => {});
}

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
