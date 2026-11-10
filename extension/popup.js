const EXTENSION_SESSION_KEY = 'mindlock-extension-session';
let extensionSession = null;
let employeeProfile = null;
let employeeRecord = null;
let assignedDevice = null;
let activeTicket = null;
let ticketRefreshTimer = null;
let ticketRealtimeTimer = null;
let employeeTheme = 'light';
let employeePreviewMode = false;

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
      headers: { apikey: globalThis.MINDLOCK_CONFIG.supabaseAnonKey, Authorization: `Bearer ${extensionSession.access_token}` },
    }).catch(() => {});
  }
  extensionSession = null;
  employeeProfile = null;
  employeeRecord = null;
  assignedDevice = null;
  await extensionStorageRemove(EXTENSION_SESSION_KEY);
  if (updateUi) showLogin();
}

function showLogin(message = '') {
  employeePreviewMode = false;
  setEmployeeFormsDisabled(false);
  document.getElementById('extensionLoginView').classList.remove('hidden');
  document.getElementById('extensionApp').classList.add('hidden');
  document.getElementById('employeePreviewNotice').classList.add('hidden');
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
  const roles = await restRequest(`user_roles?profile_id=eq.${extensionSession.user.id}&role_name=eq.Employee&revoked_at=is.null&select=role_name&limit=1`);
  if (!roles.length) throw new Error('This account does not have the Employee role.');
  const profiles = await restRequest(`profiles?id=eq.${extensionSession.user.id}&select=id,full_name,email&limit=1`);
  if (!profiles.length) throw new Error('Your employee profile is not set up. Contact IT.');
  const employees = await restRequest(`employees?profile_id=eq.${extensionSession.user.id}&select=id,user_id,department,position&limit=1`);
  if (!employees.length) throw new Error('Your employee record is not set up. Contact IT.');
  employeeProfile = profiles[0];
  employeeRecord = employees[0];
  const assignments = await restRequest(`laptop_assignments?employee_id=eq.${employeeRecord.id}&status=eq.Active&select=laptop:laptops(id,laptop_id,device_registration_id,model)&limit=1`);
  assignedDevice = assignments[0]?.laptop || null;
  document.getElementById('userName').textContent = employeeProfile.full_name;
  document.getElementById('employeeMeta').textContent = `${employeeRecord.user_id} · ${assignedDevice?.laptop_id || 'No assigned laptop'}`;
}

async function loadMyTickets() {
  const state = document.getElementById('myTicketsState');
  if (!extensionSession) return;
  state.textContent = 'Loading your tickets…';
  state.classList.remove('error-text');
  try {
    const tickets = await restRequest(`tickets?profile_id=eq.${extensionSession.user.id}&select=id,ticket_number,subject,issue_category,status,priority,created_at,updated_at&order=updated_at.desc&limit=50`);
    const unreadByTicket = new Map();
    if (tickets.length) {
      const unread = await restRequest(`ticket_messages?ticket_id=in.(${tickets.map((ticket) => ticket.id).join(',')})&sender_role=neq.Employee&is_read=eq.false&select=ticket_id`);
      unread.forEach((message) => unreadByTicket.set(message.ticket_id, (unreadByTicket.get(message.ticket_id) || 0) + 1));
    }
    document.getElementById('myTicketsList').innerHTML = tickets.map((ticket) => `
      <li><button type="button" class="ticket-list-button" data-ticket-id="${escapeHtml(ticket.id)}">
        <span class="ticket-list-top"><strong>${escapeHtml(ticket.ticket_number)}</strong><span class="status-pill">${escapeHtml(ticket.status)}</span></span>
        <span>${escapeHtml(ticket.subject)}</span>
        <small>${escapeHtml(ticket.issue_category)} · ${escapeHtml(formatDate(ticket.updated_at))}</small>
        ${unreadByTicket.get(ticket.id) ? '<span class="unread-label">New IT reply</span>' : ''}
      </button></li>`).join('');
    state.textContent = tickets.length ? '' : 'You have not submitted any tickets yet.';
    state.classList.toggle('hidden', tickets.length > 0);
  } catch (error) {
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

function setEmployeeFormsDisabled(disabled) {
  ['issueForm', 'employeeReplyForm'].forEach((formId) => {
    document.getElementById(formId).querySelectorAll('input, select, textarea, button').forEach((field) => {
      field.disabled = disabled;
    });
  });
  document.getElementById('reopenTicketBtn').disabled = disabled;
  document.getElementById('reloadMyTicketsBtn').disabled = disabled;
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
  document.getElementById('reopenTicketBtn').classList.toggle('hidden', activeTicket.status !== 'Resolved');
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
    document.getElementById('reopenTicketBtn').classList.toggle('hidden', activeTicket.status !== 'Resolved');
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
      Authorization: `******`,
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
        sender_role: 'Employee',
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

async function submitEmployeeTicket(event) {
  event.preventDefault();
  if (employeePreviewMode) return;
  const status = document.getElementById('issueSubmitState');
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  status.textContent = 'Submitting ticket…';
  status.classList.remove('error-text');
  submitButton.disabled = true;
  let createdTicket = null;
  try {
    const [activeAssignment] = await restRequest(`laptop_assignments?employee_id=eq.${employeeRecord.id}&status=eq.Active&select=laptop_id&limit=1`);
    const payload = {
      profile_id: extensionSession.user.id,
      employee_id: employeeRecord.id,
      laptop_id: activeAssignment?.laptop_id || null,
      subject: document.getElementById('issueSubject').value.trim(),
      issue_category: form.querySelector('select').value,
      description: document.getElementById('issueDescription').value.trim(),
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
  employeePreviewMode = false;
  setEmployeeFormsDisabled(false);
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
    await extensionStorageSet({ [EXTENSION_SESSION_KEY]: extensionSession });
    await loadCurrentEmployee();
    await showEmployeeApp();
  } catch (error) {
    await extensionStorageRemove(EXTENSION_SESSION_KEY);
    extensionSession = null;
    state.textContent = error.message;
    state.classList.add('error-text');
  } finally {
    button.disabled = false;
  }
}

async function showEmployeeApp() {
  employeePreviewMode = false;
  setEmployeeFormsDisabled(false);
  document.getElementById('extensionLoginView').classList.add('hidden');
  document.getElementById('extensionApp').classList.remove('hidden');
  document.getElementById('employeePreviewNotice').classList.add('hidden');
  await switchExtensionView('homeView');
  await loadMyTickets();
  if (ticketRefreshTimer) clearInterval(ticketRefreshTimer);
  ticketRefreshTimer = setInterval(loadMyTickets, 30000);
}

async function switchExtensionView(viewId) {
  document.querySelectorAll('.extension-view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('.extension-tab[data-view]').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === viewId));
  if (employeePreviewMode) return;
  if (viewId === 'myTicketsView') await loadMyTickets();
}

function showEmployeePreview() {
  employeePreviewMode = true;
  document.getElementById('extensionLoginView').classList.add('hidden');
  document.getElementById('extensionApp').classList.remove('hidden');
  document.getElementById('employeePreviewNotice').classList.remove('hidden');
  document.getElementById('userName').textContent = 'Sam Patel';
  document.getElementById('employeeMeta').textContent = 'EMP-1042 · LAP-018';
  document.getElementById('websiteStatus').textContent = '1 active policy';
  document.getElementById('incognitoStatus').textContent = 'Managed by IT';
  document.getElementById('blockingPolicyState').textContent = 'Example policy currently applied to your company laptop.';
  document.getElementById('blockedList').innerHTML = '<li>social.example · Weekdays, 09:00–17:30</li>';
  document.getElementById('todayUsage').textContent = '2h 14m';
  document.getElementById('mostVisitedSite').textContent = 'docs.company.example';
  document.getElementById('myTicketsList').innerHTML = `
    <li><button type="button" class="ticket-list-button" data-ticket-id="preview-ticket">
      <span class="ticket-list-top"><strong>ML-2025</strong><span class="status-pill">In Progress</span></span>
      <span>Work training site is blocked</span>
      <small>Website Blocking Issue · ${escapeHtml(formatDate(new Date().toISOString()))}</small>
    </button></li>`;
  document.getElementById('myTicketsState').classList.add('hidden');
  document.getElementById('employeeTicketDetail').classList.add('hidden');
  document.getElementById('issueSubmitState').textContent = 'Preview only — sign in to submit a real ticket.';
  setEmployeeFormsDisabled(true);
  switchExtensionView('homeView');
}

function openPreviewTicket() {
  document.getElementById('employeeTicketDetail').classList.remove('hidden');
  document.getElementById('employeeTicketInfo').innerHTML = `
    <h3>ML-2025 · Work training site is blocked</h3>
    <p>I need access to the required safety course. Could IT review the website policy?</p>
    <p class="ticket-detail-meta">Website Blocking Issue · In Progress · Normal</p>`;
  document.getElementById('employeeConversation').innerHTML = `
    <article class="message-bubble employee-message">
      <div class="message-meta"><strong>Sam Patel · Employee</strong><time>Today</time></div>
      <p>I need access to the required safety course. Could IT review the website policy?</p>
      <small class="message-read">Read by IT</small>
    </article>
    <article class="message-bubble staff-message">
      <div class="message-meta"><strong>IT Support</strong><time>Today</time></div>
      <p>Thanks, we’re reviewing the policy and will follow up here.</p>
      <small class="message-read">Read</small>
    </article>`;
  switchExtensionView('myTicketsView');
}

async function initPopup() {
  const theme = await extensionStorageGet('mindlock-extension-theme');
  setExtensionTheme(theme['mindlock-extension-theme'] || 'light');
  document.getElementById('themeToggle').addEventListener('click', () => setExtensionTheme(employeeTheme === 'dark' ? 'light' : 'dark'));
  document.getElementById('extensionLoginForm').addEventListener('submit', signInEmployee);
  document.getElementById('employeePreviewBtn').addEventListener('click', showEmployeePreview);
  document.getElementById('issueForm').addEventListener('submit', submitEmployeeTicket);
  document.getElementById('employeeReplyForm').addEventListener('submit', sendEmployeeReply);
  document.getElementById('reloadMyTicketsBtn').addEventListener('click', () => loadMyTickets());
  document.getElementById('extensionLogoutBtn').addEventListener('click', () => signOut());
  document.getElementById('employeeTicketBackBtn').addEventListener('click', () => {
    activeTicket = null;
    if (ticketRealtimeTimer) clearInterval(ticketRealtimeTimer);
    ticketRealtimeTimer = null;
    document.getElementById('employeeTicketDetail').classList.add('hidden');
    if (!employeePreviewMode) loadMyTickets();
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
    if (employeePreviewMode) {
      openPreviewTicket();
      return;
    }
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
    await showEmployeeApp();
  } catch (error) {
    await signOut(false);
    showLogin(error.message);
  }
}

document.addEventListener('DOMContentLoaded', initPopup);
