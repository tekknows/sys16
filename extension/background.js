importScripts('config.js');

const blockRuleIdStart = 1001;
const extensionSessionKey = 'mindlock-extension-session';
const policySyncAlarm = 'mindlock-policy-sync';

async function syncBlockingRules() {
  const stored = await chrome.storage.local.get(['mindlock-blocking-enabled']);
  const session = await getValidExtensionSession();
  let schedules = [];
  if (session) {
    const config = globalThis.MINDLOCK_CONFIG;
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/website_blocking_rules?is_active=eq.true&select=domain,start_time,end_time,days_of_week`, {
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `******`,
      },
    });
    if (!response.ok) throw new Error(`Could not load website policies (${response.status}).`);
    schedules = await response.json();
  }
  const day = new Date().toLocaleDateString('en-US', { weekday: 'short' });
  const now = new Date().toTimeString().slice(0, 5);
  const domains = schedules.filter((rule) => {
    if (!(rule.days_of_week || []).includes(day)) return false;
    const start = String(rule.start_time).slice(0, 5);
    const end = String(rule.end_time).slice(0, 5);
    return start <= end ? now >= start && now <= end : now >= start || now <= end;
  }).map((rule) => rule.domain);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const managedRules = rules.filter((rule) => rule.id >= blockRuleIdStart && rule.id < blockRuleIdStart + 100);
  const addRules = stored['mindlock-blocking-enabled'] === false ? [] : [...new Set(domains)]
    .map((domain) => String(domain).trim().toLowerCase().replace(/^www\./, ''))
    .filter((domain) => /^[a-z0-9.-]+$/.test(domain) && domain.includes('.'))
    .slice(0, 100)
    .map((domain, index) => ({
      id: blockRuleIdStart + index,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame'] },
    }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: managedRules.map((rule) => rule.id),
    addRules,
  });
}

const notifiedRepliesKey = 'mindlock-notified-replies';
const notifiedStatusesKey = 'mindlock-notified-ticket-statuses';
const ticketCheckAlarm = 'mindlock-ticket-reply-check';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ticketCheckAlarm, { periodInMinutes: 1 });
  chrome.alarms.create(policySyncAlarm, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ticketCheckAlarm, { periodInMinutes: 1 });
  chrome.alarms.create(policySyncAlarm, { periodInMinutes: 1 });
});
chrome.runtime.onInstalled.addListener(() => syncBlockingRules().catch((error) => console.error('Unable to apply website blocking rules:', error)));
chrome.runtime.onStartup.addListener(() => syncBlockingRules().catch((error) => console.error('Unable to apply website blocking rules:', error)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[extensionSessionKey] || changes['mindlock-blocking-enabled'])) {
    syncBlockingRules().catch((error) => console.error('Unable to update website blocking rules:', error));
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ticketCheckAlarm) checkForTicketReplies();
  if (alarm.name === policySyncAlarm) syncBlockingRules().catch((error) => console.error('Unable to refresh website blocking rules:', error));
});

async function getValidExtensionSession() {
  const stored = await chrome.storage.local.get(extensionSessionKey);
  let session = stored[extensionSessionKey];
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
        title: 'New MINDLOCK support reply',
        message: 'IT staff replied to your support ticket.',
      });
      notified.add(reply.id);
    }
    if (newReplies.length) await chrome.storage.local.set({ [notifiedRepliesKey]: [...notified].slice(-100) });

    const ticketResponse = await fetch(`${globalThis.MINDLOCK_CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/tickets?profile_id=eq.${encodeURIComponent(session.user.id)}&select=id,ticket_number,status&order=updated_at.desc&limit=50`, {
      headers: {
        apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey,
        Authorization: `******`,
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
