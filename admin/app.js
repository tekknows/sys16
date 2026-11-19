const STORAGE_KEYS = { settings: 'mindlock-admin-settings' };
const UPDATE_LOGS_DISMISSAL_KEY = 'mindlock-update-logs-dismissed-1.2.2';
const PHILIPPINES_TIMEZONE = 'Asia/Manila';
const PHILIPPINES_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

const TICKET_PAGE_SIZE = 10;
const TICKET_STATUSES = ['Open', 'In Progress', 'Waiting for Employee', 'Waiting for IT', 'Resolved', 'Closed'];
let supabaseClient = null;
let adminUser = null;
let ticketPage = 0;
let ticketCount = 0;
let ticketsOnPage = [];
let selectedTicket = null;
let ticketRealtimeChannel = null;
let ticketListRealtimeChannel = null;
let monitoringRealtimeChannel = null;
let ticketPollTimer = null;
let analyticsMetric = 'time';
let analyticsRecords = [];
let selectedAnalyticsEmployeeId = null;
let ticketCategories = [];
let directoryEmployees = [];
let directoryLaptops = [];
let directoryAssignments = [];
let blockingRules = [];
let employeeSchedules = [];
let defaultBlockingTemplates = [];
let activityLogs = [];
let notifications = [];
let deviceRegistrations = [];
let connectionHistory = [];
let blockingScheduleSchemaReady = true;
let ticketStatusCounts = {};
let monitoringRefreshTimer = null;
let monitoringRefreshTimeout = null;
let deviceMonitoringSchemaReady = false;
let systemSettings = {};
let analyticsRealtimeChannel = null;
let analyticsRefreshTimer = null;
let analyticsRefreshTimeout = null;
let analyticsLoadInProgress = false;
let analyticsRefreshPending = false;

function normalizeBlockingDays(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  return values.flatMap((day) => String(day).split(/[,\s]+/))
    .map((day) => day.trim().slice(0, 3))
    .filter(Boolean);
}

function normalizeBlockingDomain(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}

function getEmployeeSchedule(employeeId) {
  if (!employeeId) return null;
  const parts = getBlockingZonedClock(new Date(), PHILIPPINES_TIMEZONE);
  const today = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return employeeSchedules
    .filter((schedule) => schedule.employee_id === employeeId
      && schedule.is_active
      && schedule.end_date >= today)
    .sort((left, right) => {
      const leftUpcoming = left.start_date > today;
      const rightUpcoming = right.start_date > today;
      if (leftUpcoming !== rightUpcoming) return leftUpcoming ? 1 : -1;
      const dateOrder = leftUpcoming
        ? left.start_date.localeCompare(right.start_date)
        : right.start_date.localeCompare(left.start_date);
      return dateOrder || String(right.created_at || '').localeCompare(String(left.created_at || ''));
    })[0] || null;
}

function renderBlockingSchedulePreview(employeeId, elementId) {
  const preview = document.getElementById(elementId);
  if (!preview) return;
  const schedule = getEmployeeSchedule(employeeId);
  if (!schedule) {
    preview.textContent = employeeId
      ? 'No active employee schedule found. Please assign an employee schedule first.'
      : 'Select an employee to view their active schedule.';
    preview.classList.toggle('error-text', Boolean(employeeId));
    return;
  }
  const days = normalizeBlockingDays(schedule.working_days).join(', ');
  const lunch = schedule.lunch_enabled
    ? ` · Lunch ${String(schedule.lunch_start).slice(0, 5)}–${String(schedule.lunch_end).slice(0, 5)}`
    : '';
  preview.textContent = `${schedule.start_date}–${schedule.end_date} · ${days} · ${String(schedule.start_time).slice(0, 5)}–${String(schedule.end_time).slice(0, 5)}${lunch}`;
  preview.classList.remove('error-text');
}

function renderDefaultBlockingTemplates(selectedTemplateId = null) {
  const templateSelect = document.getElementById('bulkBlockingTemplate');
  const currentSelection = selectedTemplateId ?? templateSelect?.value ?? '';
  const table = document.getElementById('defaultBlockingWebsiteTable');
  if (table) {
    table.innerHTML = defaultBlockingTemplates.length ? defaultBlockingTemplates.map((template) => `
      <tr>
        <td>${escapeHtml(template.name)}</td>
        <td>${escapeHtml(template.websites.map((website) => website.domain).join(', '))}</td>
        <td><span class="status-pill ${template.is_active ? 'success' : 'neutral'}">${template.is_active ? 'Active' : 'Inactive'}</span></td>
        <td><div class="blocking-rule-actions">
          <button class="text-btn edit-default-blocking" type="button" data-template-id="${escapeHtml(template.id)}">Edit</button>
          <button class="text-btn toggle-default-blocking" type="button" data-template-id="${escapeHtml(template.id)}">${template.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="text-btn delete-default-blocking" type="button" data-template-id="${escapeHtml(template.id)}">Delete</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="4">No default website templates configured.</td></tr>';
  }
  const select = templateSelect;
  if (select) {
    const activeTemplates = defaultBlockingTemplates.filter((template) => template.is_active);
    select.innerHTML = `<option value="">Select a template</option>${activeTemplates.map((template) => (
      `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`
    )).join('')}`;
    if (activeTemplates.some((template) => template.id === currentSelection)) {
      select.value = currentSelection;
    }
  }
  const preview = document.getElementById('bulkBlockingTemplatePreview');
  const selectedTemplate = defaultBlockingTemplates.find((template) => template.id === (select?.value || selectedTemplateId));
  if (preview) {
    preview.textContent = selectedTemplate
      ? selectedTemplate.websites.filter((website) => website.is_active).map((website) => website.domain).join(', ') || 'This template has no active websites.'
      : 'Select a template to preview its websites.';
  }
}

function isBlockingScheduleActiveNow(row, now = new Date()) {
  const timezone = row.timezone || 'Asia/Manila';
  const parts = getBlockingZonedClock(now, timezone);
  const rawDays = Array.isArray(row.days_of_week) ? row.days_of_week : String(row.days_of_week || '').split(',');
  const days = rawDays.flatMap((value) => String(value).split(/[,\s]+/)).map((value) => value.slice(0, 3)).filter(Boolean);
  const time = parts.time;
  const start = String(row.start_time || '00:00').slice(0, 5);
  const end = String(row.end_time || '23:59').slice(0, 5);
  const overnight = start > end;
  const afterStart = time >= start;
  const beforeEnd = time <= end;
  if (overnight && !afterStart && !beforeEnd) return false;
  if (!overnight && !(time >= start && time <= end)) return false;
  const scheduleDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (overnight && beforeEnd && !afterStart) scheduleDate.setUTCDate(scheduleDate.getUTCDate() - 1);
  const day = scheduleDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  if (!days.some((value) => value.toLowerCase() === day.toLowerCase())) return false;
  const date = `${scheduleDate.getUTCFullYear()}-${String(scheduleDate.getUTCMonth() + 1).padStart(2, '0')}-${String(scheduleDate.getUTCDate()).padStart(2, '0')}`;
  return (!row.starts_on || date >= row.starts_on) && (!row.expires_on || date <= row.expires_on);
}

function getBlockingZonedClock(date, timezone) {
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

function getPhilippinesDateKey(date) {
  const parts = getBlockingZonedClock(date, PHILIPPINES_TIMEZONE);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getPhilippinesDayKeys(date = new Date()) {
  const parts = getBlockingZonedClock(date, PHILIPPINES_TIMEZONE);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return Array.from({ length: 7 }, (_, index) => {
    const currentDay = new Date(day);
    currentDay.setUTCDate(currentDay.getUTCDate() - (6 - index));
    return currentDay.toISOString().slice(0, 10);
  });
}

function getPhilippinesStartOfDay(date = new Date()) {
  const [year, month, day] = getPhilippinesDateKey(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - PHILIPPINES_UTC_OFFSET_MS);
}

function updatePhilippinesClock() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-PH', {
    timeZone: PHILIPPINES_TIMEZONE,
    dateStyle: 'full',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-PH', {
    timeZone: PHILIPPINES_TIMEZONE,
    timeStyle: 'medium',
  }).format(now);
  const dashboardTime = document.getElementById('dashboardClockTime');
  if (dashboardTime) dashboardTime.textContent = time;
  const dashboardDate = document.getElementById('dashboardClockDate');
  if (dashboardDate) dashboardDate.textContent = date;
}

function isSupabaseConfigured() {
  const config = window.MINDLOCK_CONFIG;
  return Boolean(config?.supabaseUrl && config?.supabaseAnonKey && window.supabase?.createClient);
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!supabaseClient) {
    const config = window.MINDLOCK_CONFIG;
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  }
  return supabaseClient;
}

async function invokeSupabaseFunction(functionName, payload) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Supabase is not configured.');
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.access_token) throw new Error('Your admin session has expired. Sign in again.');
  const config = window.MINDLOCK_CONFIG;
  let response;
  try {
    response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/${functionName}`, {
      method: 'POST',
    headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${sessionData.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the ${functionName} service. Deploy the Edge Function and verify the Supabase URL, then try again. ${message}`);
  }
  const responseText = await response.text();
  let result = {};
  if (responseText.trim()) {
    try {
      result = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`The ${functionName} service returned an invalid response (${response.status}).`);
    }
  }
  if (response.status === 404) {
    throw new Error(`The ${functionName} Edge Function was not found. Deploy it with "supabase functions deploy ${functionName}" and verify the configured Supabase project.`);
  }
  if (!response.ok) throw new Error(result.error || `Device service failed (${response.status}).`);
  return result;
}

function readState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.settings);
    return saved ? JSON.parse(saved) : { theme: 'light', accent: '#2563eb', incognitoEnabled: false };
  } catch (error) {
    return { theme: 'light', accent: '#2563eb', incognitoEnabled: false };
  }
}

async function refreshSelectedTicket() {
  if (!selectedTicket || !supabaseClient) return;
  const { data, error } = await supabaseClient.from('tickets')
    .select('id,ticket_number,profile_id,employee_id,laptop_id,subject,issue_category,priority,assigned_to,status,description,created_at,updated_at,profile:profiles!tickets_profile_id_fkey(full_name,email),employee:employees!tickets_employee_id_fkey(user_id),laptop:laptops!tickets_laptop_id_fkey(laptop_id,device_registration_id,model),assigned_staff:profiles!tickets_assigned_to_fkey(full_name)')
    .eq('id', selectedTicket.id)
    .single();
  if (error) {
    document.getElementById('ticketDetailState').textContent = `Could not refresh ticket details: ${error.message}`;
    return;
  }
  selectedTicket = data;
  renderTicketInfo(selectedTicket);
}

function saveState(nextState) {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(nextState));
}

function getSystemSetting(key, fallback) {
  return systemSettings[key] === undefined ? fallback : systemSettings[key];
}

async function saveSystemSettings(values) {
  const client = getSupabaseClient();
  if (!client || !adminUser) throw new Error('Your admin session has expired. Sign in again.');
  const rows = Object.entries(values).map(([setting_key, setting_value]) => ({
    setting_key,
    setting_value,
    updated_by: adminUser.id,
  }));
  const { error } = await client.from('system_settings').upsert(rows, { onConflict: 'setting_key' });
  if (error) throw error;
  Object.assign(systemSettings, values);
}

function applyTheme(themeName, accentColor, applyAccent = false) {
  const root = document.documentElement;
  if (applyAccent) {
    root.style.setProperty('--accent', accentColor || '#2563eb');
  } else {
    root.style.removeProperty('--accent');
  }
  document.body.classList.toggle('dark-mode', themeName === 'dark');
  document.body.classList.toggle('light-mode', themeName !== 'dark');
  [document.getElementById('themeToggleBtn'), document.getElementById('loginThemeToggleBtn')].forEach((btn) => {
    if (!btn) return;
    const label = themeName === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  });
}

async function handleLogin(ev) {
  ev.preventDefault();
  const email = document.getElementById('email')?.value || '';
  const password = document.getElementById('password')?.value || '';
  const errorLabel = document.getElementById('loginError');

  if (!email || !password) {
    errorLabel.textContent = 'Please enter your email and password.';
    errorLabel.classList.remove('hidden');
    return;
  }

  const client = getSupabaseClient();
  try {
    if (!client) throw new Error('Supabase is not configured. Add the project URL and public anon key to admin/config.js.');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const { data: roleRows, error: roleError } = await client
      .from('user_roles')
      .select('role_name')
      .eq('profile_id', data.user.id)
      .is('revoked_at', null);
    if (roleError) throw roleError;
    const role = roleRows.find((row) => row.role_name === 'Administrator' || row.role_name === 'IT Staff')?.role_name;
    if (!role) {
      await client.auth.signOut();
      throw new Error('This account does not have administrator or IT staff access.');
    }
    adminUser = { id: data.user.id, email: data.user.email, role };
  } catch (error) {
    errorLabel.textContent = error.message || 'Unable to sign in. Please check your credentials and try again.';
    errorLabel.classList.remove('hidden');
    return;
  }

  const remember = document.getElementById('remember')?.checked;
  if (remember) {
    localStorage.setItem('mindlock-remember-admin', email.trim().toLowerCase());
  } else {
    localStorage.removeItem('mindlock-remember-admin');
  }

  window.location.href = 'dashboard.html';
}

function setupLoginPage() {
  const loginForm = document.getElementById('loginForm');
  const togglePassword = document.getElementById('togglePassword');
  const rememberedEmail = localStorage.getItem('mindlock-remember-admin');
  const themeState = readState();
  applyTheme(themeState.theme, null);
  document.getElementById('loginThemeToggleBtn')?.addEventListener('click', () => {
    const nextState = readState();
    nextState.theme = nextState.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextState.theme, null);
    saveState(nextState);
  });

  if (rememberedEmail) {
    const emailField = document.getElementById('email');
    if (emailField) emailField.value = rememberedEmail;
  }

  if (togglePassword) {
    togglePassword.addEventListener('click', () => {
      const passwordField = document.getElementById('password');
      const isHidden = passwordField.type === 'password';
      passwordField.type = isHidden ? 'text' : 'password';
      togglePassword.setAttribute('aria-pressed', String(isHidden));
      togglePassword.setAttribute('aria-label', `${isHidden ? 'Hide' : 'Show'} password`);
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

}

function renderMetricCards() {
  const statsGrid = document.getElementById('statsGrid');
  if (!statsGrid) return;

  const activeAssignments = directoryAssignments.filter((row) => row.status === 'Active').length;
  const stats = [
    ['Employees', directoryEmployees.length],
    ['Laptops', directoryLaptops.length],
    ['Assigned laptops', activeAssignments],
    ['Available laptops', directoryLaptops.filter((row) => row.status === 'Available').length],
    ['Blocking policies', blockingRules.length],
  ];
  statsGrid.innerHTML = stats.map(([label, value]) => `
    <article class="stat-card"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong></article>
  `).join('');
}

function settingValue(key, fallback) {
  const setting = getSystemSetting(key, fallback);
  if (setting && typeof setting === 'object') {
    if ('value' in setting) return setting.value;
    if ('enabled' in setting) return setting.enabled;
  }
  return setting;
}

function renderSettingsForms() {
  const savedAccent = settingValue('dashboard_accent', readState().accent || '#2563eb');
  const accentInput = document.getElementById('accentColor');
  const accentPreview = document.getElementById('accentPreview');
  if (accentInput) accentInput.value = savedAccent;
  if (accentPreview) accentPreview.style.background = savedAccent;
  const currentState = readState();
  currentState.accent = savedAccent;
  saveState(currentState);
  applyTheme(currentState.theme, savedAccent, true);
  const general = document.getElementById('generalSettingsForm');
  if (general) {
    general.elements.companyName.value = settingValue('company_name', 'LOCTIV');
    general.elements.timezone.value = PHILIPPINES_TIMEZONE;
    general.elements.notificationPreference.value = settingValue('notification_preferences', 'Email + In-app');
  }
  const ticket = document.getElementById('ticketSettingsForm');
  if (ticket) {
    ticket.elements.defaultTicketStatus.value = settingValue('ticket_default_status', 'Open');
    ticket.elements.ticketPrefix.value = settingValue('ticket_id_prefix', 'TKT');
    ticket.elements.supportInstructions.value = settingValue('support_instructions', '');
  }
  const retention = document.getElementById('retentionSettingsForm');
  if (retention) {
    retention.elements.messageRetentionDays.value = settingValue('message_retention_days', 30);
    retention.elements.messageAutoCleanup.checked = settingValue('message_auto_cleanup', true);
    retention.elements.ticketCleanupDays.value = settingValue('resolved_ticket_cleanup_days', 3);
    retention.elements.historyRetentionDays.value = settingValue('retention_history_days', 90);
    retention.elements.keepMessagesIndefinitely.checked = settingValue('keep_messages_indefinitely', false);
    retention.elements.policySyncEnabled.checked = settingValue('policy_sync_enabled', true);
    retention.elements.disposalCleanupDays.value = settingValue('disposal_laptop_cleanup_days', 30);
    retention.elements.assignmentRetentionDays.value = settingValue('assignment_retention_days', 30);
    retention.elements.analyticsRetentionDays.value = settingValue('analytics_retention_days', 90);
  }
  const incognito = document.getElementById('incognitoSettingsForm');
  if (incognito) incognito.querySelector('#incognitoToggle').checked = settingValue('global_incognito_policy', false);
}

function renderActivityList() {
  const activityList = document.getElementById('activityList');
  if (!activityList) return;
  activityList.innerHTML = activityLogs.length
    ? activityLogs.map((item) => `<li><span class="dot"></span><span>${escapeHtml(item.action)} · ${escapeHtml(item.module_name)} · ${escapeHtml(formatDate(item.created_at))}</span></li>`).join('')
    : '<li>No recent activity recorded.</li>';
}

function renderNotifications() {
  const container = document.getElementById('notificationList');
  const modalList = document.getElementById('notificationsModalList');
  const markup = notifications.length
    ? notifications.map((item) => `
      <li class="${item.is_read ? '' : 'unread-notification'}">
        <button type="button" class="notification-item" data-notification-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.link?.toLowerCase().includes('ticket') ? 'Open ticket from notification' : 'Mark notification as read')}">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.body)}</small>
          <time>${escapeHtml(formatDate(item.created_at))}</time>
        </button>
      </li>`).join('')
    : '<li class="empty-notification">No notifications.</li>';
  if (container) container.innerHTML = markup;
  if (modalList) modalList.innerHTML = markup;
}

function renderBarChart() {
  const usageChart = document.getElementById('usageChart');
  if (!usageChart) return;

  const dailyUsage = new Map();
  getSelectedAnalyticsRecords(analyticsRecords).forEach((row) => {
    const dateKey = getPhilippinesDateKey(new Date(row.recorded_at));
    dailyUsage.set(dateKey, (dailyUsage.get(dateKey) || 0) + Number(row.total_seconds || 0) / 60);
  });
  const days = getPhilippinesDayKeys();
  const data = days.map((day) => dailyUsage.get(day) || 0);
  const max = Math.max(...data, 1);
  usageChart.innerHTML = data
    .map(
      (value, index) => `
        <div class="bar-group">
          <span style="height:${Math.max(value ? (value / max) * 100 : 0, 2)}%" title="${value.toFixed(1)} minutes"></span>
          <small>${formatAnalyticsDay(days[index])}</small>
        </div>
      `,
    )
    .join('');
}

function formatAnalyticsDay(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function formatUsageDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function getSelectedAnalyticsRecords(records) {
  const employeeId = document.getElementById('analyticsEmployeeFilter')?.value || '';
  return employeeId ? records.filter((row) => row.employee_id === employeeId) : records;
}

function renderAnalyticsEmployeeFilter() {
  const select = document.getElementById('analyticsEmployeeFilter');
  if (!select) return;
  const selectedId = select.value;
  const connectedEmployees = getConnectedRegisteredEmployees();
  select.innerHTML = '<option value="">All connected employees</option>' + connectedEmployees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)} (${escapeHtml(employee.userId)})</option>`)
    .join('');
  if (connectedEmployees.some((employee) => employee.id === selectedId)) select.value = selectedId;
  else select.value = '';
  renderAnalyticsData(analyticsRecords);
  renderBarChart();
}

function renderAnalyticsWebsiteTable(records) {
  const table = document.getElementById('analyticsWebsiteTable');
  if (!table) return;
  const employees = new Map(getConnectedRegisteredEmployees().map((employee) => [employee.id, employee]));
  const totals = new Map();
  records.forEach((row) => {
    const employeeId = row.employee_id || row.profile_id || '';
    const employee = employees.get(employeeId);
    if (!employee) return;
    const key = `${employeeId}\u0000${row.domain}`;
    const total = totals.get(key) || {
      employeeId,
      employeeName: employee.name || 'Unknown employee',
      employeeUserId: employee.user_id,
      domain: row.domain,
      seconds: 0,
      bytes: 0,
      visits: 0,
    };
    total.seconds += Number(row.total_seconds) || 0;
    total.bytes += Number(row.bytes_used) || 0;
    total.visits += Number(row.visit_count) || 0;
    totals.set(key, total);
  });
  table.innerHTML = [...totals.values()]
    .sort((a, b) => b.seconds - a.seconds || b.bytes - a.bytes)
    .map((row) => `<tr>
      <td><button type="button" class="analytics-employee-link" data-analytics-employee-id="${escapeHtml(row.employeeId)}" aria-label="View analytics for ${escapeHtml(row.employeeName)}">${escapeHtml(row.employeeUserId)}<small>${escapeHtml(row.employeeName)}</small></button></td>
      <td>${escapeHtml(row.domain || 'Unknown website')}</td>
      <td>${formatUsageDuration(row.seconds)}</td>
      <td>${(row.bytes / (1024 * 1024)).toFixed(2)} MB</td>
      <td>${row.visits}</td>
    </tr>`)
    .join('') || '<tr><td colspan="5">No usage records for connected employees with registered laptops in this selection.</td></tr>';
}

function getConnectedRegisteredEmployees() {
  const now = Date.now();
  return directoryEmployees.filter((employee) => {
    if (!employee.active) return false;
    const assignment = directoryAssignments.find((row) => row.employee_id === employee.id && row.status === 'Active');
    const laptop = assignment?.laptop;
    if (!laptop?.device_registration_id || laptop.connectivity_status !== 'Online') return false;
    const registration = getActiveDeviceRegistration(laptop);
    if (!registration?.is_active || !registration.last_heartbeat_at) return false;
    const heartbeatAge = now - new Date(registration.last_heartbeat_at).getTime();
    return heartbeatAge >= -30000 && heartbeatAge < 120000;
  });
}

function renderAnalyticsEmployeeDetail(employeeId) {
  const employee = getConnectedRegisteredEmployees().find((row) => row.id === employeeId);
  const panel = document.getElementById('analyticsEmployeeDetail');
  if (!employee || !panel) {
    panel?.classList.add('hidden');
    return;
  }
  selectedAnalyticsEmployeeId = employeeId;
  const records = getSelectedAnalyticsRecords(analyticsRecords).filter((row) =>
    (row.employee_id || row.profile_id) === employeeId);
  const byDomain = new Map();
  records.forEach((record) => {
    const domain = record.domain || 'Unknown website';
    const total = byDomain.get(domain) || { seconds: 0, bytes: 0, visits: 0 };
    total.seconds += Number(record.total_seconds) || 0;
    total.bytes += Number(record.bytes_used) || 0;
    total.visits += Number(record.visit_count) || 0;
    byDomain.set(domain, total);
  });
  const rankedSites = [...byDomain.entries()].sort((a, b) => b[1].visits - a[1].visits || b[1].seconds - a[1].seconds);
  const seconds = records.reduce((sum, record) => sum + (Number(record.total_seconds) || 0), 0);
  const bytes = records.reduce((sum, record) => sum + (Number(record.bytes_used) || 0), 0);
  const visits = records.reduce((sum, record) => sum + (Number(record.visit_count) || 0), 0);
  document.getElementById('analyticsEmployeeDetailTitle').textContent = `${employee.name} (${employee.user_id})`;
  document.getElementById('analyticsEmployeeDetailStats').innerHTML = [
    { label: 'Time spent', value: formatUsageDuration(seconds) },
    { label: 'Data usage', value: `${(bytes / (1024 * 1024)).toFixed(2)} MB` },
    { label: 'Visits', value: String(visits) },
    { label: 'Top website', value: rankedSites[0]?.[0] || 'No data' },
  ].map((item) => `<article class="stat-card"><span class="metric-label">${escapeHtml(item.label)}</span><strong class="metric-value">${escapeHtml(item.value)}</strong></article>`).join('');
  document.getElementById('analyticsEmployeeTopSites').innerHTML = rankedSites.slice(0, 5)
    .map(([domain, total]) => `<li><span class="dot"></span><span>${escapeHtml(domain)} · ${formatUsageDuration(total.seconds)} · ${(total.bytes / (1024 * 1024)).toFixed(2)} MB</span></li>`)
    .join('') || '<li>No website data recorded in the last seven days.</li>';
  document.getElementById('analyticsEmployeeRecords').innerHTML = [...records]
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))
    .map((record) => `<tr>
      <td>${escapeHtml(record.domain || 'Unknown website')}</td>
      <td>${escapeHtml(formatDate(record.recorded_at))}</td>
      <td>${formatUsageDuration(Number(record.total_seconds) || 0)}</td>
      <td>${((Number(record.bytes_used) || 0) / (1024 * 1024)).toFixed(2)} MB</td>
      <td>${Number(record.visit_count) || 0}</td>
    </tr>`)
    .join('') || '<tr><td colspan="5">No website records for the last seven days.</td></tr>';
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

function generateSecurePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}

function renderAnalytics() {
  const stats = document.getElementById('analyticsStats');
  const chart = document.getElementById('analyticsChart');
  const sites = document.getElementById('topSitesList');
  if (stats) stats.innerHTML = '';
  if (chart) chart.innerHTML = '';
  if (sites) sites.innerHTML = '';
}

function renderTicketLegend() {
  const container = document.getElementById('ticketLegend');
  if (!container) return;
  const total = Object.values(ticketStatusCounts).reduce((sum, count) => sum + count, 0);
  container.innerHTML = `
    <div class="ticket-summary-total"><strong>${total}</strong><span>Total tickets</span></div>
    <div class="ticket-status-list">
      ${TICKET_STATUSES.map((status) => {
        const count = ticketStatusCounts[status] || 0;
        const share = total ? Math.round((count / total) * 100) : 0;
        const className = status.toLowerCase().replaceAll(' ', '-');
        return `<div class="ticket-status-row">
          <div class="ticket-status-label"><span class="ticket-status-dot ${className}"></span><span>${escapeHtml(status)}</span><strong>${count}</strong></div>
          <div class="ticket-status-track"><span class="${className}" style="width:${share}%"></span></div>
        </div>`;
      }).join('')}
    </div>`;
}

function renderBlockingTable() {
  const table = document.getElementById('blockingTable');
  if (!table) return;
  table.innerHTML = blockingRules.length ? blockingRules.map((row) => {
    const sourceSchedule = employeeSchedules.find((schedule) => schedule.id === row.employee_schedule_id);
    const days = normalizeBlockingDays(sourceSchedule?.working_days || row.days_of_week).join(', ') || 'Every day';
    const targetEmployee = row.target_profile_id
      ? directoryEmployees.find((employee) => employee.profile_id === row.target_profile_id)
      : null;
    const scope = row.target_profile_id
      ? targetEmployee
        ? `${targetEmployee.name} (${targetEmployee.user_id})`
        : 'Specific employee'
      : 'All employees';
    const now = new Date();
    const start = String(sourceSchedule?.start_time || row.start_time || '00:00').slice(0, 5);
    const end = String(sourceSchedule?.end_time || row.end_time || '23:59').slice(0, 5);
    const statusRow = sourceSchedule ? {
      ...row,
      start_time: sourceSchedule.start_time,
      end_time: sourceSchedule.end_time,
      days_of_week: sourceSchedule.working_days,
      starts_on: sourceSchedule.start_date,
      expires_on: sourceSchedule.end_date,
      timezone: sourceSchedule.timezone,
    } : row;
    const status = !row.is_active || (sourceSchedule && !sourceSchedule.is_active)
      ? 'Paused'
      : isBlockingScheduleActiveNow(statusRow) ? 'Active' : 'Scheduled';
    return `
        <tr>
          <td>${escapeHtml(row.domain)}</td>
          <td>${escapeHtml(scope)}</td>
          <td>${escapeHtml(start)} - ${escapeHtml(end)}</td>
          <td>${escapeHtml(days)}</td>
          <td><span class="status-pill ${status === 'Active' ? 'success' : status === 'Scheduled' ? 'warning' : 'neutral'}">${status}</span></td>
          <td>
            <div class="blocking-rule-actions">
              <button class="text-btn edit-blocking-rule" type="button" data-rule-id="${escapeHtml(row.id)}">Edit</button>
              <button class="text-btn blocking-delete-btn" type="button" data-rule-id="${escapeHtml(row.id)}">Delete</button>
            </div>
          </td>
        </tr>
      `;
  }).join('') : '<tr><td colspan="6">No website blocking policies configured.</td></tr>';
}

function renderAssignmentTable() {
  const table = document.getElementById('assignmentTable');
  if (!table) return;
  table.innerHTML = directoryAssignments.length ? directoryAssignments.map((row) => `
        <tr>
          <td><button class="text-btn user-details-btn" data-user-id="${escapeHtml(row.employee.user_id)}">${escapeHtml(row.employee.user_id)}</button></td>
          <td>${escapeHtml(row.employee.name)}</td>
          <td>${escapeHtml(row.laptop.laptop_id)}</td>
          <td>${escapeHtml(formatDate(row.assigned_at))}</td>
          <td>${row.expires_at ? escapeHtml(formatDate(row.expires_at)) : 'Indefinite'}</td>
          <td><span class="status-pill ${row.status === 'Active' ? 'success' : 'neutral'}">${escapeHtml(row.status)}</span></td>
        </tr>
      `).join('') : '<tr><td colspan="6">No laptop assignments.</td></tr>';
}

function renderAssignmentOptions() {
  const employeeSelect = document.getElementById('assignmentEmployee');
  const laptopSelect = document.getElementById('assignmentLaptop');
  if (!employeeSelect || !laptopSelect) return;
  const employees = directoryEmployees.filter((row) => row.active);
  const laptops = directoryLaptops.filter((row) => row.status !== 'Retired');
  employeeSelect.innerHTML = `<option value="">Select an employee</option>${employees.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join('')}`;
  laptopSelect.innerHTML = `<option value="">Select a laptop</option>${laptops.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.laptop_id)}${directoryAssignments.some((assignment) => assignment.laptop_id === row.id && assignment.status === 'Active') ? ' (currently assigned)' : ''}</option>`).join('')}`;
}

function renderEmployeeTable() {
  const table = document.getElementById('employeeTable');
  if (!table) return;
  const query = (document.getElementById('employeeSearch')?.value || '').trim().toLowerCase();
  const status = document.getElementById('employeeStatusFilter')?.value || '';
  const departmentFilter = document.getElementById('employeeDepartmentFilter');
  let selectedDepartment = departmentFilter?.value || '';
  const departments = [...new Set(directoryEmployees
    .map((row) => (row.department || '').trim())
    .filter(Boolean))]
    .sort((first, second) => first.localeCompare(second));
  if (departmentFilter) {
    departmentFilter.innerHTML = `<option value="">All departments</option>${departments
      .map((department) => `<option value="${escapeHtml(department)}">${escapeHtml(department)}</option>`).join('')}`;
    selectedDepartment = departments.includes(selectedDepartment) ? selectedDepartment : '';
    departmentFilter.value = selectedDepartment;
  }
  table.innerHTML = directoryEmployees
    .filter((row) => (!status || (row.active ? 'Active' : 'Suspended') === status)
      && (!selectedDepartment || (row.department || '').trim() === selectedDepartment)
      && (!query || `${row.user_id} ${row.name} ${row.department} ${row.position} ${row.email}`.toLowerCase().includes(query)))
    .map((row) => {
      const assignment = getEmployeeLaptopAssignment(row.id);
      const registration = assignment ? getActiveDeviceRegistration(assignment.laptop) : null;
      return `<tr>
        <td>${escapeHtml(row.user_id)}</td>
        <td>${escapeHtml(assignment?.laptop.laptop_id || 'Unassigned')}</td>
        <td><button type="button" class="text-btn view-employee-details" data-employee-id="${escapeHtml(row.id)}">${escapeHtml(row.name)}</button></td>
        <td>${escapeHtml(row.department || '—')}</td>
        <td>${statusPill(getDeviceConnectionStatus(registration))}</td>
        <td>${escapeHtml(row.email)}</td>
        <td>${statusPill(row.active ? (row.account_status || 'Active') : 'Suspended')}</td>
        <td>
          <div class="employee-actions">
            <button type="button" class="icon-btn employee-actions-btn" aria-label="Employee actions" aria-expanded="false" title="Employee actions">⚙</button>
            <div class="employee-action-menu hidden">
              <button type="button" class="text-btn employee-password-btn" data-employee-id="${escapeHtml(row.profile_id)}">Reset password</button>
              <button type="button" class="text-btn employee-delete-btn" data-employee-id="${escapeHtml(row.profile_id)}">Delete</button>
            </div>
          </div>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="8">No employees found.</td></tr>';
}

function renderUserRoleAssignments() {
  const table = document.getElementById('userRoleAssignments');
  if (!table) return;
  table.innerHTML = directoryEmployees.map((employee) => `
    <tr><td>${escapeHtml(employee.user_id)}</td><td>${escapeHtml(employee.name)}</td><td>${escapeHtml(employee.role || 'Employee')}</td></tr>
  `).join('');
}

function renderLaptopTable() {
  const table = document.getElementById('laptopTable');
  if (!table) return;
  const query = (document.getElementById('laptopSearch')?.value || '').trim().toLowerCase();
  const status = document.getElementById('laptopStatusFilter')?.value || '';
  table.innerHTML = directoryLaptops
    .filter((row) => (!status || row.status === status) && (!query || `${row.laptop_id} ${row.device_name} ${row.manufacturer} ${row.model} ${row.serial_number} ${row.mac_address}`.toLowerCase().includes(query)))
    .map((row) => {
      const assignment = getActiveLaptopAssignment(row.id);
      const registration = getActiveDeviceRegistration(row);
      return `<tr>
        <td>${escapeHtml(row.laptop_id)}</td>
        <td>${escapeHtml(assignment?.employee.name || 'Unassigned')}</td>
        <td>${escapeHtml(assignment?.employee.user_id || '—')}</td>
        <td>${escapeHtml(row.mac_address || registration?.mac_address || '—')}</td>
        <td>${escapeHtml(registration?.registration_id || '—')}</td>
        <td>${statusPill(getDeviceConnectionStatus(registration))}</td>
        <td>${statusPill(registration ? 'Registered' : 'Unregistered')}</td>
        <td>${escapeHtml(formatDate(registration ? registration.last_heartbeat_at : row.last_seen_at))}</td>
        <td>${escapeHtml(assignment ? formatDate(assignment.assigned_at) : '—')}</td>
        <td class="laptop-actions">
          <button type="button" class="text-btn view-laptop-details" data-laptop-id="${escapeHtml(row.id)}">View</button>
          <button type="button" class="text-btn assign-laptop" data-laptop-id="${escapeHtml(row.id)}">${assignment ? 'Change employee' : 'Assign employee'}</button>
          ${registration ? `<button type="button" class="text-btn revoke-device" data-laptop-id="${escapeHtml(row.id)}">Revoke</button>` : ''}
          <button type="button" class="text-btn connection-history-laptop" data-laptop-id="${escapeHtml(row.id)}">History</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="10">No laptops registered.</td></tr>';
}

let dashboardToastTimer = null;

function showToast(message, isError = false) {
  const toast = document.getElementById('dashboardToast');
  if (!toast || !message) return;
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  window.clearTimeout(dashboardToastTimer);
  dashboardToastTimer = window.setTimeout(() => toast.classList.remove('visible'), 4200);
}

function setDashboardState(message, isError = false) {
  const state = document.getElementById('dashboardDataState');
  if (state) {
    state.textContent = message;
    state.classList.toggle('error-text', isError);
    state.classList.toggle('hidden', !message);
  }
  if (message && !/^Loading\b/.test(message)) showToast(message, isError);
}

async function loadBlockingPolicies(client) {
  const legacyQuery = async () => {
    let hasScheduleColumns = true;
    let hasTargetColumn = true;
    let result;
    while (true) {
      const columns = [
        'id',
        'domain',
        ...(hasScheduleColumns ? ['start_time', 'end_time', 'days_of_week'] : []),
        ...(hasTargetColumn ? ['target_profile_id'] : []),
        'is_active',
        'created_by',
      ];
      result = await client.from('website_blocking_rules').select(columns.join(',')).order('created_at', { ascending: false });
      if (!result.error) break;
      if (hasScheduleColumns && /start_time|end_time|days_of_week/i.test(result.error.message)) {
        hasScheduleColumns = false;
        continue;
      }
      if (hasTargetColumn && /target_profile_id/i.test(result.error.message)) {
        hasTargetColumn = false;
        continue;
      }
      throw result.error;
    }
    return {
      data: (result.data || []).map((row) => ({
        ...row,
        start_time: row.start_time || '00:00',
        end_time: row.end_time || '23:59',
        days_of_week: normalizeBlockingDays(row.days_of_week),
        starts_on: null,
        expires_on: null,
        schedule_id: null,
      })),
      canonical: false,
    };
  };

  const [scheduleResult, ruleResult, assignmentResult, employeeResult] = await Promise.all([
    client.from('blocking_schedules').select('id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on,is_active,created_by,timezone,employee_schedule_id').order('created_at', { ascending: false }),
    client.from('website_blocking_rules').select('id,domain,target_profile_id,is_active,created_by').order('created_at', { ascending: false }),
    client.from('blocking_schedule_assignments').select('schedule_id,employee_id,laptop_id'),
    client.from('employees').select('id,profile_id'),
  ]);
  if (scheduleResult.error && /timezone|employee_schedule_id/i.test(scheduleResult.error.message)) {
    const fallbackScheduleResult = await client.from('blocking_schedules')
      .select('id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on,is_active,created_by,employee_schedule_id')
      .order('created_at', { ascending: false });
    if (fallbackScheduleResult.error && /employee_schedule_id/i.test(fallbackScheduleResult.error.message)) {
      const legacyScheduleResult = await client.from('blocking_schedules')
        .select('id,name,scope,start_time,end_time,days_of_week,starts_on,expires_on,is_active,created_by')
        .order('created_at', { ascending: false });
      scheduleResult.data = (legacyScheduleResult.data || []).map((schedule) => ({ ...schedule, timezone: 'Asia/Manila' }));
      scheduleResult.error = legacyScheduleResult.error;
    } else {
      scheduleResult.data = (fallbackScheduleResult.data || []).map((schedule) => ({ ...schedule, timezone: 'Asia/Manila' }));
      scheduleResult.error = fallbackScheduleResult.error;
    }
  }
  if (scheduleResult.error || ruleResult.error || assignmentResult.error || employeeResult.error) {
    return legacyQuery();
  }
  let linkedRuleResult = await client.from('website_blocking_rules')
    .select('id,domain,schedule_id,target_profile_id,is_active,created_by')
    .order('created_at', { ascending: false });
  if (linkedRuleResult.error) {
    linkedRuleResult = { data: [], error: null };
  }
  const schedules = new Map((scheduleResult.data || []).map((row) => [row.id, row]));
  const assignmentBySchedule = new Map();
  const employeeProfiles = new Map((employeeResult.data || []).map((employee) => [employee.id, employee.profile_id]));
  (assignmentResult.data || []).forEach((assignment) => {
    if (!assignmentBySchedule.has(assignment.schedule_id)) assignmentBySchedule.set(assignment.schedule_id, assignment);
  });
  const rulesByDomain = new Map();
  (ruleResult.data || []).forEach((rule) => {
    const domain = normalizeBlockingDomain(rule.domain);
    if (!rulesByDomain.has(domain)) rulesByDomain.set(domain, []);
    rulesByDomain.get(domain).push(rule);
  });
  const data = [...schedules.values()].flatMap((schedule) => {
    const linkedRules = (linkedRuleResult.data || []).filter((rule) => rule.schedule_id === schedule.id);
    const matchingRules = linkedRules.length
      ? linkedRules
      : (rulesByDomain.get(normalizeBlockingDomain(schedule.name)) || []);
    const assignment = assignmentBySchedule.get(schedule.id);
    return matchingRules.map((rule) => ({
      ...rule,
      schedule_id: schedule.id,
      start_time: schedule.start_time || '00:00',
      end_time: schedule.end_time || '23:59',
      days_of_week: normalizeBlockingDays(schedule.days_of_week),
      starts_on: schedule.starts_on || null,
      expires_on: schedule.expires_on || null,
      employee_schedule_id: schedule.employee_schedule_id || null,
      timezone: schedule.timezone || 'Asia/Manila',
      target_profile_id: rule.target_profile_id || employeeProfiles.get(assignment?.employee_id) || null,
      is_active: rule.is_active && schedule.is_active !== false,
      created_by: rule.created_by || schedule.created_by,
    }));
  });
  return { canonical: true, data };
}

async function loadDashboardData() {
  const client = getSupabaseClient();
  if (!client || !adminUser) return;
  setDashboardState('Loading dashboard data…');
  try {
    const { error: connectionCloseError } = await client.rpc('close_stale_device_connections');
    if (connectionCloseError) throw connectionCloseError;
    const { error: assignmentCloseError } = await client.rpc('close_expired_laptop_assignments');
    if (assignmentCloseError && !/close_expired_laptop_assignments/i.test(assignmentCloseError.message)) throw assignmentCloseError;
    const results = await Promise.all([
      client.from('employees').select('id,profile_id,user_id,department,position,active').order('created_at', { ascending: false }),
      client.from('profiles').select('id,full_name,email,department,position,account_status'),
      client.from('user_roles').select('profile_id,role_name').is('revoked_at', null),
      client.from('laptops').select('id,laptop_id,device_registration_id,device_name,manufacturer,model,serial_number,mac_address,operating_system,browser,extension_version,status,last_sync_at,last_seen_at,connectivity_status,work_session_id').order('created_at', { ascending: false }),
      client.from('laptop_assignments').select('id,employee_id,laptop_id,status,assigned_at,ended_at,expires_at').order('assigned_at', { ascending: false }),
      client.from('change_logs').select('id,action,module_name,created_at').order('created_at', { ascending: false }).limit(8),
      client.from('notifications').select('id,title,body,link,is_read,created_at').eq('user_id', adminUser.id).order('created_at', { ascending: false }).limit(10),
      client.from('device_registrations').select('id,laptop_id,registration_id,mac_address,is_active,last_heartbeat_at,created_at,revoked_at').order('created_at', { ascending: false }),
      client.from('device_connection_logs').select('id,laptop_id,employee_id,device_registration_id,connection_started_at,connection_ended_at,last_heartbeat_at,connection_status,recorded_at').order('recorded_at', { ascending: false }).limit(500),
      client.from('system_settings').select('setting_key,setting_value'),
    ]);
    let laptopResult = results[3];
    if (laptopResult.error && /mac_address|connectivity_status|work_session_id/i.test(laptopResult.error.message)) {
      laptopResult = await client.from('laptops')
        .select('id,laptop_id,device_registration_id,device_name,manufacturer,model,serial_number,operating_system,browser,extension_version,status,last_sync_at,last_seen_at')
        .order('created_at', { ascending: false });
      if (!laptopResult.error) {
        laptopResult.data = (laptopResult.data || []).map((laptop) => ({
          ...laptop,
          mac_address: '',
          connectivity_status: 'Offline',
          work_session_id: null,
        }));
      }
    }
    const failed = results.filter((_, index) => index !== 3).find((result) => result.error);
    if (failed?.error) throw failed.error;
    if (laptopResult.error) throw laptopResult.error;
    deviceMonitoringSchemaReady = true;
    const policyResult = await loadBlockingPolicies(client);
    blockingScheduleSchemaReady = policyResult.canonical;
    const scheduleResult = await client.from('employee_schedules')
      .select('id,employee_id,start_date,end_date,working_days,start_time,end_time,lunch_enabled,lunch_start,lunch_end,timezone,is_active,created_at')
      .order('created_at', { ascending: false });
    if (scheduleResult.error && !/employee_schedules/i.test(scheduleResult.error.message)) throw scheduleResult.error;
    employeeSchedules = scheduleResult.error ? [] : (scheduleResult.data || []);
    const defaultWebsiteResult = await client.from('default_blocking_websites')
      .select('id,template_id,domain,is_active')
      .order('domain', { ascending: true });
    const defaultTemplateResult = await client.from('default_blocking_templates')
      .select('id,name,is_active,created_at')
      .order('name', { ascending: true });
    if (defaultWebsiteResult.error || defaultTemplateResult.error) {
      const error = defaultWebsiteResult.error || defaultTemplateResult.error;
      throw new Error(`Default website templates could not be loaded. Run migration 027_named_bulk_blocking_templates.sql. ${error.message}`);
    }
    const websitesByTemplate = new Map();
    (defaultWebsiteResult.data || []).forEach((website) => {
      if (!websitesByTemplate.has(website.template_id)) websitesByTemplate.set(website.template_id, []);
      websitesByTemplate.get(website.template_id).push(website);
    });
    defaultBlockingTemplates = (defaultTemplateResult.data || []).map((template) => ({
      ...template,
      websites: websitesByTemplate.get(template.id) || [],
    }));
    await loadTicketCategories(client);
    const [employeeResult, profileResult, roleResult, , assignmentResult, logResult, notificationResult, registrationResult, historyResult, settingResult] = results;
    systemSettings = Object.fromEntries((settingResult.data || []).map((row) => [row.setting_key, row.setting_value]));
    const profiles = new Map((profileResult.data || []).map((profile) => [profile.id, profile]));
    const roles = new Map((roleResult.data || []).map((role) => [role.profile_id, role.role_name]));
    directoryEmployees = (employeeResult.data || []).map((employee) => {
      const profile = profiles.get(employee.profile_id) || {};
      return {
        ...employee,
        userId: employee.user_id,
        name: profile.full_name || 'Unknown employee',
        email: profile.email || '',
        account_status: profile.account_status || (employee.active ? 'Active' : 'Suspended'),
        department: employee.department || profile.department || '',
        position: employee.position || profile.position || '',
        role: roles.get(employee.profile_id) || 'Employee',
      };
    });
    renderEmployeeSchedules();
    const targetEmployeeSelect = document.getElementById('blockingTargetEmployee');
    if (targetEmployeeSelect) {
      const selectedProfileId = targetEmployeeSelect.value;
      const eligibleEmployees = directoryEmployees.filter((employee) => employee.active);
      targetEmployeeSelect.innerHTML = '<option value="">Select an employee</option>' + eligibleEmployees.map((employee) => (
        `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)} (${escapeHtml(employee.user_id)})</option>`
      )).join('');
      if (eligibleEmployees.some((employee) => employee.id === selectedProfileId)) {
        targetEmployeeSelect.value = selectedProfileId;
      }
      targetEmployeeSelect.disabled = false;
    }
    const bulkTargetSelect = document.getElementById('bulkBlockingTargetEmployee');
    if (bulkTargetSelect) {
      const selectedProfileId = bulkTargetSelect.value;
      const eligibleEmployees = directoryEmployees.filter((employee) => employee.active);
      bulkTargetSelect.innerHTML = '<option value="">Select an employee</option>' + eligibleEmployees.map((employee) => (
        `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)} (${escapeHtml(employee.user_id)})</option>`
      )).join('');
      if (eligibleEmployees.some((employee) => employee.id === selectedProfileId)) {
        bulkTargetSelect.value = selectedProfileId;
      }
      bulkTargetSelect.disabled = false;
    }
    directoryLaptops = laptopResult.data || [];
    const employeesById = new Map(directoryEmployees.map((employee) => [employee.id, employee]));
    const laptopsById = new Map(directoryLaptops.map((laptop) => [laptop.id, laptop]));
    directoryAssignments = (assignmentResult.data || [])
      .filter((assignment) => employeesById.has(assignment.employee_id) && laptopsById.has(assignment.laptop_id))
      .map((assignment) => ({
        ...assignment,
        employee: employeesById.get(assignment.employee_id),
        laptop: laptopsById.get(assignment.laptop_id),
      }));
    deviceRegistrations = registrationResult.data || [];
    connectionHistory = historyResult.data || [];
    renderAnalyticsEmployeeFilter();
    renderConnectionFilterOptions();
    blockingRules = policyResult.data || [];
    activityLogs = logResult.data || [];
    notifications = notificationResult.data || [];
    renderSettingsForms();
    renderMetricCards();
    renderActivityList();
    renderNotifications();
    renderBlockingTable();
    renderDefaultBlockingTemplates();
    renderBlockingSchedulePreview(document.getElementById('blockingTargetEmployee')?.value, 'singleBlockingSchedulePreview');
    renderBlockingSchedulePreview(document.getElementById('bulkBlockingTargetEmployee')?.value, 'bulkBlockingSchedulePreview');
    renderAssignmentTable();
    renderAssignmentOptions();
    renderEmployeeTable();
    renderUserRoleAssignments();
    renderLaptopTable();
    renderConnectionHistory();
    updateNotificationBell();
    setDashboardState(blockingScheduleSchemaReady
      ? ''
      : 'Website schedules need a database update. Run migration 004_admin_dashboard_workflows.sql to enable schedule days and times.');
  } catch (error) {
    const needsMigration = /close_stale_device_connections|device_connection_logs|credential_hash|revoked_at|device_registrations/i.test(error.message);
    if (needsMigration) deviceMonitoringSchemaReady = false;
    setDashboardState(needsMigration
      ? `Dashboard data could not be loaded: run migration 007_device_registration_monitoring.sql first. ${error.message}`
      : `Dashboard data could not be loaded: ${error.message}`, true);
  }
}

async function refreshDeviceMonitoring() {
  const client = getSupabaseClient();
  if (!client || !adminUser || !deviceMonitoringSchemaReady) return;
  const { error: closeError } = await client.rpc('close_stale_device_connections');
  if (closeError) {
    deviceMonitoringSchemaReady = false;
    showToast(`Connection status could not be refreshed: ${closeError.message}`, true);
    return;
  }
  const [registrationResult, historyResult, laptopResult] = await Promise.all([
    client.from('device_registrations').select('id,laptop_id,registration_id,mac_address,is_active,last_heartbeat_at,created_at,revoked_at').order('created_at', { ascending: false }),
    client.from('device_connection_logs').select('id,laptop_id,employee_id,device_registration_id,connection_started_at,connection_ended_at,last_heartbeat_at,connection_status,recorded_at').order('recorded_at', { ascending: false }).limit(500),
    client.from('laptops').select('id,connectivity_status,work_session_id,last_seen_at'),
  ]);
  if (registrationResult.error || historyResult.error || laptopResult.error) {
    deviceMonitoringSchemaReady = false;
    showToast(`Device monitoring refresh failed: ${(registrationResult.error || historyResult.error || laptopResult.error).message}`, true);
    return;
  }
  deviceRegistrations = registrationResult.data || [];
  connectionHistory = historyResult.data || [];
  const recentHeartbeats = new Map(deviceRegistrations
    .filter((registration) => registration.is_active && registration.last_heartbeat_at)
    .map((registration) => [registration.laptop_id, registration.last_heartbeat_at]));
  const liveLaptopStates = new Map((laptopResult.data || []).map((laptop) => [laptop.id, laptop]));
  directoryLaptops = directoryLaptops.map((laptop) => ({
    ...laptop,
    ...(liveLaptopStates.get(laptop.id) || {}),
    last_seen_at: recentHeartbeats.get(laptop.id) || laptop.last_seen_at,
  }));
  const updatedLaptops = new Map(directoryLaptops.map((laptop) => [laptop.id, laptop]));
  directoryAssignments = directoryAssignments.map((assignment) => ({
    ...assignment,
    laptop: updatedLaptops.get(assignment.laptop_id) || assignment.laptop,
  }));
  renderEmployeeTable();
  renderLaptopTable();
  renderConnectionHistory();
  renderAnalyticsEmployeeFilter();
  if (document.getElementById('analytics').classList.contains('active')) {
    loadAnalyticsData().catch((error) => showToast(`Analytics refresh failed: ${error.message}`, true));
  }
}

function updateNotificationBell() {
  const button = document.getElementById('notificationBellBtn');
  const unread = notifications.filter((notification) => !notification.is_read).length;
  if (!button) return;
  button.setAttribute('aria-label', unread ? `${unread} unread notifications` : 'Notifications');
  button.dataset.count = unread ? String(unread) : '';
}

async function openNotifications() {
  const modal = document.getElementById('notificationsModal');
  const state = document.getElementById('notificationsModalState');
  modal?.classList.remove('hidden');
  state?.classList.add('hidden');
  renderNotifications();
  try {
    const { data, error } = await getSupabaseClient().from('notifications')
      .select('id,title,body,link,is_read,created_at')
      .eq('user_id', adminUser.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    notifications = data || [];
    renderNotifications();
    updateNotificationBell();
  } catch (error) {
    if (state) {
      state.textContent = `Notifications could not be loaded: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    }
  }
}

async function markNotificationsRead(ids) {
  if (!ids.length) return;
  const { error } = await getSupabaseClient().from('notifications')
    .update({ is_read: true })
    .eq('user_id', adminUser.id)
    .in('id', ids);
  if (error) throw error;
  notifications = notifications.map((notification) => (
    ids.includes(notification.id) ? { ...notification, is_read: true } : notification
  ));
  renderNotifications();
  updateNotificationBell();
}

async function openNotificationTicket(notificationId) {
  const notification = notifications.find((item) => item.id === notificationId);
  if (!notification) return false;
  await markNotificationsRead([notificationId]);
  if (!notification.link || !notification.link.toLowerCase().includes('ticket')) return false;
  const ticketNumber = String(notification.body || '').match(/\b[A-Z][A-Z0-9]*-\d+\b/i)?.[0];
  if (!ticketNumber) return false;
  const { data: ticket, error } = await getSupabaseClient().from('tickets')
    .select('id,ticket_number,profile_id,employee_id,laptop_id,subject,issue_category,priority,assigned_to,status,description,created_at,updated_at,profile:profiles!tickets_profile_id_fkey(full_name,email),employee:employees!tickets_employee_id_fkey(user_id),laptop:laptops!tickets_laptop_id_fkey(laptop_id,device_registration_id,model),assigned_staff:profiles!tickets_assigned_to_fkey(full_name)')
    .eq('ticket_number', ticketNumber)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) throw new Error(`Ticket ${ticketNumber} could not be found.`);
  document.getElementById('notificationsModal')?.classList.add('hidden');
  setActiveSection('tickets');
  await openTicketDetail(ticket.id, ticket);
  return true;
}

async function writeChangeLog(action, moduleName, recordId = null, previousValue = null, newValue = null) {
  const client = getSupabaseClient();
  if (!client || !adminUser) return;
  const { error } = await client.from('change_logs').insert({
    user_id: adminUser.id,
    action,
    module_name: moduleName,
    affected_record_id: recordId ? String(recordId) : null,
    previous_value: previousValue,
    new_value: newValue,
  });
  if (error) throw new Error(`The operation was saved, but its activity log could not be written: ${error.message}`);
}

function renderTicketTable() {
  const table = document.getElementById('ticketTable');
  if (!table) return;
  table.innerHTML = ticketsOnPage.map((ticket) => `
    <tr>
      <td><button class="ticket-id-link" type="button" data-ticket-id="${escapeHtml(ticket.id)}">${escapeHtml(ticket.ticket_number)}${ticket.unread ? '<span class="unread-dot" aria-label="Unread message"></span>' : ''}</button></td>
      <td>${escapeHtml(ticket.profile?.full_name || ticket.employee?.user_id || 'Unknown employee')}</td>
      <td>${escapeHtml(ticket.subject)}</td>
      <td>${escapeHtml(ticket.issue_category)}</td>
      <td><span class="status-pill ${ticket.priority === 'High' || ticket.priority === 'Urgent' ? 'warning' : 'neutral'}">${escapeHtml(ticket.priority || 'Normal')}</span></td>
      <td>${escapeHtml(ticket.assigned_staff?.full_name || 'Unassigned')}</td>
      <td><span class="status-pill ${ticket.status === 'Open' ? 'warning' : ticket.status === 'Resolved' ? 'success' : 'neutral'}">${escapeHtml(ticket.status)}</span></td>
      <td>${escapeHtml(formatDate(ticket.created_at))}</td>
      <td>${escapeHtml(formatDate(ticket.updated_at))}</td>
    </tr>
  `).join('');
}

async function ensureAdminSession() {
  const client = getSupabaseClient();
  if (client) {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData.session) {
      window.location.href = 'index.html';
      return false;
    }
    const { data: roleRows, error: roleError } = await client.from('user_roles')
      .select('role_name')
      .eq('profile_id', sessionData.session.user.id)
      .is('revoked_at', null);
    const role = roleRows?.find((row) => row.role_name === 'Administrator' || row.role_name === 'IT Staff')?.role_name;
    if (roleError || !role) {
      await client.auth.signOut();
      window.location.href = 'index.html';
      return false;
    }
    adminUser = { id: sessionData.session.user.id, email: sessionData.session.user.email, role };
    const emailInput = document.querySelector('#changePasswordForm input[type="email"]');
    if (emailInput) emailInput.value = adminUser.email || '';
    const profileUpdate = await client.from('profiles')
      .update({ email: adminUser.email })
      .eq('id', adminUser.id)
      .neq('email', adminUser.email);
    if (profileUpdate.error) {
      setDashboardState(`Profile email could not be synchronized: ${profileUpdate.error.message}`, true);
    }
    return true;
  }
  window.location.href = 'index.html';
  return false;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function getActiveDeviceRegistration(laptop) {
  if (!getActiveLaptopAssignment(laptop.id)) return null;
  return deviceRegistrations.find((registration) => (
    registration.laptop_id === laptop.id && registration.is_active
  )) || null;
}

function getDeviceConnectionStatus(registration) {
  if (!registration) return 'Unregistered';
  if (!registration.last_heartbeat_at) return 'Not Connected';
  const heartbeatAge = Date.now() - new Date(registration.last_heartbeat_at).getTime();
  return heartbeatAge >= -30000 && heartbeatAge < 120000 ? 'Online' : 'Offline';
}

function getActiveLaptopAssignment(laptopId) {
  return directoryAssignments.find((assignment) => assignment.laptop_id === laptopId && assignment.status === 'Active') || null;
}

function getEmployeeLaptopAssignment(employeeId) {
  return directoryAssignments.find((assignment) => assignment.employee_id === employeeId && assignment.status === 'Active') || null;
}

function statusPill(status) {
  const style = status === 'Online' || status === 'Registered' ? 'success'
    : status === 'Offline' ? 'warning' : 'neutral';
  return `<span class="status-pill ${style}">${escapeHtml(status)}</span>`;
}

function renderConnectionHistory() {
  const table = document.getElementById('connectionHistoryTable');
  if (!table) return;
  const employeeId = document.getElementById('connectionEmployeeFilter').value;
  const laptopId = document.getElementById('connectionLaptopFilter').value;
  const from = document.getElementById('connectionDateFrom').value;
  const to = document.getElementById('connectionDateTo').value;
  const laptopsById = new Map(directoryLaptops.map((laptop) => [laptop.id, laptop]));
  const filtered = connectionHistory.filter((entry) => {
    const date = String(entry.recorded_at || entry.connection_started_at || '').slice(0, 10);
    return (!employeeId || entry.employee_id === employeeId)
      && (!laptopId || entry.laptop_id === laptopId)
      && (!from || date >= from)
      && (!to || date <= to);
  });
  table.innerHTML = filtered.length ? filtered.map((entry) => {
    const laptop = laptopsById.get(entry.laptop_id);
    const employee = directoryEmployees.find((row) => row.id === entry.employee_id);
    const registration = laptop ? getActiveDeviceRegistration(laptop) : null;
    return `<tr>
      <td>${escapeHtml(laptop?.laptop_id || 'Unknown laptop')}</td>
      <td>${escapeHtml(employee?.name || 'Unassigned')}</td>
      <td>${escapeHtml(entry.device_registration_id)}</td>
      <td>${escapeHtml(formatDate(entry.connection_started_at))}</td>
      <td>${escapeHtml(entry.connection_ended_at ? formatDate(entry.connection_ended_at) : '—')}</td>
      <td>${escapeHtml(formatDate(entry.last_heartbeat_at))}</td>
      <td>${statusPill(entry.connection_ended_at ? 'Offline' : getDeviceConnectionStatus(registration))}</td>
      <td>${escapeHtml(formatDate(entry.recorded_at))}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="8">No connection history matches these filters.</td></tr>';
}

function renderConnectionFilterOptions() {
  const employeeSelect = document.getElementById('connectionEmployeeFilter');
  const laptopSelect = document.getElementById('connectionLaptopFilter');
  const selectedEmployee = employeeSelect.value;
  const selectedLaptop = laptopSelect.value;
  employeeSelect.innerHTML = '<option value="">All employees</option>' + directoryEmployees.map((employee) => (
    `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)} (${escapeHtml(employee.user_id)})</option>`
  )).join('');
  laptopSelect.innerHTML = '<option value="">All laptops</option>' + directoryLaptops.map((laptop) => (
    `<option value="${escapeHtml(laptop.id)}">${escapeHtml(laptop.laptop_id)}</option>`
  )).join('');
  employeeSelect.value = selectedEmployee;
  laptopSelect.value = selectedLaptop;
}

function setTicketListState(message, isError = false) {
  const state = document.getElementById('ticketListState');
  if (!state) return;
  state.textContent = message;
  state.classList.toggle('error-text', isError);
  state.classList.toggle('hidden', !message);
  if (message && isError) showToast(message, true);
}

async function loadTickets() {
  const client = getSupabaseClient();
  if (!client) {
    ticketsOnPage = [];
    ticketCount = 0;
    ticketStatusCounts = {};
    renderTicketTable();
    renderTicketLegend();
    setTicketListState('Connect Supabase in admin/config.js and sign in to load tickets.');
    updateTicketPagination();
    return;
  }

  const listState = document.getElementById('ticketListState');
  listState.textContent = 'Loading tickets…';
  listState.classList.remove('hidden', 'error-text');

  const query = document.getElementById('ticketSearch').value.trim();
  const status = document.getElementById('ticketStatusFilter').value;
  const category = document.getElementById('ticketCategoryFilter').value;
  const start = ticketPage * TICKET_PAGE_SIZE;
  const end = start + TICKET_PAGE_SIZE - 1;
  let request = client
    .from('tickets')
    .select('id,ticket_number,profile_id,employee_id,laptop_id,subject,issue_category,priority,assigned_to,status,description,created_at,updated_at,profile:profiles!tickets_profile_id_fkey(full_name,email),employee:employees!tickets_employee_id_fkey(user_id),laptop:laptops!tickets_laptop_id_fkey(laptop_id,device_registration_id,model),assigned_staff:profiles!tickets_assigned_to_fkey(full_name)', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(start, end);
  if (status) request = request.eq('status', status);
  if (category) request = request.eq('issue_category', category);
  if (query) request = request.or(`ticket_number.ilike.%${query.replace(/[(),]/g, '')}%,subject.ilike.%${query.replace(/[(),]/g, '')}%`);

  const { data, error, count } = await request;
  if (error) {
    ticketsOnPage = [];
    ticketCount = 0;
    ticketStatusCounts = {};
    renderTicketTable();
    renderTicketLegend();
    setTicketListState(`Could not load tickets: ${error.message}`, true);
    updateTicketPagination();
    return;
  }

  ticketsOnPage = data || [];
  ticketCount = count || 0;
  try {
    await loadTicketStatusCounts(client);
  } catch (summaryError) {
    setTicketListState(`Tickets loaded, but the overview could not be calculated: ${summaryError.message}`, true);
  }
  renderTicketLegend();
  if (ticketsOnPage.length) {
    const ids = ticketsOnPage.map((ticket) => ticket.id);
    const { data: unreadMessages, error: unreadError } = await client
      .from('ticket_messages')
      .select('ticket_id')
      .in('ticket_id', ids)
      .eq('sender_role', 'Employee')
      .eq('is_read', false);
    if (unreadError) {
      setTicketListState(`Tickets loaded, but unread status could not be checked: ${unreadError.message}`, true);
    } else {
      const unreadIds = new Set((unreadMessages || []).map((message) => message.ticket_id));
      ticketsOnPage.forEach((ticket) => { ticket.unread = unreadIds.has(ticket.id); });
    }
  }
  renderTicketTable();
  updateTicketPagination();
  if (!listState.classList.contains('error-text')) {
    setTicketListState(ticketCount ? '' : 'No tickets match these filters.');
  }
}

async function loadTicketStatusCounts(client = getSupabaseClient()) {
  if (!client) return;
  const counts = await Promise.all(TICKET_STATUSES.map(async (status) => {
    const { count, error } = await client.from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (error) throw error;
    return [status, count || 0];
  }));
  ticketStatusCounts = Object.fromEntries(counts);
  renderTicketLegend();
}

function updateTicketPagination() {
  const label = document.getElementById('ticketPageLabel');
  const previous = document.getElementById('ticketPagePrev');
  const next = document.getElementById('ticketPageNext');
  const pageCount = Math.max(1, Math.ceil(ticketCount / TICKET_PAGE_SIZE));
  if (label) label.textContent = ticketCount ? `Page ${ticketPage + 1} of ${pageCount} · ${ticketCount} tickets` : 'No tickets';
  if (previous) previous.disabled = ticketPage <= 0;
  if (next) next.disabled = ticketPage + 1 >= pageCount;
}

function renderTicketInfo(ticket) {
  const info = {
    'Ticket ID': ticket.ticket_number,
    Employee: ticket.profile?.full_name || 'Unknown employee',
    'Employee ID': ticket.employee?.user_id || 'Not linked',
    Laptop: ticket.laptop?.laptop_id || 'Not assigned',
    'Device registration ID': ticket.laptop?.device_registration_id || 'Not registered',
    Category: ticket.issue_category,
    Subject: ticket.subject,
    Description: ticket.description,
    Priority: ticket.priority || 'Normal',
    'Assigned IT staff': ticket.assigned_staff?.full_name || 'Unassigned',
    'Date created': formatDate(ticket.created_at),
    'Last updated': formatDate(ticket.updated_at),
  };
  document.getElementById('ticketDetailNumber').textContent = ticket.ticket_number;
  document.getElementById('ticketDetailStatus').value = ticket.status;
  document.getElementById('ticketAssignedStaffName').textContent = ticket.assigned_staff?.full_name || 'Unassigned';
  document.getElementById('ticketInfoList').innerHTML = Object.entries(info)
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
}

function renderConversation(messages, attachments) {
  const container = document.getElementById('conversationMessages');
  const state = document.getElementById('conversationState');
  if (!container) return;
  if (!messages.length) {
    container.innerHTML = '';
    state.textContent = 'No replies yet. Send a message to start the conversation.';
    state.classList.remove('hidden', 'error-text');
    return;
  }
  state.textContent = '';
  state.classList.add('hidden');
  const attachmentMap = new Map();
  attachments.forEach((attachment) => {
    if (!attachment.message_id) return;
    if (!attachmentMap.has(attachment.message_id)) attachmentMap.set(attachment.message_id, []);
    attachmentMap.get(attachment.message_id).push(attachment);
  });
  container.innerHTML = messages.map((message) => {
    const isStaff = message.sender_role !== 'Employee';
    const messageAttachments = attachmentMap.get(message.id) || [];
    return `<article class="message-bubble ${isStaff ? 'staff-message' : 'employee-message'}">
      <div class="message-meta"><strong>${escapeHtml(message.sender_name || (isStaff ? 'IT staff' : 'Employee'))} · ${escapeHtml(message.sender_role)}</strong><span>${escapeHtml(formatDate(message.created_at))}</span></div>
      <p>${escapeHtml(message.message)}</p>
      ${messageAttachments.filter((attachment) => attachment.signedUrl).map((attachment) => `<a class="attachment-link" href="${escapeHtml(attachment.signedUrl)}" target="_blank" rel="noopener">${escapeHtml(attachment.file_name)}</a>`).join('')}
      ${message.sender_id === adminUser?.id ? `<small class="message-read">${message.is_read ? 'Read' : 'Sent'}</small>` : ''}
    </article>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

async function loadTicketConversation() {
  if (!selectedTicket || !supabaseClient) return;
  const state = document.getElementById('conversationState');
  state.textContent = 'Loading conversation…';
  state.classList.remove('hidden', 'error-text');
  const { data: messages, error } = await supabaseClient
    .from('ticket_messages')
    .select('id,ticket_id,sender_id,sender_name,sender_role,message,created_at,is_read,read_at')
    .eq('ticket_id', selectedTicket.id)
    .order('created_at', { ascending: true });
  if (error) {
    state.textContent = `Could not load conversation: ${error.message}`;
    state.classList.add('error-text');
    return;
  }
  const incomingUnread = (messages || []).filter((message) => message.sender_id !== adminUser.id && !message.is_read);
  if (incomingUnread.length) {
    const { error: readError } = await supabaseClient.from('ticket_messages')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in('id', incomingUnread.map((message) => message.id));
    if (!readError) incomingUnread.forEach((message) => { message.is_read = true; });
  }
  const { data: attachmentRows, error: attachmentError } = await supabaseClient
    .from('ticket_attachments')
    .select('id,file_name,storage_path,uploaded_by,message_id')
    .eq('ticket_id', selectedTicket.id);
  if (attachmentError) {
    state.textContent = `Messages loaded, but attachments failed to load: ${attachmentError.message}`;
    state.classList.add('error-text');
    return;
  }
  let attachmentLinkFailures = 0;
  const attachments = await Promise.all((attachmentRows || []).map(async (attachment) => {
    const { data, error: signedUrlError } = await supabaseClient.storage
      .from('ticket-attachments')
      .createSignedUrl(attachment.storage_path, 300);
    if (signedUrlError) attachmentLinkFailures += 1;
    return { ...attachment, signedUrl: signedUrlError ? '' : data.signedUrl };
  }));
  renderConversation(messages || [], attachments);
  if (attachmentLinkFailures) {
    state.textContent = `${attachmentLinkFailures} attachment link(s) could not be loaded.`;
    state.classList.remove('hidden');
    state.classList.add('error-text');
  }
  const unreadBadge = document.getElementById('ticketUnreadBadge');
  const hasEmployeeUnread = (messages || []).some((message) => message.sender_role === 'Employee' && !message.is_read);
  unreadBadge.classList.toggle('hidden', !hasEmployeeUnread);
  setTicketListState('', false);
}

function subscribeToTicket(ticketId) {
  if (ticketRealtimeChannel) supabaseClient.removeChannel(ticketRealtimeChannel);
  const connection = document.getElementById('conversationConnection');
  ticketRealtimeChannel = supabaseClient
    .channel(`ticket-conversation-${ticketId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_messages', filter: `ticket_id=eq.${ticketId}` }, () => {
      loadTicketConversation();
      loadTickets();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `id=eq.${ticketId}` }, refreshSelectedTicket)
    .subscribe((status) => {
      if (connection) {
        connection.textContent = status === 'SUBSCRIBED' ? 'Realtime connected' : 'Connecting…';
        connection.className = `pill ${status === 'SUBSCRIBED' ? 'success' : 'neutral'}`;
      }
    });
}

function closeTicketDetail() {
  if (ticketRealtimeChannel && supabaseClient) supabaseClient.removeChannel(ticketRealtimeChannel);
  if (ticketPollTimer) window.clearInterval(ticketPollTimer);
  ticketRealtimeChannel = null;
  ticketPollTimer = null;
  selectedTicket = null;
  document.getElementById('ticketDetailView').classList.add('hidden');
  document.getElementById('ticketListView').classList.remove('hidden');
  loadTickets();
}

async function openTicketDetail(ticketId, ticketRecord = null) {
  let ticket = ticketRecord || ticketsOnPage.find((row) => row.id === ticketId);
  if (!ticket) return;
  const detailState = document.getElementById('ticketDetailState');
  detailState.textContent = '';
  detailState.classList.remove('error-text');
  if (ticket.assigned_to !== adminUser.id) {
    detailState.textContent = 'Assigning this ticket to you…';
    try {
      const { error: assignmentError } = await supabaseClient.rpc('assign_ticket_staff', {
        target_ticket_id: ticket.id,
        target_profile_id: adminUser.id,
      });
      if (assignmentError) throw assignmentError;
      const { data: updatedTicket, error: ticketError } = await supabaseClient.from('tickets')
        .select('id,ticket_number,profile_id,employee_id,laptop_id,subject,issue_category,priority,assigned_to,status,description,created_at,updated_at,profile:profiles!tickets_profile_id_fkey(full_name,email),employee:employees!tickets_employee_id_fkey(user_id),laptop:laptops!tickets_laptop_id_fkey(laptop_id,device_registration_id,model),assigned_staff:profiles!tickets_assigned_to_fkey(full_name)')
        .eq('id', ticket.id)
        .single();
      if (ticketError) throw ticketError;
      ticket = updatedTicket;
      detailState.textContent = 'Ticket assigned to you.';
    } catch (error) {
      detailState.textContent = `Could not assign this ticket to you: ${error.message}`;
      detailState.classList.add('error-text');
    }
  }
  selectedTicket = ticket;
  document.getElementById('ticketListView').classList.add('hidden');
  document.getElementById('ticketDetailView').classList.remove('hidden');
  if (ticket.assigned_to === adminUser.id) detailState.classList.remove('error-text');
  document.getElementById('internalNotesList').innerHTML = '<li>Loading private notes…</li>';
  renderTicketInfo(ticket);
  await Promise.all([loadTicketConversation(), loadInternalNotes(), loadTicketAssignmentHistory()]);
  subscribeToTicket(ticket.id);
  if (ticketPollTimer) window.clearInterval(ticketPollTimer);
  ticketPollTimer = window.setInterval(() => {
    loadTicketConversation();
    refreshSelectedTicket();
    loadTickets();
  }, 15000);
}

async function loadTicketAssignmentHistory() {
  if (!selectedTicket || !supabaseClient) return;
  const list = document.getElementById('ticketAssignmentHistory');
  const { data, error } = await supabaseClient.from('ticket_assignments')
    .select('id,assigned_at,ended_at,assignee:profiles!ticket_assignments_assigned_to_fkey(full_name),assigner:profiles!ticket_assignments_assigned_by_fkey(full_name)')
    .eq('ticket_id', selectedTicket.id)
    .order('assigned_at', { ascending: false });
  if (error) {
    list.innerHTML = `<li class="error-text">Could not load assignment history: ${escapeHtml(error.message)}</li>`;
    return;
  }
  list.innerHTML = data.length ? data.map((assignment) => `<li>
    <strong>${escapeHtml(assignment.assignee?.full_name || 'IT staff')}</strong>
    <time>${escapeHtml(formatDate(assignment.assigned_at))}</time>
    <p>${assignment.ended_at ? `Ended ${escapeHtml(formatDate(assignment.ended_at))}` : 'Current assignment'} · Assigned by ${escapeHtml(assignment.assigner?.full_name || 'IT staff')}</p>
  </li>`).join('') : '<li>No assignment history.</li>';
}

async function loadInternalNotes() {
  if (!selectedTicket || !supabaseClient) return;
  const list = document.getElementById('internalNotesList');
  const { data, error } = await supabaseClient.from('ticket_internal_notes')
    .select('id,note,created_at,author:profiles!ticket_internal_notes_author_id_fkey(full_name)')
    .eq('ticket_id', selectedTicket.id)
    .order('created_at', { ascending: true });
  if (error) {
    list.innerHTML = `<li class="error-text">Could not load private notes: ${escapeHtml(error.message)}</li>`;
    return;
  }
  list.innerHTML = data.length ? data.map((note) => `<li><strong>${escapeHtml(note.author?.full_name || 'IT staff')}</strong><time>${escapeHtml(formatDate(note.created_at))}</time><p>${escapeHtml(note.note)}</p></li>`).join('') : '<li>No private notes.</li>';
}

async function sendTicketReply(event) {
  event.preventDefault();
  if (!selectedTicket || !supabaseClient || !adminUser) return;
  const button = document.getElementById('sendTicketReplyBtn');
  const input = document.getElementById('ticketReplyInput');
  const fileInput = document.getElementById('ticketAttachmentInput');
  const file = fileInput.files[0];
  const message = input.value.trim();
  if (!message && !file) {
    input.setCustomValidity('Enter a reply or attach a file.');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  button.disabled = true;
  button.textContent = 'Sending…';
  let uploadedPath = '';
  try {
    if (file) {
      if (file.size > 10 * 1024 * 1024) throw new Error('Attachments must be 10 MB or smaller.');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${selectedTicket.id}/${crypto.randomUUID()}-${safeName}`;
      const { error: uploadError } = await supabaseClient.storage.from('ticket-attachments')
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (uploadError) throw uploadError;
      uploadedPath = path;
    }
    const { data: sentMessage, error } = await supabaseClient.from('ticket_messages').insert({
      ticket_id: selectedTicket.id,
      sender_id: adminUser.id,
      sender_role: adminUser.role,
      message: message || `Attached a file: ${file.name}`,
    }).select('id').single();
    if (error) throw error;
    let attachmentError = null;
    if (file && uploadedPath) {
      const { error: metadataError } = await supabaseClient.from('ticket_attachments').insert({
        ticket_id: selectedTicket.id,
        message_id: sentMessage.id,
        file_name: file.name,
        storage_path: uploadedPath,
        content_type: file.type,
        uploaded_by: adminUser.id,
      });
      attachmentError = metadataError;
      if (metadataError) await supabaseClient.storage.from('ticket-attachments').remove([uploadedPath]);
    }
    input.value = '';
    fileInput.value = '';
    await loadTicketConversation();
    await loadTickets();
    document.getElementById('ticketDetailState').textContent = attachmentError
      ? `Reply sent, but the attachment could not be linked: ${attachmentError.message}`
      : '';
  } catch (error) {
    if (uploadedPath) await supabaseClient.storage.from('ticket-attachments').remove([uploadedPath]);
    document.getElementById('ticketDetailState').textContent = `Reply was not sent: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Send reply';
  }
}

async function loadAnalyticsData() {
  if (analyticsLoadInProgress) {
    analyticsRefreshPending = true;
    return;
  }
  analyticsLoadInProgress = true;
  const client = getSupabaseClient();
  const state = document.getElementById('analyticsState');
  try {
    if (!client) {
      state.textContent = 'Configure Supabase in admin/config.js to load real browsing analytics.';
      return;
    }
    state.textContent = 'Loading analytics…';
    const since = getPhilippinesStartOfDay();
    since.setUTCDate(since.getUTCDate() - 6);
    const records = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from('website_usage_logs')
        .select('id,employee_id,profile_id,domain,visit_count,total_seconds,bytes_used,recorded_at')
        .gte('recorded_at', since.toISOString())
        .order('recorded_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + 999);
      if (error) {
        state.textContent = `Could not load analytics: ${error.message}`;
        state.classList.add('error-text');
        return;
      }
      records.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    analyticsRecords = records;
    state.classList.remove('error-text');
    renderAnalyticsData(analyticsRecords);
    renderBarChart();
  } finally {
    analyticsLoadInProgress = false;
    if (analyticsRefreshPending) {
      analyticsRefreshPending = false;
      scheduleAnalyticsRefresh();
    }
  }
}

function renderAnalyticsData(records) {
  const stats = document.getElementById('analyticsStats');
  const chart = document.getElementById('analyticsChart');
  const sites = document.getElementById('topSitesList');
  const state = document.getElementById('analyticsState');
  const title = document.getElementById('analyticsChartTitle');
  const visibleRecords = getSelectedAnalyticsRecords(records);
  const labels = getPhilippinesDayKeys();
  const recordsByDay = new Map();
  visibleRecords.forEach((row) => {
    const dateKey = getPhilippinesDateKey(new Date(row.recorded_at));
    const daily = recordsByDay.get(dateKey) || [];
    daily.push(row);
    recordsByDay.set(dateKey, daily);
  });
  const byDay = labels.map((date) => {
    const rows = recordsByDay.get(date) || [];
    return {
      label: formatAnalyticsDay(date),
      time: rows.reduce((sum, row) => sum + (Number(row.total_seconds) || 0), 0),
      data: rows.reduce((sum, row) => sum + (Number(row.bytes_used) || 0), 0) / (1024 * 1024),
      visits: rows.reduce((sum, row) => sum + (Number(row.visit_count) || 0), 0),
    };
  });
  const timeTotal = visibleRecords.reduce((sum, row) => sum + (Number(row.total_seconds) || 0), 0);
  const mbTotal = visibleRecords.reduce((sum, row) => sum + (Number(row.bytes_used) || 0), 0) / (1024 * 1024);
  const uniqueSites = new Set(visibleRecords.map((row) => row.domain).filter(Boolean)).size;
  stats.innerHTML = [
    { label: 'Time spent', value: `${(timeTotal / 3600).toFixed(1)} h`, trend: 'last 7 days' },
    { label: 'Data usage', value: `${mbTotal.toFixed(2)} MB`, trend: 'last 7 days' },
    { label: 'Unique websites', value: String(uniqueSites), trend: 'last 7 days' },
  ].map((item) => `<article class="stat-card"><span class="metric-label">${item.label}</span><strong class="metric-value">${item.value}</strong><span class="metric-trend positive">${item.trend}</span></article>`).join('');
  renderAnalyticsWebsiteTable(visibleRecords);
  if (selectedAnalyticsEmployeeId) renderAnalyticsEmployeeDetail(selectedAnalyticsEmployeeId);
  const metric = analyticsMetric === 'data' ? 'data' : analyticsMetric === 'sites' ? 'visits' : 'time';
  const metricTitle = analyticsMetric === 'data' ? 'Data usage (MB)' : analyticsMetric === 'sites' ? 'Website visits' : 'Website time spent';
  title.textContent = metricTitle;
  sites.classList.toggle('hidden', analyticsMetric !== 'sites');
  chart.classList.toggle('hidden', analyticsMetric === 'sites');
  if (analyticsMetric === 'sites') {
    const rankedSites = new Map();
    visibleRecords.forEach((row) => rankedSites.set(row.domain, (rankedSites.get(row.domain) || 0) + (Number(row.visit_count) || 0)));
    sites.innerHTML = [...rankedSites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([domain, visits]) => `<li><span class="dot"></span><span>${escapeHtml(domain)} — ${visits} visits</span></li>`).join('');
    state.textContent = visibleRecords.length ? '' : 'No usage records were reported for this selection in the last 7 days.';
  } else {
    const max = Math.max(...byDay.map((row) => row[metric]), 0);
    chart.innerHTML = byDay.map((row) => {
      const value = row[metric];
      const height = max ? Math.max(4, value / max * 100) : 0;
      const displayValue = analyticsMetric === 'data' ? `${value.toFixed(1)} MB` : `${(value / 3600).toFixed(1)} h`;
      return `<div class="graph-column"><span class="graph-value">${displayValue}</span><div class="graph-track"><i style="height:${height}%"></i></div><small>${row.label}</small></div>`;
    }).join('');
    state.textContent = visibleRecords.length ? '' : 'No usage records were reported for this selection in the last 7 days.';
  }
  state.classList.toggle('hidden', Boolean(visibleRecords.length));
}

async function syncSystem() {
  const button = document.getElementById('syncSystemBtn');
  const status = document.getElementById('syncStatus');
  const client = getSupabaseClient();
  if (!client) {
    status.textContent = 'Sync unavailable: configure Supabase';
    setTicketListState('Configure Supabase in admin/config.js before syncing live records.');
    return;
  }
  button.disabled = true;
  button.classList.add('is-syncing');
  status.textContent = 'Syncing system…';
  try {
    await Promise.all([loadDashboardData(), loadTickets(), loadAnalyticsData()]);
    status.textContent = `Last sync: ${formatDate(new Date().toISOString())}`;
  } catch (error) {
    status.textContent = `Sync failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.classList.remove('is-syncing');
  }
}

function scheduleDeviceMonitoringRefresh() {
  if (monitoringRefreshTimeout !== null) return;
  monitoringRefreshTimeout = window.setTimeout(() => {
    monitoringRefreshTimeout = null;
    refreshDeviceMonitoring().catch((error) => showToast(`Device monitoring refresh failed: ${error.message}`, true));
  }, 500);
}

function setupMonitoringRealtime() {
  if (!supabaseClient || monitoringRealtimeChannel) return;
  monitoringRealtimeChannel = supabaseClient
    .channel('admin-device-monitoring')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'laptops' }, scheduleDeviceMonitoringRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_registrations' }, scheduleDeviceMonitoringRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_connection_logs' }, scheduleDeviceMonitoringRefresh)
    .subscribe();
}

function scheduleAnalyticsRefresh() {
  if (analyticsRefreshTimeout !== null) window.clearTimeout(analyticsRefreshTimeout);
  analyticsRefreshTimeout = window.setTimeout(() => {
    analyticsRefreshTimeout = null;
    loadAnalyticsData().catch((error) => {
      const state = document.getElementById('analyticsState');
      state.textContent = `Could not refresh analytics: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    });
  }, 500);
}

function setupAnalyticsRealtime() {
  if (!supabaseClient || analyticsRealtimeChannel) return;
  analyticsRealtimeChannel = supabaseClient
    .channel('admin-analytics-activity')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'website_usage_logs' }, scheduleAnalyticsRefresh)
    .subscribe();
}

function setupTicketListRealtime() {
  if (!supabaseClient || ticketListRealtimeChannel) return;
  ticketListRealtimeChannel = supabaseClient
    .channel('admin-ticket-list')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, () => {
      loadTickets();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ticket_messages' }, () => loadTickets())
    .subscribe();
}

async function loadTicketCategories(client = getSupabaseClient()) {
  if (!client) return;
  const { data, error } = await client.from('ticket_categories')
    .select('category_name')
    .eq('is_active', true)
    .order('category_name');
  if (error) throw new Error(`Could not load ticket categories: ${error.message}`);
  ticketCategories = (data || []).map((row) => row.category_name);
  const select = document.getElementById('ticketCategoryFilter');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '<option value="">All categories</option>' + ticketCategories
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    .join('');
  if (ticketCategories.includes(previous)) select.value = previous;
}

function renderEmployeeSchedules() {
  const employeeSelect = document.getElementById('scheduleEmployee');
  if (employeeSelect) {
    const selected = employeeSelect.value;
    employeeSelect.innerHTML = '<option value="">Select employee</option>' + directoryEmployees
      .filter((employee) => employee.active)
      .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)} (${escapeHtml(employee.user_id)})</option>`)
      .join('');
    if (selected) employeeSelect.value = selected;
  }

  const employeesById = new Map(directoryEmployees.map((employee) => [employee.id, employee]));
  const table = document.getElementById('employeeScheduleTable');
  if (!table) return;
  table.innerHTML = employeeSchedules.map((schedule) => {
    const employee = employeesById.get(schedule.employee_id);
    const employeeName = employee?.name || 'Unknown employee';
    const initials = employeeName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?';
    const workingDays = (schedule.working_days || [])
      .map((day) => `<span class="schedule-day">${escapeHtml(day)}</span>`)
      .join('');
    const startDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${schedule.start_date}T00:00:00`));
    const endDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${schedule.end_date}T00:00:00`));
    return `<tr>
      <td><div class="schedule-employee"><span class="schedule-avatar">${escapeHtml(initials)}</span><div><strong>${escapeHtml(employeeName)}</strong><small>${escapeHtml(employee?.user_id || '')}</small></div></div></td>
      <td><div class="schedule-date"><strong>${escapeHtml(startDate)}</strong><small>to ${escapeHtml(endDate)}</small></div></td>
      <td><div class="schedule-days">${workingDays || '<span class="schedule-day">—</span>'}</div></td>
      <td><div class="schedule-time"><strong>${escapeHtml(String(schedule.start_time).slice(0, 5))} – ${escapeHtml(String(schedule.end_time).slice(0, 5))}</strong><small>Asia/Manila</small></div></td>
      <td><div class="schedule-time"><strong>${schedule.lunch_enabled ? `${escapeHtml(String(schedule.lunch_start).slice(0, 5))} – ${escapeHtml(String(schedule.lunch_end).slice(0, 5))}` : 'No lunch'}</strong><small>${schedule.lunch_enabled ? 'Lunch pause' : 'No break configured'}</small></div></td>
      <td><span class="pill ${schedule.is_active ? 'success' : 'neutral'}">${schedule.is_active ? 'Active' : 'Inactive'}</span></td>
      <td><div class="schedule-actions-cell"><button type="button" class="text-btn edit-employee-schedule" data-schedule-id="${escapeHtml(schedule.id)}">Edit</button>
        <button type="button" class="text-btn employee-schedule-toggle" data-schedule-id="${escapeHtml(schedule.id)}">${schedule.is_active ? 'Deactivate' : 'Activate'}</button></div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7">No employee schedules configured.</td></tr>';
}

function setupEmployeeScheduleInteractions() {
  const form = document.getElementById('employeeScheduleForm');
  const resetBtn = document.getElementById('resetEmployeeScheduleBtn');
  const resetForm = () => {
    form.reset();
    form.elements.scheduleId.value = '';
    form.elements.lunchStart.disabled = true;
    form.elements.lunchEnd.disabled = true;
  };
  if (resetBtn) resetBtn.addEventListener('click', resetForm);
  form.elements.lunchEnabled.addEventListener('change', () => {
    const enabled = form.elements.lunchEnabled.checked;
    form.elements.lunchStart.disabled = !enabled;
    form.elements.lunchEnd.disabled = !enabled;
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = document.getElementById('employeeScheduleState');
    const workingDays = [...form.querySelectorAll('input[name="workingDays"]:checked')].map((input) => input.value);
    if (!workingDays.length) {
      state.textContent = 'Select at least one working day.';
      state.classList.remove('hidden');
      state.classList.add('error-text');
      return;
    }
    if (form.elements.startDate.value > form.elements.endDate.value) {
      state.textContent = 'End date must be on or after the start date.';
      state.classList.remove('hidden');
      state.classList.add('error-text');
      return;
    }
    if (form.elements.startTime.value >= form.elements.endTime.value) {
      state.textContent = 'Start time must be before end time.';
      state.classList.remove('hidden');
      state.classList.add('error-text');
      return;
    }
    const lunchEnabled = form.elements.lunchEnabled.checked;
    const lunchStart = form.elements.lunchStart.value;
    const lunchEnd = form.elements.lunchEnd.value;
    if (lunchEnabled && !(form.elements.startTime.value < lunchStart && lunchStart < lunchEnd && lunchEnd < form.elements.endTime.value)) {
      state.textContent = 'Set lunch start and lunch end between the work start and end times.';
      state.classList.remove('hidden');
      state.classList.add('error-text');
      return;
    }
    const values = {
      employee_id: form.elements.employeeId.value,
      start_date: form.elements.startDate.value,
      end_date: form.elements.endDate.value,
      working_days: workingDays,
      start_time: form.elements.startTime.value,
      end_time: form.elements.endTime.value,
      lunch_enabled: lunchEnabled,
      lunch_start: lunchEnabled ? lunchStart : null,
      lunch_end: lunchEnabled ? lunchEnd : null,
      timezone: 'Asia/Manila',
      is_active: form.elements.isActive.value === 'true',
    };
    try {
      const client = getSupabaseClient();
      let result;
      if (form.elements.scheduleId.value) {
        result = await client.from('employee_schedules').update(values).eq('id', form.elements.scheduleId.value);
      } else {
        values.created_by = adminUser.id;
        result = await client.from('employee_schedules').insert(values);
      }
      if (result.error) throw result.error;
      state.textContent = 'Schedule saved.';
      state.classList.remove('hidden', 'error-text');
      resetForm();
      await loadDashboardData();
    } catch (error) {
      state.textContent = `Could not save schedule: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    }
  });

  document.addEventListener('click', (event) => {
    const editButton = event.target instanceof Element ? event.target.closest('.edit-employee-schedule') : null;
    if (editButton) {
      const schedule = employeeSchedules.find((row) => row.id === editButton.dataset.scheduleId);
      if (!schedule) return;
      form.elements.scheduleId.value = schedule.id;
      form.elements.employeeId.value = schedule.employee_id;
      form.elements.startDate.value = schedule.start_date;
      form.elements.endDate.value = schedule.end_date;
      form.elements.startTime.value = String(schedule.start_time).slice(0, 5);
      form.elements.endTime.value = String(schedule.end_time).slice(0, 5);
      form.elements.lunchEnabled.checked = Boolean(schedule.lunch_enabled);
      form.elements.lunchStart.value = schedule.lunch_start ? String(schedule.lunch_start).slice(0, 5) : '';
      form.elements.lunchEnd.value = schedule.lunch_end ? String(schedule.lunch_end).slice(0, 5) : '';
      form.elements.lunchStart.disabled = !schedule.lunch_enabled;
      form.elements.lunchEnd.disabled = !schedule.lunch_enabled;
      form.elements.isActive.value = String(schedule.is_active);
      form.querySelectorAll('input[name="workingDays"]').forEach((input) => {
        input.checked = (schedule.working_days || []).includes(input.value);
      });
      setActiveSection('schedules');
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const toggleButton = event.target instanceof Element ? event.target.closest('.employee-schedule-toggle') : null;
    if (!toggleButton) return;
    const schedule = employeeSchedules.find((row) => row.id === toggleButton.dataset.scheduleId);
    if (!schedule) return;
    (async () => {
      try {
        const { error } = await getSupabaseClient()
          .from('employee_schedules')
          .update({ is_active: !schedule.is_active })
          .eq('id', schedule.id);
        if (error) throw error;
        await loadDashboardData();
      } catch (error) {
        showToast(`Could not update schedule: ${error.message}`, true);
      }
    })();
  });
}

function setActiveSection(name) {
  document.querySelectorAll('.nav-link[data-section]').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === name);
  });

  document.querySelectorAll('.module-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === name);
  });

  const pageTitle = document.getElementById('pageTitle');
  if (pageTitle) {
    const titleMap = {
      dashboard: 'Dashboard',
      analytics: 'Analytics',
      blocking: 'Website Blocking Schedule',
      schedules: 'Schedules',
      assign: 'Assign Employee',
      employees: 'Employee',
      laptops: 'Laptop',
      tickets: 'Ticket',
      settings: 'Settings',
    };
    pageTitle.textContent = titleMap[name] || 'Dashboard';
  }
  if (name === 'tickets') loadTickets();
  if (name === 'analytics') loadAnalyticsData();
}

function setupDashboardInteractions() {
  setupEmployeeScheduleInteractions();
  document.getElementById('analyticsWebsiteTable')?.addEventListener('click', (event) => {
    const button = event.target.closest('.analytics-employee-link');
    if (button) renderAnalyticsEmployeeDetail(button.dataset.analyticsEmployeeId);
  });
  document.getElementById('closeAnalyticsEmployeeDetail')?.addEventListener('click', () => {
    selectedAnalyticsEmployeeId = null;
    document.getElementById('analyticsEmployeeDetail').classList.add('hidden');
  });
  document.querySelectorAll('.nav-link[data-section]').forEach((button) => {
    button.addEventListener('click', () => setActiveSection(button.dataset.section));
  });
  document.querySelectorAll('[data-blocking-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-blocking-tab]').forEach((item) => {
        const active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-blocking-panel]').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.blockingPanel === tab.dataset.blockingTab);
      });
    });
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      getSupabaseClient()?.auth.signOut();
      localStorage.removeItem('mindlock-remember-admin');
      window.location.href = 'index.html';
    });
  }

  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const state = readState();
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(state.theme, state.accent, true);
      saveState(state);
    });
  }

  const sidebar = document.getElementById('sidebar');
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  if (sidebar && sidebarToggleBtn) {
    document.querySelectorAll('.nav-link').forEach((link) => { link.dataset.label = link.textContent.trim(); });
    sidebarToggleBtn.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      sidebarToggleBtn.setAttribute('aria-expanded', String(!collapsed));
      sidebarToggleBtn.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Minimize navigation');
    });
  }

  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      const backdrop = button.closest('.modal-backdrop');
      if (backdrop?.id === 'updateLogsModal') {
        closeUpdateLogsModal();
      } else {
        backdrop?.classList.add('hidden');
      }
    });
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        if (backdrop.id === 'updateLogsModal') {
          closeUpdateLogsModal();
          return;
        }
        backdrop.classList.add('hidden');
      }
    });
  });
  document.getElementById('laptopTable')?.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-laptop-id]') : null;
    if (!button) return;
    const laptop = directoryLaptops.find((row) => row.id === button.dataset.laptopId);
    if (!laptop) {
      showToast('Laptop record not found. Refresh the dashboard and try again.', true);
      return;
    }
    if (button.classList.contains('view-laptop-details')) {
      const assignment = getActiveLaptopAssignment(laptop.id);
      const registration = getActiveDeviceRegistration(laptop);
      const details = {
        'Laptop ID': laptop.laptop_id,
        Model: laptop.model || '—',
        'Assigned employee': assignment?.employee.name || 'Unassigned',
        'Employee ID': assignment?.employee.user_id || '—',
        'Employee email': assignment?.employee.email || '—',
        'MAC address': laptop.mac_address || registration?.mac_address || '—',
        'Device ID': registration?.registration_id || '—',
        'Connection status': getDeviceConnectionStatus(registration),
        'Registration status': registration ? 'Registered' : 'Unregistered',
        'Last seen': formatDate(registration ? registration.last_heartbeat_at : laptop.last_seen_at),
        'Assignment date': assignment ? formatDate(assignment.assigned_at) : '—',
        'Registration history': deviceRegistrations
          .filter((entry) => entry.laptop_id === laptop.id)
          .map((entry) => `${entry.registration_id}: ${entry.is_active ? 'Registered' : 'Revoked'} (${formatDate(entry.revoked_at || entry.created_at)})`)
          .join('\n') || 'No registrations',
      };
      document.getElementById('userDetailsTitle').textContent = `Laptop ${laptop.laptop_id}`;
      document.getElementById('userDetailsContent').innerHTML = Object.entries(details)
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
      document.getElementById('userDetailsModal').classList.remove('hidden');
      return;
    }
    if (button.classList.contains('assign-laptop')) {
      setActiveSection('assign');
      document.getElementById('assignmentLaptop').value = laptop.id;
      document.getElementById('assignmentForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById('assignmentEmployee').focus({ preventScroll: true });
      return;
    }
    if (button.classList.contains('connection-history-laptop')) {
      document.getElementById('connectionLaptopFilter').value = laptop.id;
      renderConnectionHistory();
      document.getElementById('connectionHistoryModal').classList.remove('hidden');
      return;
    }
    if (button.classList.contains('revoke-device')) {
      if (!window.confirm(`Revoke device registration for ${laptop.laptop_id}? Existing registration history will be retained.`)) return;
      button.disabled = true;
      try {
        await invokeSupabaseFunction('device-registration', { action: 'revoke', laptop_id: laptop.id });
        await loadDashboardData();
        try {
          await writeChangeLog('Revoked device registration', 'Laptops', laptop.laptop_id);
          showToast(`Device registration for ${laptop.laptop_id} was revoked.`);
        } catch (logError) {
          showToast(`Device registration was revoked, but its activity log failed: ${logError.message}`, true);
        }
      } catch (error) {
        showToast(`Device registration could not be revoked: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    }
  });
  document.getElementById('employeeTable')?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.view-employee-details') : null;
    if (!button) return;
    const employee = directoryEmployees.find((row) => row.id === button.dataset.employeeId);
    if (!employee) return;
    const assignment = getEmployeeLaptopAssignment(employee.id);
    const laptop = assignment?.laptop;
    const registration = laptop ? getActiveDeviceRegistration(laptop) : null;
    const details = {
      'Employee ID': employee.user_id,
      'Full name': employee.name,
      Email: employee.email,
      'Account status': employee.active ? employee.account_status : 'Suspended',
      'Assigned laptop': laptop?.laptop_id || 'Unassigned',
      'Laptop model': laptop?.model || '—',
      'MAC address': laptop?.mac_address || registration?.mac_address || '—',
      'Device ID': registration?.registration_id || '—',
      'Connection status': getDeviceConnectionStatus(registration),
      'Last seen': formatDate(laptop?.last_seen_at || registration?.last_heartbeat_at),
      'Assignment date': assignment ? formatDate(assignment.assigned_at) : '—',
    };
    document.getElementById('userDetailsTitle').textContent = `Employee ${employee.user_id}`;
    document.getElementById('userDetailsContent').innerHTML = Object.entries(details)
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value).replaceAll('\n', '<br>')}</dd></div>`).join('');
    document.getElementById('userDetailsModal').classList.remove('hidden');
  });
  ['connectionEmployeeFilter', 'connectionLaptopFilter', 'connectionDateFrom', 'connectionDateTo'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', renderConnectionHistory);
  });
  document.getElementById('versionButton')?.addEventListener('click', () => {
    document.getElementById('updateLogsModal')?.classList.remove('hidden');
  });
  document.getElementById('showLogsBtn')?.addEventListener('click', async () => {
    const modal = document.getElementById('activityLogsModal');
    const table = document.getElementById('activityLogsTable');
    const state = document.getElementById('activityLogsState');
    modal.classList.remove('hidden');
    table.innerHTML = '';
    state.textContent = 'Loading logs…';
    state.classList.remove('hidden', 'error-text');
    try {
      const { data, error } = await getSupabaseClient().from('change_logs')
        .select('id,action,module_name,affected_record_id,created_at')
        .order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      table.innerHTML = data.length ? data.map((log) => `
        <tr><td>${escapeHtml(log.action)}${log.affected_record_id ? ` (${escapeHtml(log.affected_record_id)})` : ''}</td>
        <td>${escapeHtml(log.module_name)}</td><td>${escapeHtml(formatDate(log.created_at))}</td></tr>
      `).join('') : '<tr><td colspan="3">No activity logs.</td></tr>';
      state.classList.add('hidden');
    } catch (error) {
      state.textContent = `Logs could not be loaded: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    }
  });
  document.getElementById('notificationBellBtn')?.addEventListener('click', openNotifications);
  document.getElementById('notificationsModalList')?.addEventListener('click', async (event) => {
    const item = event.target instanceof Element ? event.target.closest('.notification-item') : null;
    if (!item) return;
    try {
      await openNotificationTicket(item.dataset.notificationId);
    } catch (error) {
      const state = document.getElementById('notificationsModalState');
      state.textContent = `Notification could not be marked as read: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    }
  });
  document.getElementById('notificationList')?.addEventListener('click', async (event) => {
    const item = event.target instanceof Element ? event.target.closest('.notification-item') : null;
    if (!item) return;
    try {
      const openedTicket = await openNotificationTicket(item.dataset.notificationId);
      if (!openedTicket) document.getElementById('notificationsModal')?.classList.remove('hidden');
    } catch (error) {
      showToast(`Notification could not be marked as read: ${error.message}`, true);
    }
  });
  document.getElementById('markAllNotificationsReadBtn')?.addEventListener('click', async () => {
    try {
      await markNotificationsRead(notifications.filter((notification) => !notification.is_read).map((notification) => notification.id));
      showToast('All notifications marked as read.');
    } catch (error) {
      const state = document.getElementById('notificationsModalState');
      state.textContent = `Notifications could not be marked as read: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    }
  });

  document.querySelectorAll('.eye-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const password = button.parentElement.querySelector('input');
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${password.getAttribute('autocomplete').replace('-', ' ')} password`);
    });
  });
  document.querySelector('[data-generate-reset-password]')?.addEventListener('click', () => {
    const form = document.getElementById('resetPasswordForm');
    const newPassword = form?.elements.newPassword;
    const confirmPassword = form?.elements.confirmPassword;
    if (!newPassword || !confirmPassword) return;
    const password = generateSecurePassword();
    newPassword.value = password;
    confirmPassword.value = password;
    newPassword.type = 'text';
    confirmPassword.type = 'text';
    const visibilityButton = document.getElementById('toggleResetPasswordsBtn');
    visibilityButton?.setAttribute('aria-pressed', 'true');
    visibilityButton?.setAttribute('aria-label', 'Hide passwords');
    visibilityButton?.setAttribute('title', 'Hide passwords');
    newPassword.focus();
    newPassword.select();
  });
  document.getElementById('toggleResetPasswordsBtn')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const form = document.getElementById('resetPasswordForm');
    const visible = button.getAttribute('aria-pressed') !== 'true';
    form?.querySelectorAll('input[name="newPassword"], input[name="confirmPassword"]').forEach((input) => {
      input.type = visible ? 'text' : 'password';
    });
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} passwords`);
    button.setAttribute('title', `${visible ? 'Hide' : 'Show'} passwords`);
  });
  document.getElementById('changePasswordForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = [...event.currentTarget.querySelectorAll('input[type="password"]')];
    const form = event.currentTarget;
    const emailInput = form.querySelector('input[type="email"]');
    const state = document.getElementById('accountFormState');
    const submit = form.querySelector('button[type="submit"]');
    const [currentPassword, newPassword, confirmPassword] = fields;
    const showState = (message, isError = false) => {
      state.textContent = message;
      state.classList.remove('hidden');
      state.classList.toggle('error-text', isError);
      showToast(message, isError);
    };
    if (newPassword.value && newPassword.value !== confirmPassword.value) {
      confirmPassword.setCustomValidity('Passwords do not match.');
      confirmPassword.reportValidity();
      return;
    }
    if (newPassword.value && newPassword.value.length < 8) {
      newPassword.setCustomValidity('Use at least 8 characters.');
      newPassword.reportValidity();
      return;
    }
    confirmPassword.setCustomValidity('');
    newPassword.setCustomValidity('');
    submit.disabled = true;
    state.classList.add('hidden');
    try {
      const client = getSupabaseClient();
      if (!client || !adminUser) throw new Error('Your admin session has expired. Sign in again and retry.');
      const { error: verifyError } = await client.auth.signInWithPassword({
        email: adminUser.email,
        password: currentPassword.value,
      });
      if (verifyError) throw new Error(`Current password was not accepted: ${verifyError.message}`);
      const updates = {};
      if (emailInput.value.trim() !== adminUser.email) updates.email = emailInput.value.trim();
      if (newPassword.value) updates.password = newPassword.value;
      if (!Object.keys(updates).length) {
        showState('No account changes to save.');
        return;
      }
      const { data, error } = await client.auth.updateUser(updates);
      if (error) throw error;
      adminUser.email = data.user.email;
      emailInput.value = adminUser.email;
      if (data.user.email === updates.email && updates.email) {
        const { error: profileError } = await client.from('profiles').update({ email: data.user.email }).eq('id', adminUser.id);
        if (profileError) throw profileError;
      }
      fields.forEach((field) => { field.value = ''; });
      showState(updates.email && data.user.email !== updates.email
        ? 'Password updated. Confirm the email change using the message sent to the new address.'
        : 'Account changes saved.');
    } catch (error) {
      showState(`Account changes failed: ${error.message}`, true);
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById('changePasswordForm')?.addEventListener('reset', (event) => {
    const form = event.currentTarget;
    window.setTimeout(() => {
      form.querySelector('input[type="email"]').value = adminUser.email || '';
      document.getElementById('accountFormState').classList.add('hidden');
    }, 0);
  });
  document.querySelectorAll('#changePasswordForm input[autocomplete="new-password"]').forEach((input) => {
    input.addEventListener('input', (event) => event.currentTarget.setCustomValidity(''));
  });

  const incognitoToggle = document.getElementById('incognitoToggle');
  const incognitoStatus = document.getElementById('incognitoStatus');
  if (incognitoToggle && incognitoStatus) {
    const state = readState();
    incognitoToggle.checked = Boolean(state.incognitoEnabled);
    incognitoStatus.textContent = state.incognitoEnabled ? 'Enabled' : 'Disabled';
    incognitoToggle.addEventListener('change', () => {
      const nextState = readState();
      nextState.incognitoEnabled = incognitoToggle.checked;
      incognitoStatus.textContent = nextState.incognitoEnabled ? 'Enabled' : 'Disabled';
      saveState(nextState);
    });
  }

  const accentColorInput = document.getElementById('accentColor');
  const accentPreview = document.getElementById('accentPreview');
  if (accentColorInput && accentPreview) {
    const state = readState();
    accentColorInput.value = state.accent || '#2563eb';
    accentPreview.style.background = state.accent || '#2563eb';
    accentColorInput.addEventListener('input', (event) => {
      const nextState = readState();
      nextState.accent = event.target.value;
      accentPreview.style.background = event.target.value;
      applyTheme(nextState.theme, nextState.accent, true);
      saveState(nextState);
    });
  }
  document.getElementById('saveThemeSettingsBtn')?.addEventListener('click', async (event) => {
    const state = document.getElementById('themeSettingsState');
    event.currentTarget.disabled = true;
    try {
      await saveSystemSettings({ dashboard_accent: { value: accentColorInput.value } });
      state.textContent = 'Theme settings saved.';
      state.classList.remove('hidden', 'error-text');
      showToast('Theme settings saved.');
    } catch (error) {
      state.textContent = `Theme settings could not be saved: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
      showToast(state.textContent, true);
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  document.querySelectorAll('.tab-link').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = document.getElementById(tab.dataset.tab);
      if (!target) {
        showToast(`Settings tab "${tab.dataset.tab}" is unavailable.`, true);
        return;
      }
      document.querySelectorAll('.tab-link').forEach((link) => {
        const active = link === tab;
        link.classList.toggle('active', active);
        link.setAttribute('aria-selected', String(active));
      });

      const bindSettingsForm = (id, settings, stateId) => {
        document.getElementById(id)?.addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const state = document.getElementById(stateId);
          const button = form.querySelector('button[type="submit"]');
          button.disabled = true;
          state.classList.add('hidden');
          try {
            await saveSystemSettings(settings(form));
            state.textContent = 'Settings saved.';
            state.classList.remove('hidden', 'error-text');
            showToast('Settings saved.');
          } catch (error) {
            state.textContent = `Settings could not be saved: ${error.message}`;
            state.classList.remove('hidden');
            state.classList.add('error-text');
            showToast(state.textContent, true);
          } finally {
            button.disabled = false;
          }
        });
      };
      bindSettingsForm('generalSettingsForm', (form) => ({
        company_name: { value: form.elements.companyName.value.trim() },
        timezone: { value: PHILIPPINES_TIMEZONE },
        notification_preferences: { value: form.elements.notificationPreference.value },
      }), 'generalSettingsState');
      bindSettingsForm('ticketSettingsForm', (form) => ({
        ticket_default_status: { value: form.elements.defaultTicketStatus.value },
        ticket_id_prefix: { value: form.elements.ticketPrefix.value.trim().toUpperCase() },
        support_instructions: { value: form.elements.supportInstructions.value.trim() },
      }), 'ticketSettingsState');
      bindSettingsForm('retentionSettingsForm', (form) => ({
        message_retention_days: Number(form.elements.messageRetentionDays.value),
        message_auto_cleanup: form.elements.messageAutoCleanup.checked,
        resolved_ticket_cleanup_days: Number(form.elements.ticketCleanupDays.value),
        retention_history_days: Number(form.elements.historyRetentionDays.value),
        analytics_retention_days: Number(form.elements.analyticsRetentionDays.value),
        keep_messages_indefinitely: form.elements.keepMessagesIndefinitely.checked,
        policy_sync_enabled: form.elements.policySyncEnabled.checked,
        disposal_laptop_cleanup_days: Number(form.elements.disposalCleanupDays.value),
        assignment_retention_days: Number(form.elements.assignmentRetentionDays.value),
      }), 'retentionSettingsState');
      document.getElementById('incognitoSettingsForm')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await saveSystemSettings({ global_incognito_policy: event.currentTarget.querySelector('#incognitoToggle').checked });
          document.getElementById('incognitoStatus').textContent = event.currentTarget.querySelector('#incognitoToggle').checked ? 'Enabled' : 'Disabled';
          showToast('Incognito setting saved.');
        } catch (error) {
          showToast(`Incognito setting could not be saved: ${error.message}`, true);
        }
      });
      document.getElementById('cleanupDisposalBtn')?.addEventListener('click', async () => {
        const days = Number(document.querySelector('#retentionSettingsForm [name="disposalCleanupDays"]').value);
        if (!Number.isInteger(days) || days < 1 || !window.confirm(`Delete retired laptops older than ${days} days?`)) return;
        try {
          const cutoff = new Date(Date.now() - days * 86400000).toISOString();
          const { error } = await getSupabaseClient().from('laptops').delete().eq('status', 'Retired').lt('created_at', cutoff);
          if (error) throw error;
          await loadDashboardData();
          showToast('Disposal laptops cleaned up.');
        } catch (error) {
          showToast(`Disposal cleanup failed: ${error.message}`, true);
        }
      });
      document.getElementById('cleanupTerminatedAssignmentsBtn')?.addEventListener('click', async () => {
        try {
          const { error } = await getSupabaseClient().from('laptop_assignments').delete().eq('status', 'Terminated');
          if (error) throw error;
          await loadDashboardData();
          showToast('Terminated assignments deleted.');
        } catch (error) {
          showToast(`Terminated assignment cleanup failed: ${error.message}`, true);
        }
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel === target);
      });
    });
  });

  const scheduleForm = document.getElementById('scheduleForm');
  if (scheduleForm) {
    const resetRuleForm = () => {
      scheduleForm.reset();
      scheduleForm.elements.namedItem('ruleId').value = '';
      scheduleForm.elements.namedItem('employeeId').disabled = false;
      document.getElementById('cancelRuleEditBtn').classList.add('hidden');
      document.getElementById('singleBlockingState').classList.add('hidden');
      document.getElementById('singleBlockingState').classList.remove('error-text');
      renderBlockingSchedulePreview('', 'singleBlockingSchedulePreview');
    };
    document.getElementById('blockingTargetEmployee')?.addEventListener('change', (event) => {
      renderBlockingSchedulePreview(event.currentTarget.value, 'singleBlockingSchedulePreview');
    });
    document.getElementById('cancelRuleEditBtn')?.addEventListener('click', resetRuleForm);
    scheduleForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const state = document.getElementById('singleBlockingState');
      const domain = normalizeBlockingDomain(scheduleForm.elements.domain.value);
      const employeeId = scheduleForm.elements.employeeId.value;
      const employee = directoryEmployees.find((row) => row.id === employeeId && row.active);
      const ruleId = scheduleForm.elements.ruleId.value;
      if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
        scheduleForm.elements.domain.setCustomValidity('Enter a valid website domain without a path.');
        scheduleForm.elements.domain.reportValidity();
        return;
      }
      scheduleForm.elements.domain.setCustomValidity('');
      const schedule = getEmployeeSchedule(employeeId);
      if (!employee || !schedule) {
        state.textContent = employeeId
          ? 'No active employee schedule found. Please assign an employee schedule first.'
          : 'Select an employee with an active schedule.';
        state.classList.remove('hidden');
        state.classList.add('error-text');
        return;
      }
      const submit = scheduleForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      let saved = false;
      state.classList.add('hidden');
      try {
        const { error } = await getSupabaseClient().rpc('save_employee_blocking_policy', {
          p_employee_id: employee.id,
          p_domain: domain,
          p_existing_rule_id: ruleId || null,
        });
        if (error) throw error;
        saved = true;
        resetRuleForm();
        await loadDashboardData();
        state.textContent = `Policy saved for ${domain} (${employee.name}).`;
        state.classList.remove('hidden', 'error-text');
        try {
          await writeChangeLog(ruleId ? 'Updated blocking policy' : 'Created blocking policy', 'Website Blocking', `${domain} · ${employee.name}`);
        } catch (error) {
          console.error('[LOCTIV AUDIT] Website policy was saved but could not be logged:', error);
          state.textContent += ' The policy was saved, but the audit log could not be saved.';
          state.classList.add('error-text');
        }
      } catch (error) {
        state.textContent = saved
          ? `Website policy was saved, but the dashboard could not refresh: ${error.message}`
          : `Website policy could not be saved: ${error.message}`;
        state.classList.remove('hidden');
        state.classList.add('error-text');
      } finally {
        submit.disabled = false;
      }
    });
  }
  document.getElementById('bulkScheduleForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const state = document.getElementById('bulkScheduleState');
    const submit = form.querySelector('button[type="submit"]');
    const employeeId = form.elements.employeeId.value;
    const employee = directoryEmployees.find((row) => row.id === employeeId && row.active);
    const templateId = form.elements.templateId.value;
    const template = defaultBlockingTemplates.find((row) => row.id === templateId && row.is_active);
    state.classList.add('hidden');
    if (!employee || !getEmployeeSchedule(employeeId)) {
      state.textContent = 'No active employee schedule found. Please assign an employee schedule first.';
      state.classList.remove('hidden');
      state.classList.add('error-text');
      return;
    }
    if (!template) {
      state.textContent = 'Select an active default website template.';
      state.classList.remove('hidden');
      state.classList.add('error-text');
      return;
    }
    submit.disabled = true;
    let saved = false;
    try {
      const { data, error } = await getSupabaseClient().rpc('assign_default_blocking_websites', {
        p_employee_id: employee.id,
        p_template_ids: [template.id],
      });
      if (error) throw error;
      saved = true;
      form.elements.templateId.value = '';
      renderDefaultBlockingTemplates('');
      await loadDashboardData();
      state.textContent = `Assigned ${Number(data)} website${Number(data) === 1 ? '' : 's'} from "${template.name}" to ${employee.name}.`;
      state.classList.remove('hidden', 'error-text');
      try {
        await writeChangeLog('Assigned default website template', 'Website Blocking', `${template.name} · ${employee.name} · ${Number(data)} websites`);
      } catch (error) {
        console.error('[LOCTIV AUDIT] Website policies were assigned but could not be logged:', error);
        state.textContent += ' Policies were assigned, but the audit log could not be saved.';
        state.classList.add('error-text');
      }
    } catch (error) {
      state.textContent = saved
        ? `Websites were assigned, but the dashboard could not refresh: ${error.message}`
        : `Bulk website assignment could not be saved: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById('bulkBlockingTargetEmployee')?.addEventListener('change', (event) => {
    renderBlockingSchedulePreview(event.currentTarget.value, 'bulkBlockingSchedulePreview');
  });
  document.getElementById('bulkBlockingTemplate')?.addEventListener('change', (event) => {
    renderDefaultBlockingTemplates(event.currentTarget.value);
  });
  const defaultWebsiteForm = document.getElementById('defaultBlockingWebsiteForm');
  if (defaultWebsiteForm) {
    const resetDefaultWebsiteForm = () => {
      defaultWebsiteForm.reset();
      defaultWebsiteForm.elements.templateId.value = '';
      defaultWebsiteForm.querySelector('button[type="submit"]').textContent = 'Save website template';
      document.getElementById('cancelDefaultBlockingEditBtn').classList.add('hidden');
    };
    document.getElementById('cancelDefaultBlockingEditBtn')?.addEventListener('click', resetDefaultWebsiteForm);
    defaultWebsiteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const state = document.getElementById('defaultBlockingWebsiteState');
      const name = defaultWebsiteForm.elements.templateName.value.trim();
      const domains = [...new Set(defaultWebsiteForm.elements.domains.value
        .split(/[\r\n,;]+/)
        .map(normalizeBlockingDomain)
        .filter(Boolean))];
      const templateId = defaultWebsiteForm.elements.templateId.value;
      const domainPattern = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
      const rawDomains = defaultWebsiteForm.elements.domains.value
        .split(/[\r\n,;]+/)
        .map(normalizeBlockingDomain)
        .filter(Boolean);
      if (!name || name.length > 100) {
        defaultWebsiteForm.elements.templateName.setCustomValidity('Enter a template name with no more than 100 characters.');
        defaultWebsiteForm.elements.templateName.reportValidity();
        return;
      }
      defaultWebsiteForm.elements.templateName.setCustomValidity('');
      if (!domains.length || rawDomains.some((domain) => !domainPattern.test(domain))) {
        defaultWebsiteForm.elements.domains.setCustomValidity('Enter valid domains separated by commas or new lines.');
        defaultWebsiteForm.elements.domains.reportValidity();
        return;
      }
      defaultWebsiteForm.elements.domains.setCustomValidity('');
      if (domains.length !== rawDomains.length) {
        state.textContent = 'Remove duplicate domains from this template.';
        state.classList.remove('hidden');
        state.classList.add('error-text');
        return;
      }
      const submit = defaultWebsiteForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      let saved = false;
      state.classList.add('hidden');
      try {
        const { error } = await getSupabaseClient().rpc('save_default_blocking_template', {
          p_template_id: templateId || null,
          p_name: name,
          p_domains: domains,
        });
        if (error?.code === '23505') throw new Error('A template with that name already exists.');
        if (error) throw error;
        saved = true;
        resetDefaultWebsiteForm();
        await loadDashboardData();
        state.textContent = `"${name}" saved with ${domains.length} website${domains.length === 1 ? '' : 's'}.`;
        state.classList.remove('hidden', 'error-text');
        try {
          await writeChangeLog(templateId ? 'Updated default website template' : 'Created default website template', 'Website Blocking', `${name} · ${domains.join(', ')}`);
        } catch (error) {
          console.error('[LOCTIV AUDIT] Default website template was saved but could not be logged:', error);
          state.textContent += ' The template was saved, but the audit log could not be saved.';
          state.classList.add('error-text');
        }
      } catch (error) {
        state.textContent = saved
          ? `Website template was saved, but the dashboard could not refresh: ${error.message}`
          : `Website template could not be saved: ${error.message}`;
        state.classList.remove('hidden');
        state.classList.add('error-text');
      } finally {
        submit.disabled = false;
      }
    });
  }
  document.addEventListener('click', (event) => {
    const editTemplateButton = event.target instanceof Element ? event.target.closest('.edit-default-blocking') : null;
    if (editTemplateButton) {
      const template = defaultBlockingTemplates.find((row) => row.id === editTemplateButton.dataset.templateId);
      if (!template) return;
      const form = document.getElementById('defaultBlockingWebsiteForm');
      form.elements.templateId.value = template.id;
      form.elements.templateName.value = template.name;
      form.elements.domains.value = template.websites.map((website) => website.domain).join('\n');
      form.querySelector('button[type="submit"]').textContent = 'Update website template';
      document.getElementById('cancelDefaultBlockingEditBtn').classList.remove('hidden');
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      form.elements.templateName.focus({ preventScroll: true });
      return;
    }
    const toggleTemplateButton = event.target instanceof Element ? event.target.closest('.toggle-default-blocking') : null;
    if (toggleTemplateButton) {
      const template = defaultBlockingTemplates.find((row) => row.id === toggleTemplateButton.dataset.templateId);
      if (!template) return;
      (async () => {
        let updated = false;
        try {
          const { error } = await getSupabaseClient().from('default_blocking_templates')
            .update({ is_active: !template.is_active, updated_at: new Date().toISOString() })
            .eq('id', template.id);
          if (error) throw error;
          updated = true;
          await loadDashboardData();
        } catch (error) {
          showToast(updated
            ? `Default website status changed, but the dashboard could not refresh: ${error.message}`
            : `Default website status could not be updated: ${error.message}`, true);
          return;
        }
        try {
          await writeChangeLog(`${template.is_active ? 'Deactivated' : 'Activated'} default website template`, 'Website Blocking', template.name);
        } catch (error) {
          console.error('[LOCTIV AUDIT] Default website status changed but could not be logged:', error);
          showToast('Default website status changed, but the audit log could not be saved.', true);
          return;
        }
        showToast(`Website template ${template.is_active ? 'deactivated' : 'activated'}.`);
      })();
      return;
    }
    const deleteTemplateButton = event.target instanceof Element ? event.target.closest('.delete-default-blocking') : null;
    if (deleteTemplateButton) {
      const template = defaultBlockingTemplates.find((row) => row.id === deleteTemplateButton.dataset.templateId);
      if (!template || !window.confirm(`Delete the "${template.name}" template and its saved domains? Existing employee policies will remain unchanged.`)) return;
      (async () => {
        let deleted = false;
        try {
          const { error } = await getSupabaseClient().from('default_blocking_templates').delete().eq('id', template.id);
          if (error) throw error;
          deleted = true;
          await loadDashboardData();
        } catch (error) {
          showToast(deleted
            ? `Default website was deleted, but the dashboard could not refresh: ${error.message}`
            : `Default website could not be deleted: ${error.message}`, true);
          return;
        }
        try {
          await writeChangeLog('Deleted default website template', 'Website Blocking', template.name);
        } catch (error) {
          console.error('[LOCTIV AUDIT] Default website was deleted but could not be logged:', error);
          showToast('Default website deleted, but the audit log could not be saved.', true);
          return;
        }
        showToast('Default website deleted.');
      })();
      return;
    }
    const deleteButton = event.target instanceof Element ? event.target.closest('.blocking-delete-btn') : null;
    if (deleteButton) {
      const rule = blockingRules.find((row) => row.id === deleteButton.dataset.ruleId);
      if (!rule || !window.confirm(`Delete the ${rule.domain} blocking policy?`)) return;
      (async () => {
        try {
          const client = getSupabaseClient();
          const assignmentDelete = await client.from('blocking_schedule_assignments').delete().eq('schedule_id', rule.schedule_id);
          if (assignmentDelete.error && !/relation|column/i.test(assignmentDelete.error.message)) throw assignmentDelete.error;
          if (rule.schedule_id) {
            const scheduleDelete = await client.from('blocking_schedules').delete().eq('id', rule.schedule_id);
            if (scheduleDelete.error) throw scheduleDelete.error;
          }
          const ruleDelete = await client.from('website_blocking_rules').delete().eq('id', rule.id);
          if (ruleDelete.error) throw ruleDelete.error;
          await writeChangeLog('Deleted blocking schedule', 'Website blocking', rule.domain);
          await loadDashboardData();
          showToast(`${rule.domain} blocking policy deleted.`);
        } catch (error) {
          showToast(`Blocking policy deletion failed: ${error.message}`, true);
        }
      })();
      return;
    }
    const button = event.target instanceof Element ? event.target.closest('.edit-blocking-rule') : null;
    if (!button) return;
    const rule = blockingRules.find((row) => row.id === button.dataset.ruleId);
    if (!rule) {
      showToast('This blocking schedule could not be found. Refresh the dashboard and try again.', true);
      return;
    }
    const targetEmployee = directoryEmployees.find((employee) => employee.profile_id === rule.target_profile_id);
    if (!targetEmployee) {
      showToast('This is a legacy all-employee policy. Create an individual employee policy instead of editing the shared policy.', true);
      return;
    }
    const form = document.getElementById('scheduleForm');
    setActiveSection('blocking');
    document.querySelector('[data-blocking-tab="single"]')?.click();
    form.elements.namedItem('ruleId').value = rule.id;
    form.elements.namedItem('domain').value = rule.domain;
    form.elements.namedItem('employeeId').value = targetEmployee.id;
    form.elements.namedItem('employeeId').disabled = true;
    renderBlockingSchedulePreview(targetEmployee.id, 'singleBlockingSchedulePreview');
    document.getElementById('cancelRuleEditBtn').classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements.namedItem('domain').focus({ preventScroll: true });
    showToast(`Editing ${rule.domain}.`);
  });

  const assignmentForm = document.getElementById('assignmentForm');
  if (assignmentForm) {
    assignmentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const employeeId = document.getElementById('assignmentEmployee').value;
      const laptopId = document.getElementById('assignmentLaptop').value;
      const retentionDays = Number(settingValue('assignment_retention_days', 30));
      const employee = directoryEmployees.find((row) => row.id === employeeId);
      const laptop = directoryLaptops.find((row) => row.id === laptopId);
      if (!employee || !laptop || laptop.status === 'Retired' || !employee.active) {
        setDashboardState('Choose an active employee and a laptop that is not retired.', true);
        return;
      }
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
        setDashboardState('Assignment retention must be between 1 and 3650 days.', true);
        return;
      }
      const submitButton = assignmentForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      try {
        try {
          const { error } = await getSupabaseClient().rpc('assign_laptop_to_employee', {
            p_employee_id: employee.id,
            p_laptop_id: laptop.id,
            p_assigned_by: adminUser.id,
            p_retention_days: retentionDays,
          });
          if (error) throw error;
        } catch (error) {
          const needsMigration = /assign_laptop_to_employee/i.test(error.message);
          setDashboardState(needsMigration
            ? `Laptop assignment failed: run migration 007_device_registration_monitoring.sql first. ${error.message}`
            : `Laptop assignment failed: ${error.message}`, true);
          return;
        }
        let registrationError = null;
        try {
          await invokeSupabaseFunction('device-registration', {
            action: 'register',
            laptop_id: laptop.id,
            mac_address: laptop.mac_address || null,
          });
        } catch (error) {
          registrationError = error;
        }
        let activityError = null;
        try {
          await writeChangeLog('Assigned or reassigned laptop', 'Assignments', laptop.laptop_id);
        } catch (error) {
          activityError = error;
        }
        await loadDashboardData();
        const statusMessage = registrationError
          ? `Laptop ${laptop.laptop_id} was assigned to ${employee.name}, but device registration failed and remains Unregistered: ${registrationError.message}`
          : `Laptop ${laptop.laptop_id} assigned to ${employee.name} and registered automatically. Previous assignments remain in history.`;
        setDashboardState(activityError ? `${statusMessage} Activity log failed: ${activityError.message}` : statusMessage, Boolean(registrationError || activityError));
      } finally {
        submitButton.disabled = false;
      }
    });
  }
  document.getElementById('reassignHistoryBtn')?.addEventListener('click', () => {
    const history = document.getElementById('assignmentHistoryCard');
    history?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history?.classList.add('highlight-card');
    window.setTimeout(() => history?.classList.remove('highlight-card'), 1200);
  });

  document.getElementById('assignmentTable')?.addEventListener('click', (event) => {
    const button = event.target.closest('.user-details-btn');
    if (!button) return;
    const profile = directoryEmployees.find((row) => row.user_id === button.dataset.userId);
    const assignment = directoryAssignments.find((row) => row.employee.id === profile?.id && row.status === 'Active');
    const device = assignment?.laptop;
    if (!profile) return;
    document.getElementById('userDetailsTitle').textContent = `Employee ${profile.user_id}`;
    const details = {
      'User ID': profile.user_id,
      'Full name': profile.name,
      Email: profile.email,
      Department: profile.department,
      Position: profile.position,
      Role: profile.role,
      'Account status': profile.active ? 'Active' : 'Suspended',
      'Assigned laptop': device?.laptop_id || 'Unassigned',
      Model: device?.model || '—',
      'Laptop status': device?.status || '—',
      'MAC address': device?.mac_address || '—',
      'Last sync': device?.last_sync_at ? formatDate(device.last_sync_at) : '—',
    };
    document.getElementById('userDetailsContent').innerHTML = Object.entries(details)
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    document.getElementById('userDetailsModal').classList.remove('hidden');
  });

  document.getElementById('employeeSearch')?.addEventListener('input', renderEmployeeTable);
  document.getElementById('employeeDepartmentFilter')?.addEventListener('change', renderEmployeeTable);
  document.getElementById('employeeStatusFilter')?.addEventListener('change', renderEmployeeTable);
  document.getElementById('employeeTable')?.addEventListener('click', async (event) => {
    const actionsButton = event.target.closest('.employee-actions-btn');
    if (actionsButton) {
      const menu = actionsButton.nextElementSibling;
      document.querySelectorAll('.employee-action-menu').forEach((item) => {
        if (item !== menu) item.classList.add('hidden');
      });
      menu?.classList.toggle('hidden');
      actionsButton.setAttribute('aria-expanded', String(!menu?.classList.contains('hidden')));
      return;
    }
    const deleteButton = event.target.closest('.employee-delete-btn');
    if (deleteButton) {
      const employee = directoryEmployees.find((row) => row.profile_id === deleteButton.dataset.employeeId);
      if (!employee || !window.confirm(`Delete ${employee.name} and their account permanently?`)) return;
      deleteButton.disabled = true;
      try {
        await invokeSupabaseFunction('employee-account', {
          action: 'delete_employee',
          user_id: employee.profile_id,
        });
        await writeChangeLog('Deleted employee account', 'Employees', employee.user_id);
        await loadDashboardData();
        showToast(`Employee ${employee.name} was deleted.`);
      } catch (error) {
        showToast(`Employee deletion failed: ${error.message}`, true);
      } finally {
        deleteButton.disabled = false;
      }
      return;
    }
    const button = event.target.closest('.employee-password-btn');
    if (!button) return;
    const employee = directoryEmployees.find((row) => row.profile_id === button.dataset.employeeId);
    if (!employee) return;
    const modal = document.getElementById('resetPasswordModal');
    const form = document.getElementById('resetPasswordForm');
    const state = document.getElementById('resetPasswordState');
    if (!modal || !form || !state) return;
    form.dataset.employeeId = employee.profile_id;
    form.dataset.employeeRecordId = employee.user_id;
    document.getElementById('resetPasswordEmployee').textContent = `Set a new password for ${employee.name}.`;
    form.reset();
    form.querySelectorAll('input[name="newPassword"], input[name="confirmPassword"]').forEach((input) => {
      input.type = 'password';
    });
    state.textContent = '';
    state.classList.add('hidden');
    document.getElementById('toggleResetPasswordsBtn')?.setAttribute('aria-pressed', 'false');
    document.getElementById('toggleResetPasswordsBtn')?.setAttribute('aria-label', 'Show passwords');
    document.getElementById('toggleResetPasswordsBtn')?.setAttribute('title', 'Show passwords');
    modal.classList.remove('hidden');
    form.elements.newPassword.focus();
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('.employee-actions')) return;
    document.querySelectorAll('.employee-action-menu').forEach((menu) => menu.classList.add('hidden'));
    document.querySelectorAll('.employee-actions-btn').forEach((button) => button.setAttribute('aria-expanded', 'false'));
  });
  document.getElementById('resetPasswordForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const state = document.getElementById('resetPasswordState');
    const submit = form.querySelector('button[type="submit"]');
    const newPassword = form.elements.newPassword;
    const confirmPassword = form.elements.confirmPassword;
    state.classList.add('hidden');
    newPassword.setCustomValidity('');
    confirmPassword.setCustomValidity('');
    if (newPassword.value !== confirmPassword.value) {
      confirmPassword.setCustomValidity('Passwords do not match.');
      confirmPassword.reportValidity();
      return;
    }
    submit.disabled = true;
    try {
      await invokeSupabaseFunction('employee-account', {
        action: 'reset_password',
        user_id: form.dataset.employeeId,
        password: newPassword.value,
      });
      await writeChangeLog('Reset employee password', 'Employees', form.dataset.employeeRecordId);
      document.getElementById('resetPasswordModal').classList.add('hidden');
      showToast('Employee password reset successfully.');
    } catch (error) {
      state.textContent = `Password reset failed: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
      showToast(state.textContent, true);
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById('laptopSearch')?.addEventListener('input', renderLaptopTable);
  document.getElementById('laptopStatusFilter')?.addEventListener('change', renderLaptopTable);
  ['ticketSearch', 'ticketStatusFilter', 'ticketCategoryFilter'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => { ticketPage = 0; loadTickets(); });
    document.getElementById(id)?.addEventListener('change', () => { ticketPage = 0; loadTickets(); });
  });
  document.getElementById('ticketTable')?.addEventListener('click', (event) => {
    const ticketButton = event.target.closest('.ticket-id-link');
    if (ticketButton) openTicketDetail(ticketButton.dataset.ticketId);
  });
  document.getElementById('ticketPagePrev')?.addEventListener('click', () => {
    if (ticketPage > 0) {
      ticketPage -= 1;
      loadTickets();
    }
  });
  document.getElementById('ticketPageNext')?.addEventListener('click', () => {
    if ((ticketPage + 1) * TICKET_PAGE_SIZE < ticketCount) {
      ticketPage += 1;
      loadTickets();
    }
  });
  document.getElementById('backToTicketsBtn')?.addEventListener('click', closeTicketDetail);
  document.getElementById('ticketReplyForm')?.addEventListener('submit', sendTicketReply);
  document.getElementById('saveTicketStatusBtn')?.addEventListener('click', async () => {
    if (!selectedTicket || !supabaseClient) return;
    const status = document.getElementById('ticketDetailStatus').value;
    const button = document.getElementById('saveTicketStatusBtn');
    button.disabled = true;
    try {
      const { error } = await supabaseClient.from('tickets').update({ status }).eq('id', selectedTicket.id);
      if (error) throw error;
      selectedTicket.status = status;
      document.getElementById('ticketDetailState').textContent = 'Ticket status updated.';
      showToast('Ticket status updated.');
      renderTicketInfo(selectedTicket);
      await loadTickets();
    } catch (error) {
      document.getElementById('ticketDetailState').textContent = `Status update failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('internalNoteForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedTicket || !supabaseClient || !adminUser) return;
    const input = document.getElementById('internalNoteInput');
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const { error } = await supabaseClient.from('ticket_internal_notes').insert({
        ticket_id: selectedTicket.id,
        author_id: adminUser.id,
        note: input.value.trim(),
      });
      if (error) throw error;
      input.value = '';
      await loadInternalNotes();
    } catch (error) {
      document.getElementById('ticketDetailState').textContent = `Private note was not saved: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelectorAll('[data-analytics-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      analyticsMetric = tab.dataset.analyticsTab;
      document.querySelectorAll('[data-analytics-tab]').forEach((item) => {
        item.classList.toggle('active', item === tab);
        item.setAttribute('aria-selected', String(item === tab));
      });
      renderAnalyticsData(analyticsRecords);
    });
  });
  document.getElementById('analyticsEmployeeFilter')?.addEventListener('change', () => {
    renderAnalyticsData(analyticsRecords);
    renderBarChart();
  });
  document.getElementById('syncSystemBtn')?.addEventListener('click', syncSystem);

  const roleForm = document.getElementById('roleAssignmentForm');
  const roleFormToggle = document.getElementById('addRoleAssignmentBtn');
  if (adminUser.role !== 'Administrator') roleFormToggle?.classList.add('hidden');
  roleFormToggle?.addEventListener('click', () => roleForm.classList.toggle('hidden'));
  document.getElementById('cancelRoleAssignmentBtn')?.addEventListener('click', () => roleForm.classList.add('hidden'));
  roleForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = document.getElementById('roleUserId').value.trim();
    const role = document.getElementById('roleSelection').value;
    if (adminUser.role !== 'Administrator') {
      setDashboardState('Only administrators can change roles.', true);
      return;
    }
    const employee = directoryEmployees.find((row) => row.user_id === userId);
    if (!employee) {
      setDashboardState('No matching user ID found in the current directory.', true);
      return;
    }
    try {
      const client = getSupabaseClient();
      const { error: revokeError } = await client.from('user_roles')
        .update({ revoked_at: new Date().toISOString() })
        .eq('profile_id', employee.profile_id).is('revoked_at', null);
      if (revokeError) throw revokeError;
      const { error } = await client.from('user_roles').upsert({
        profile_id: employee.profile_id,
        role_name: role,
        assigned_by: adminUser.id,
        revoked_at: null,
      }, { onConflict: 'profile_id,role_name' });
      if (error) throw error;
      await writeChangeLog(`Assigned ${role} role`, 'Role management', userId);
      roleForm.reset();
      roleForm.classList.add('hidden');
      await loadDashboardData();
      showToast(`${role} role assigned.`);
    } catch (error) {
      setDashboardState(`Role assignment failed: ${error.message}`, true);
    }
  });

  const createRecordModal = document.getElementById('createRecordModal');
  const createRecordForm = document.getElementById('createRecordForm');
  const openCreateForm = (kind) => {
    const employee = kind === 'employee';
    const title = employee ? 'Add employee' : 'Add laptop';
    document.getElementById('createRecordTitle').textContent = title;
    createRecordForm.dataset.kind = kind;
    const employeeRoleOptions = adminUser.role === 'Administrator'
      ? '<option>Employee</option><option>IT Staff</option><option>Administrator</option>'
      : '<option>Employee</option>';
    createRecordForm.innerHTML = employee
      ? `<p class="span-2">Employee ID is generated automatically. The temporary password is sent securely to Supabase Auth and is not stored in the employee table.</p><label><span>Full name</span><input name="name" required></label><label><span>Company email</span><input name="email" type="email" required></label><label><span>Temporary password</span><div class="input-action-row"><input name="password" type="text" minlength="8" autocomplete="new-password" required><button class="secondary-btn" type="button" data-generate-password>Generate password</button></div></label><label><span>Department</span><input name="department" required></label><label><span>Job title</span><input name="position" required></label><label><span>Role</span><select name="role">${employeeRoleOptions}</select></label><label><span>Account status</span><select name="active"><option value="true">Active</option><option value="false">Suspended</option></select></label><div class="span-2 actions-row"><button class="primary-btn" type="submit">Add employee account</button></div>`
      : '<p class="span-2">Laptop ID is assigned automatically. Enter the MAC address from the authorized IT registration process; a browser cannot read physical MAC addresses.</p><label><span>Device name</span><input name="device_name" placeholder="Optional hostname"></label><label><span>Manufacturer</span><input name="manufacturer" placeholder="Dell, HP, Lenovo..."></label><label><span>Model</span><input name="model" required></label><label><span>Serial number (optional)</span><input name="serial_number" placeholder="Optional"></label><label><span>MAC address (optional)</span><input name="mac_address" placeholder="00:1A:2B:3C:4D:5E" pattern="^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$"></label><label><span>Status</span><select name="status"><option>Available</option><option>Maintenance</option><option>Retired</option></select></label><div class="span-2 actions-row"><button class="primary-btn" type="submit">Add laptop</button></div>';
    if (employee) {
      const passwordInput = createRecordForm.querySelector('input[name="password"]');
      createRecordForm.querySelector('[data-generate-password]')?.addEventListener('click', () => {
        passwordInput.value = generateSecurePassword();
        passwordInput.focus();
        passwordInput.select();
      });
    }
    createRecordModal.classList.remove('hidden');
  };
  document.getElementById('addEmployeeBtn')?.addEventListener('click', () => openCreateForm('employee'));
  document.getElementById('addLaptopBtn')?.addEventListener('click', () => openCreateForm('laptop'));
  createRecordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = Object.fromEntries(new FormData(createRecordForm));
    const submit = createRecordForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const client = getSupabaseClient();
      if (createRecordForm.dataset.kind === 'employee') {
        const result = await invokeSupabaseFunction('employee-account', {
          full_name: String(formData.name).trim(),
          email: String(formData.email).trim(),
          password: String(formData.password),
          department: String(formData.department || '').trim(),
          position: String(formData.position || '').trim(),
          role: formData.role,
          active: formData.active === 'true',
        });
        await writeChangeLog('Created employee account', 'Employees', result.user_id);
      } else {
        const { data: laptop, error } = await client.from('laptops').insert({
          device_name: String(formData.device_name || '').trim() || null,
          manufacturer: String(formData.manufacturer || '').trim() || null,
          model: String(formData.model).trim(),
          serial_number: String(formData.serial_number || '').trim() || null,
          mac_address: String(formData.mac_address || '').trim().toUpperCase() || null,
          operating_system: null,
          browser: null,
          extension_version: null,
          status: formData.status,
        }).select('laptop_id').single();
        if (error) throw error;
        await writeChangeLog('Created laptop', 'Laptops', laptop.laptop_id);
      }
      createRecordModal.classList.add('hidden');
      createRecordForm.reset();
      await loadDashboardData();
      showToast(createRecordForm.dataset.kind === 'employee' ? 'Employee added.' : 'Laptop added.');
    } catch (error) {
      const needsMigration = /mac_address/i.test(error.message);
      setDashboardState(needsMigration
        ? 'Add laptop failed: run migration 005_admin_dashboard_device_details.sql to add MAC address storage.'
        : `Record could not be created: ${error.message}`, true);
    } finally {
      submit.disabled = false;
    }
  });

}

function closeUpdateLogsModal() {
  if (document.getElementById('dontShowUpdateLogsAgain')?.checked) {
    sessionStorage.setItem(UPDATE_LOGS_DISMISSAL_KEY, 'true');
  }
  document.getElementById('updateLogsModal')?.classList.add('hidden');
}

async function initDashboard() {
  const authorized = await ensureAdminSession();
  if (!authorized) return;

  updatePhilippinesClock();
  window.setInterval(updatePhilippinesClock, 1000);

  const state = readState();
  applyTheme(state.theme, state.accent, true);

  renderBarChart();
  renderTicketLegend();
  renderAnalytics();
  setupDashboardInteractions();
  if (!sessionStorage.getItem(UPDATE_LOGS_DISMISSAL_KEY)) {
    document.getElementById('updateLogsModal')?.classList.remove('hidden');
  }
  setupTicketListRealtime();
  setupMonitoringRealtime();
  setupAnalyticsRealtime();
  await Promise.all([loadDashboardData(), loadTickets(), loadAnalyticsData()]);
  if (monitoringRefreshTimer) window.clearInterval(monitoringRefreshTimer);
  monitoringRefreshTimer = window.setInterval(() => {
    refreshDeviceMonitoring().catch((error) => showToast(`Device monitoring refresh failed: ${error.message}`, true));
  }, 15000);
  if (analyticsRefreshTimer) window.clearInterval(analyticsRefreshTimer);
  analyticsRefreshTimer = window.setInterval(scheduleAnalyticsRefresh, 30000);
  window.setInterval(() => {
    syncSystem().catch((error) => showToast(`Automatic sync failed: ${error.message}`, true));
  }, 60000);
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    setupLoginPage();
  } else {
    initDashboard();
  }
});
