const STORAGE_KEYS = { settings: 'mindlock-admin-settings' };

const TICKET_PAGE_SIZE = 10;
const TICKET_STATUSES = ['Open', 'Assigned', 'In Progress', 'Waiting for Employee', 'Waiting for IT', 'Resolved', 'Closed'];
let supabaseClient = null;
let adminUser = null;
let ticketPage = 0;
let ticketCount = 0;
let ticketsOnPage = [];
let selectedTicket = null;
let ticketRealtimeChannel = null;
let ticketListRealtimeChannel = null;
let ticketPollTimer = null;
let analyticsMetric = 'time';
let analyticsRecords = [];
let directoryEmployees = [];
let directoryLaptops = [];
let directoryAssignments = [];
let blockingRules = [];
let changeRequests = [];
let activityLogs = [];
let notifications = [];
let selectedChangeRequest = null;

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

function applyTheme(themeName, accentColor) {
  const root = document.documentElement;
  root.style.setProperty('--accent', accentColor || '#2563eb');
  document.body.classList.toggle('dark-mode', themeName === 'dark');
  document.body.classList.toggle('light-mode', themeName !== 'dark');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    const label = themeName === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }
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
    ['Pending requests', changeRequests.filter((row) => row.status === 'Pending').length],
  ];
  statsGrid.innerHTML = stats.map(([label, value]) => `
    <article class="stat-card"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong></article>
  `).join('');
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
  if (!container) return;

  container.innerHTML = notifications.length
    ? notifications.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.body)}</small></li>`).join('')
    : '<li>No notifications.</li>';
}

function renderBarChart() {
  const usageChart = document.getElementById('usageChart');
  if (!usageChart) return;

  const data = analyticsRecords.length
    ? Array.from({ length: 7 }, (_, index) => {
      const day = new Date();
      day.setDate(day.getDate() - (6 - index));
      const dateKey = day.toISOString().slice(0, 10);
      return analyticsRecords.filter((row) => String(row.recorded_at).slice(0, 10) === dateKey)
        .reduce((sum, row) => sum + Number(row.total_seconds || 0) / 60, 0);
    })
    : Array(7).fill(0);
  const max = Math.max(...data, 1);
  usageChart.innerHTML = data
    .map(
      (value, index) => `
        <div class="bar-group">
          <span style="height:${Math.max(value ? (value / max) * 100 : 0, 2)}%" title="${value} minutes"></span>
          <small>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.now() - (6 - index) * 86400000).getDay()]}</small>
        </div>
      `,
    )
    .join('');
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
  container.innerHTML = `<div class="legend-item"><span>Tickets</span><strong>${ticketCount}</strong></div>`;
}

function renderBlockingTable() {
  const table = document.getElementById('blockingTable');
  if (!table) return;
  table.innerHTML = blockingRules.length ? blockingRules.map((row) => {
    const days = (row.days_of_week || []).join(', ') || 'Every day';
    const now = new Date();
    const day = now.toLocaleDateString('en-US', { weekday: 'short' });
    const time = now.toTimeString().slice(0, 5);
    const start = row.start_time.slice(0, 5);
    const end = row.end_time.slice(0, 5);
    const inTimeRange = start <= end ? time >= start && time <= end : time >= start || time <= end;
    const status = !row.is_active ? 'Paused' : (row.days_of_week || []).includes(day) && inTimeRange ? 'Active' : 'Scheduled';
    return `
        <tr>
          <td>${escapeHtml(row.domain)}</td>
          <td>Global</td>
          <td>${escapeHtml(row.start_time.slice(0, 5))} - ${escapeHtml(row.end_time.slice(0, 5))}<small>${escapeHtml(days)}</small></td>
          <td><span class="status-pill ${status === 'Active' ? 'success' : status === 'Scheduled' ? 'warning' : 'neutral'}">${status}</span></td>
          <td><button class="text-btn edit-blocking-rule" type="button" data-rule-id="${escapeHtml(row.id)}">Edit</button></td>
        </tr>
      `;
  }).join('') : '<tr><td colspan="5">No website blocking policies configured.</td></tr>';
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
          <td><span class="status-pill ${row.status === 'Active' ? 'success' : 'neutral'}">${escapeHtml(row.status)}</span></td>
        </tr>
      `).join('') : '<tr><td colspan="5">No laptop assignments.</td></tr>';
}

function renderAssignmentOptions() {
  const employeeSelect = document.getElementById('assignmentEmployee');
  const laptopSelect = document.getElementById('assignmentLaptop');
  if (!employeeSelect || !laptopSelect) return;
  const assignedEmployeeIds = new Set(directoryAssignments.filter((row) => row.status === 'Active').map((row) => row.employee.id));
  const employees = directoryEmployees.filter((row) => row.active && !assignedEmployeeIds.has(row.id));
  const laptops = directoryLaptops.filter((row) => row.status === 'Available');
  employeeSelect.innerHTML = `<option value="">Select an employee</option>${employees.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join('')}`;
  laptopSelect.innerHTML = `<option value="">Select an available laptop</option>${laptops.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.laptop_id)}</option>`).join('')}`;
}

function renderRequestTable() {
  const table = document.getElementById('requestTable');
  if (!table) return;
  table.innerHTML = changeRequests.length ? changeRequests.map((row) => `
        <tr>
          <td>${escapeHtml(row.employeeName || 'Unknown employee')}</td>
          <td>${escapeHtml(row.request_type)}</td>
          <td>${escapeHtml(row.reason)}</td>
          <td><span class="status-pill ${row.status === 'Approved' ? 'success' : row.status === 'Pending' ? 'warning' : 'neutral'}">${escapeHtml(row.status)}</span></td>
          <td><button class="text-btn review-change-request" type="button" data-request-id="${escapeHtml(row.id)}">Review</button></td>
        </tr>
      `).join('') : '<tr><td colspan="5">No change requests.</td></tr>';
}

function renderEmployeeTable() {
  const table = document.getElementById('employeeTable');
  if (!table) return;
  const query = (document.getElementById('employeeSearch')?.value || '').trim().toLowerCase();
  const status = document.getElementById('employeeStatusFilter')?.value || '';
  table.innerHTML = directoryEmployees
    .filter((row) => (!status || (row.active ? 'Active' : 'Suspended') === status) && (!query || `${row.user_id} ${row.name} ${row.department} ${row.email}`.toLowerCase().includes(query)))
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.user_id)}</td>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.department)}</td>
          <td>${escapeHtml(row.role || 'Employee')}</td>
          <td>${escapeHtml(directoryAssignments.find((assignment) => assignment.employee.id === row.id && assignment.status === 'Active')?.laptop.laptop_id || 'Unassigned')}</td>
          <td><span class="status-pill ${row.active ? 'success' : 'neutral'}">${row.active ? 'Active' : 'Suspended'}</span></td>
        </tr>
      `,
    )
    .join('');
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
    .filter((row) => (!status || row.status === status) && (!query || `${row.laptop_id} ${row.model}`.toLowerCase().includes(query)))
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.laptop_id)}</td>
          <td>${escapeHtml(row.model)}</td>
          <td><span class="status-pill ${row.status === 'Assigned' ? 'success' : row.status === 'Maintenance' ? 'warning' : 'neutral'}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(directoryAssignments.find((assignment) => assignment.laptop.id === row.id && assignment.status === 'Active')?.employee.name || 'Unassigned')}</td>
          <td>${escapeHtml(row.last_sync_at ? formatDate(row.last_sync_at) : 'Never')}</td>
        </tr>
      `,
    )
    .join('') || '<tr><td colspan="5">No laptops registered.</td></tr>';
}

function setDashboardState(message, isError = false) {
  const state = document.getElementById('dashboardDataState');
  if (!state) return;
  state.textContent = message;
  state.classList.toggle('error-text', isError);
  state.classList.toggle('hidden', !message);
}

async function loadDashboardData() {
  const client = getSupabaseClient();
  if (!client || !adminUser) return;
  setDashboardState('Loading dashboard data…');
  try {
    const results = await Promise.all([
      client.from('employees').select('id,profile_id,user_id,department,position,active').order('created_at', { ascending: false }),
      client.from('profiles').select('id,full_name,email,department,position'),
      client.from('user_roles').select('profile_id,role_name').is('revoked_at', null),
      client.from('laptops').select('id,laptop_id,model,status,last_sync_at').order('created_at', { ascending: false }),
      client.from('laptop_assignments').select('id,employee_id,laptop_id,status,assigned_at').order('assigned_at', { ascending: false }),
      client.from('website_blocking_rules').select('id,domain,start_time,end_time,days_of_week,is_active').order('created_at', { ascending: false }),
      client.from('laptop_change_requests').select('id,profile_id,request_type,reason,status,created_at').order('created_at', { ascending: false }).limit(100),
      client.from('change_logs').select('id,action,module_name,created_at').order('created_at', { ascending: false }).limit(8),
      client.from('notifications').select('id,title,body,is_read,created_at').eq('user_id', adminUser.id).order('created_at', { ascending: false }).limit(10),
    ]);
    const failed = results.find((result) => result.error);
    if (failed?.error) throw failed.error;
    const [employeeResult, profileResult, roleResult, laptopResult, assignmentResult, ruleResult, requestResult, logResult, notificationResult] = results;
    const profiles = new Map((profileResult.data || []).map((profile) => [profile.id, profile]));
    const roles = new Map((roleResult.data || []).map((role) => [role.profile_id, role.role_name]));
    directoryEmployees = (employeeResult.data || []).map((employee) => {
      const profile = profiles.get(employee.profile_id) || {};
      return {
        ...employee,
        userId: employee.user_id,
        name: profile.full_name || 'Unknown employee',
        email: profile.email || '',
        department: employee.department || profile.department || '',
        position: employee.position || profile.position || '',
        role: roles.get(employee.profile_id) || 'Employee',
      };
    });
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
    blockingRules = ruleResult.data || [];
    const requestProfiles = new Map((profileResult.data || []).map((profile) => [profile.id, profile.full_name]));
    changeRequests = (requestResult.data || []).map((request) => ({
      ...request,
      employeeName: requestProfiles.get(request.profile_id) || 'Unknown employee',
    }));
    activityLogs = logResult.data || [];
    notifications = notificationResult.data || [];
    renderMetricCards();
    renderActivityList();
    renderNotifications();
    renderBlockingTable();
    renderAssignmentTable();
    renderAssignmentOptions();
    renderRequestTable();
    renderEmployeeTable();
    renderUserRoleAssignments();
    renderLaptopTable();
    updateNotificationBell();
    setDashboardState('');
  } catch (error) {
    setDashboardState(`Dashboard data could not be loaded: ${error.message}`, true);
  }
}

function updateNotificationBell() {
  const button = document.getElementById('notificationBellBtn');
  const unread = notifications.filter((notification) => !notification.is_read).length;
  if (!button) return;
  button.setAttribute('aria-label', unread ? `${unread} unread notifications` : 'Notifications');
  button.dataset.count = unread ? String(unread) : '';
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

function setTicketListState(message, isError = false) {
  const state = document.getElementById('ticketListState');
  if (!state) return;
  state.textContent = message;
  state.classList.toggle('error-text', isError);
  state.classList.toggle('hidden', !message);
}

async function loadTickets() {
  const client = getSupabaseClient();
  if (!client) {
    ticketsOnPage = [];
    ticketCount = 0;
    renderTicketTable();
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
    renderTicketTable();
    setTicketListState(`Could not load tickets: ${error.message}`, true);
    updateTicketPagination();
    return;
  }

  ticketsOnPage = data || [];
  ticketCount = count || 0;
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
  document.getElementById('ticketAssignedStaff').value = ticket.assigned_to || '';
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

async function openTicketDetail(ticketId) {
  const ticket = ticketsOnPage.find((row) => row.id === ticketId);
  if (!ticket) return;
  selectedTicket = ticket;
  document.getElementById('ticketListView').classList.add('hidden');
  document.getElementById('ticketDetailView').classList.remove('hidden');
  document.getElementById('ticketDetailState').textContent = '';
  document.getElementById('internalNotesList').innerHTML = '<li>Loading private notes…</li>';
  renderTicketInfo(ticket);
  await Promise.all([loadTicketConversation(), loadInternalNotes(), loadAssignableStaff(), loadTicketAssignmentHistory()]);
  subscribeToTicket(ticket.id);
  if (ticketPollTimer) window.clearInterval(ticketPollTimer);
  ticketPollTimer = window.setInterval(() => {
    loadTicketConversation();
    refreshSelectedTicket();
    loadTickets();
  }, 15000);
}

async function loadAssignableStaff() {
  const client = getSupabaseClient();
  const select = document.getElementById('ticketAssignedStaff');
  if (!client || !select) return;
  const { data, error } = await client.from('user_roles')
    .select('profile_id,profile:profiles!user_roles_profile_id_fkey(full_name,email)')
    .in('role_name', ['Administrator', 'IT Staff'])
    .is('revoked_at', null);
  if (error) {
    document.getElementById('ticketDetailState').textContent = `Could not load assignable IT staff: ${error.message}`;
    return;
  }
  const uniqueStaff = new Map();
  (data || []).forEach((row) => {
    if (row.profile) uniqueStaff.set(row.profile_id, row.profile);
  });
  select.innerHTML = '<option value="">Unassigned</option>' + [...uniqueStaff.entries()]
    .sort(([, first], [, second]) => first.full_name.localeCompare(second.full_name))
    .map(([id, profile]) => `<option value="${escapeHtml(id)}">${escapeHtml(profile.full_name)} · ${escapeHtml(profile.email)}</option>`)
    .join('');
  select.value = selectedTicket?.assigned_to || '';
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
  const client = getSupabaseClient();
  const state = document.getElementById('analyticsState');
  if (!client) {
    state.textContent = 'Configure Supabase in admin/config.js to load real browsing analytics.';
    return;
  }
  state.textContent = 'Loading analytics…';
  const since = new Date();
  since.setDate(since.getDate() - 6);
  since.setHours(0, 0, 0, 0);
  const { data, error } = await client.from('website_usage_logs')
    .select('domain,visit_count,total_seconds,bytes_used,recorded_at')
    .gte('recorded_at', since.toISOString())
    .order('recorded_at', { ascending: true });
  if (error) {
    state.textContent = `Could not load analytics: ${error.message}`;
    state.classList.add('error-text');
    return;
  }
  analyticsRecords = data || [];
  state.classList.remove('error-text');
  renderAnalyticsData(analyticsRecords);
  renderBarChart();
}

function renderAnalyticsData(records) {
  const stats = document.getElementById('analyticsStats');
  const chart = document.getElementById('analyticsChart');
  const sites = document.getElementById('topSitesList');
  const state = document.getElementById('analyticsState');
  const title = document.getElementById('analyticsChartTitle');
  const labels = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    date.setHours(0, 0, 0, 0);
    return date;
  });
  const byDay = labels.map((date) => {
    const dateKey = date.toLocaleDateString();
    const rows = records.filter((row) => new Date(row.recorded_at).toLocaleDateString() === dateKey);
    return {
      label: date.toLocaleDateString(undefined, { weekday: 'short' }),
      time: rows.reduce((sum, row) => sum + (Number(row.total_seconds) || 0), 0),
      data: rows.reduce((sum, row) => sum + (Number(row.bytes_used) || 0), 0) / (1024 * 1024),
      visits: rows.reduce((sum, row) => sum + (Number(row.visit_count) || 0), 0),
    };
  });
  const timeTotal = records.reduce((sum, row) => sum + (Number(row.total_seconds) || 0), 0);
  const mbTotal = records.reduce((sum, row) => sum + (Number(row.bytes_used) || 0), 0) / (1024 * 1024);
  const uniqueSites = new Set(records.map((row) => row.domain).filter(Boolean)).size;
  stats.innerHTML = [
    { label: 'Time spent', value: `${(timeTotal / 3600).toFixed(1)} h`, trend: 'last 7 days' },
    { label: 'Data usage', value: `${mbTotal.toFixed(1)} MB`, trend: 'last 7 days' },
    { label: 'Unique websites', value: String(uniqueSites), trend: 'last 7 days' },
  ].map((item) => `<article class="stat-card"><span class="metric-label">${item.label}</span><strong class="metric-value">${item.value}</strong><span class="metric-trend positive">${item.trend}</span></article>`).join('');
  const metric = analyticsMetric === 'data' ? 'data' : analyticsMetric === 'sites' ? 'visits' : 'time';
  const metricTitle = analyticsMetric === 'data' ? 'Data usage (MB)' : analyticsMetric === 'sites' ? 'Website visits' : 'Website time spent';
  title.textContent = metricTitle;
  sites.classList.toggle('hidden', analyticsMetric !== 'sites');
  chart.classList.toggle('hidden', analyticsMetric === 'sites');
  if (analyticsMetric === 'sites') {
    const rankedSites = new Map();
    records.forEach((row) => rankedSites.set(row.domain, (rankedSites.get(row.domain) || 0) + (Number(row.visit_count) || 0)));
    sites.innerHTML = [...rankedSites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([domain, visits]) => `<li><span class="dot"></span><span>${escapeHtml(domain)} — ${visits} visits</span></li>`).join('');
    state.textContent = records.length ? '' : 'No usage records were reported in the last 7 days.';
  } else {
    const max = Math.max(...byDay.map((row) => row[metric]), 0);
    chart.innerHTML = byDay.map((row) => {
      const value = row[metric];
      const height = max ? Math.max(4, value / max * 100) : 0;
      const displayValue = analyticsMetric === 'data' ? `${value.toFixed(1)} MB` : `${(value / 3600).toFixed(1)} h`;
      return `<div class="graph-column"><span class="graph-value">${displayValue}</span><div class="graph-track"><i style="height:${height}%"></i></div><small>${row.label}</small></div>`;
    }).join('');
    state.textContent = records.length ? '' : 'No usage records were reported in the last 7 days.';
  }
  state.classList.toggle('hidden', Boolean(records.length));
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

function setupTicketListRealtime() {
  if (!supabaseClient || ticketListRealtimeChannel) return;
  ticketListRealtimeChannel = supabaseClient
    .channel('admin-ticket-list')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, () => loadTickets())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ticket_messages' }, () => loadTickets())
    .subscribe();
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
      assign: 'Assign Employee',
      requests: 'Request Change',
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
  document.querySelectorAll('.nav-link[data-section]').forEach((button) => {
    button.addEventListener('click', () => setActiveSection(button.dataset.section));
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
      applyTheme(state.theme, state.accent);
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
    button.addEventListener('click', () => button.closest('.modal-backdrop')?.classList.add('hidden'));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) backdrop.classList.add('hidden');
    });
  });
  document.getElementById('versionButton')?.addEventListener('click', () => document.getElementById('updateLogsModal')?.classList.remove('hidden'));
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
  document.getElementById('notificationBellBtn')?.addEventListener('click', async () => {
    document.getElementById('notificationList')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const unreadIds = notifications.filter((notification) => !notification.is_read).map((notification) => notification.id);
    if (!unreadIds.length) return;
    try {
      const { error } = await getSupabaseClient().from('notifications').update({ is_read: true }).in('id', unreadIds);
      if (error) throw error;
      notifications = notifications.map((notification) => ({ ...notification, is_read: true }));
      renderNotifications();
      updateNotificationBell();
    } catch (error) {
      setDashboardState(`Notifications could not be marked read: ${error.message}`, true);
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
      const { error: verifyError } = await client.auth.signInWithPassword({
        email: adminUser.email,
        password: currentPassword.value,
      });
      document.getElementById('changePasswordForm')?.addEventListener('reset', (event) => {
        const form = event.currentTarget;
        window.setTimeout(() => {
          form.querySelector('input[type="email"]').value = adminUser.email || '';
          document.getElementById('accountFormState').classList.add('hidden');
        }, 0);
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
      applyTheme(nextState.theme, nextState.accent);
      saveState(nextState);
    });
  }

  document.querySelectorAll('.tab-link').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-link').forEach((link) => link.classList.toggle('active', link === tab));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tab.dataset.tab));
    });
  });

  const scheduleForm = document.getElementById('scheduleForm');
  if (scheduleForm) {
    const resetRuleForm = () => {
      scheduleForm.reset();
      scheduleForm.elements.ruleId.value = '';
      document.getElementById('cancelRuleEditBtn').classList.add('hidden');
    };
    document.getElementById('cancelRuleEditBtn')?.addEventListener('click', resetRuleForm);
    scheduleForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(scheduleForm);
      const domain = String(formData.get('domain') || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      const days = formData.getAll('days');
      if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
        scheduleForm.elements.domain.setCustomValidity('Enter a valid website domain without a path.');
        scheduleForm.elements.domain.reportValidity();
        return;
      }
      scheduleForm.elements.domain.setCustomValidity('');
      if (!days.length) {
        setDashboardState('Select at least one day for this blocking schedule.', true);
        return;
      }
      const ruleId = String(formData.get('ruleId') || '');
      const priorRule = blockingRules.find((rule) => rule.id === ruleId);
      const values = {
        domain,
        start_time: formData.get('startTime'),
        end_time: formData.get('endTime'),
        days_of_week: days,
        is_active: priorRule?.is_active ?? true,
        created_by: adminUser.id,
      };
      const submit = scheduleForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const query = ruleId
          ? await getSupabaseClient().from('website_blocking_rules').update(values).eq('id', ruleId)
          : await getSupabaseClient().from('website_blocking_rules').insert(values);
        if (query.error) throw query.error;
        await writeChangeLog(ruleId ? 'Updated blocking schedule' : 'Created blocking schedule', 'Website blocking', ruleId || domain);
        resetRuleForm();
        await loadDashboardData();
        setDashboardState(`Policy saved for ${domain}.`);
      } catch (error) {
        setDashboardState(`Website policy could not be saved: ${error.message}`, true);
      } finally {
        submit.disabled = false;
      }
    });
  }
  document.getElementById('blockingTable')?.addEventListener('click', (event) => {
    const button = event.target.closest('.edit-blocking-rule');
    if (!button) return;
    const rule = blockingRules.find((row) => row.id === button.dataset.ruleId);
    if (!rule) return;
    const form = document.getElementById('scheduleForm');
    form.elements.ruleId.value = rule.id;
    form.elements.domain.value = rule.domain;
    form.elements.startTime.value = rule.start_time.slice(0, 5);
    form.elements.endTime.value = rule.end_time.slice(0, 5);
    form.querySelectorAll('input[name="days"]').forEach((input) => {
      input.checked = (rule.days_of_week || []).includes(input.value);
    });
    document.getElementById('cancelRuleEditBtn').classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  const assignmentForm = document.getElementById('assignmentForm');
  if (assignmentForm) {
    assignmentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const employeeId = document.getElementById('assignmentEmployee').value;
      const laptopId = document.getElementById('assignmentLaptop').value;
      const employee = directoryEmployees.find((row) => row.id === employeeId);
      const laptop = directoryLaptops.find((row) => row.id === laptopId);
      if (!employee || !laptop || laptop.status !== 'Available' || !employee.active) {
        setDashboardState('Choose an active employee and an available laptop.', true);
        return;
      }
      try {
        const { error } = await getSupabaseClient().from('laptop_assignments').insert({
          employee_id: employee.id,
          laptop_id: laptop.id,
          assigned_by: adminUser.id,
          status: 'Active',
        });
        if (error) throw error;
        await writeChangeLog('Assigned laptop', 'Assignments', laptop.laptop_id);
        await loadDashboardData();
        setDashboardState(`Laptop ${laptop.laptop_id} assigned to ${employee.name}.`);
      } catch (error) {
        setDashboardState(`Laptop assignment failed: ${error.message}`, true);
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
      'Last sync': device?.last_sync_at ? formatDate(device.last_sync_at) : '—',
    };
    document.getElementById('userDetailsContent').innerHTML = Object.entries(details)
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    document.getElementById('userDetailsModal').classList.remove('hidden');
  });

  document.getElementById('employeeSearch')?.addEventListener('input', renderEmployeeTable);
  document.getElementById('employeeStatusFilter')?.addEventListener('change', renderEmployeeTable);
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
      renderTicketInfo(selectedTicket);
      await loadTickets();
    } catch (error) {
      document.getElementById('ticketDetailState').textContent = `Status update failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('assignTicketBtn')?.addEventListener('click', async () => {
    if (!selectedTicket || !supabaseClient) return;
    const button = document.getElementById('assignTicketBtn');
    const targetProfileId = document.getElementById('ticketAssignedStaff').value || null;
    button.disabled = true;
    try {
      const { error } = await supabaseClient.rpc('assign_ticket_staff', {
        target_ticket_id: selectedTicket.id,
        target_profile_id: targetProfileId,
      });
      if (error) throw error;
      const { data: updatedTicket, error: ticketError } = await supabaseClient.from('tickets')
        .select('id,ticket_number,profile_id,employee_id,laptop_id,subject,issue_category,priority,assigned_to,status,description,created_at,updated_at,profile:profiles!tickets_profile_id_fkey(full_name,email),employee:employees!tickets_employee_id_fkey(user_id),laptop:laptops!tickets_laptop_id_fkey(laptop_id,device_registration_id,model),assigned_staff:profiles!tickets_assigned_to_fkey(full_name)')
        .eq('id', selectedTicket.id)
        .single();
      if (ticketError) throw ticketError;
      selectedTicket = updatedTicket;
      renderTicketInfo(selectedTicket);
      document.getElementById('ticketDetailState').textContent = 'Ticket assignment updated.';
      await Promise.all([loadTicketAssignmentHistory(), loadTickets()]);
    } catch (error) {
      document.getElementById('ticketDetailState').textContent = `Ticket assignment failed: ${error.message}`;
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
      ? `<p class="span-2">Employee ID is assigned automatically. The email must already belong to a registered account.</p><label><span>Email</span><input name="email" type="email" required></label><label><span>Department</span><input name="department"></label><label><span>Position</span><input name="position"></label><label><span>Role</span><select name="role">${employeeRoleOptions}</select></label><label><span>Status</span><select name="active"><option value="true">Active</option><option value="false">Suspended</option></select></label><div class="span-2 actions-row"><button class="primary-btn" type="submit">Add employee</button></div>`
      : '<p class="span-2">Laptop ID is assigned automatically.</p><label><span>Model</span><input name="model" required></label><label><span>Status</span><select name="status"><option>Available</option><option>Maintenance</option><option>Retired</option></select></label><div class="span-2 actions-row"><button class="primary-btn" type="submit">Add laptop</button></div>';
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
        const { data: profiles, error: profileError } = await client.from('profiles')
          .select('id,email').eq('email', String(formData.email).trim()).limit(1);
        if (profileError) throw profileError;
        if (!profiles.length) throw new Error('No registered account uses that email. Create its account first.');
        const { data: employee, error } = await client.from('employees').insert({
          profile_id: profiles[0].id,
          department: formData.department || null,
          position: formData.position || null,
          active: formData.active === 'true',
        }).select('user_id').single();
        if (error) throw error;
        const { error: roleError } = await client.from('user_roles').upsert({
          profile_id: profiles[0].id,
          role_name: formData.role,
          assigned_by: adminUser.id,
          revoked_at: null,
        }, { onConflict: 'profile_id,role_name' });
        if (roleError) throw roleError;
        await writeChangeLog('Created employee record', 'Employees', employee.user_id);
      } else {
        const { data: laptop, error } = await client.from('laptops').insert({
          model: formData.model.trim(),
          status: formData.status,
        }).select('laptop_id').single();
        if (error) throw error;
        await writeChangeLog('Created laptop', 'Laptops', laptop.laptop_id);
      }
      createRecordModal.classList.add('hidden');
      createRecordForm.reset();
      await loadDashboardData();
    } catch (error) {
      setDashboardState(`Record could not be created: ${error.message}`, true);
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('requestTable')?.addEventListener('click', (event) => {
    const button = event.target.closest('.review-change-request');
    if (!button) return;
    selectedChangeRequest = changeRequests.find((request) => request.id === button.dataset.requestId);
    if (!selectedChangeRequest) return;
    document.getElementById('requestReviewDetails').innerHTML = `
      <dl class="details-grid">
        <div><dt>Employee</dt><dd>${escapeHtml(selectedChangeRequest.employeeName)}</dd></div>
        <div><dt>Request</dt><dd>${escapeHtml(selectedChangeRequest.request_type)}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(selectedChangeRequest.status)}</dd></div>
        <div><dt>Reason</dt><dd>${escapeHtml(selectedChangeRequest.reason)}</dd></div>
      </dl>`;
    document.getElementById('requestReviewRemarks').value = selectedChangeRequest.administrator_remarks || '';
    document.getElementById('requestReviewState').classList.add('hidden');
    document.getElementById('approveRequestBtn').disabled = selectedChangeRequest.status !== 'Pending';
    document.getElementById('rejectRequestBtn').disabled = selectedChangeRequest.status !== 'Pending';
    document.getElementById('requestReviewModal').classList.remove('hidden');
  });
  const reviewRequest = async (status) => {
    if (!selectedChangeRequest) return;
    const state = document.getElementById('requestReviewState');
    try {
      const { error } = await getSupabaseClient().from('laptop_change_requests')
        .update({
          status,
          administrator_remarks: document.getElementById('requestReviewRemarks').value.trim() || null,
        }).eq('id', selectedChangeRequest.id);
      if (error) throw error;
      await writeChangeLog(`${status} change request`, 'Change requests', selectedChangeRequest.id);
      document.getElementById('requestReviewModal').classList.add('hidden');
      await loadDashboardData();
    } catch (error) {
      state.textContent = `Request review failed: ${error.message}`;
      state.classList.remove('hidden');
      state.classList.add('error-text');
    }
  };
  document.getElementById('approveRequestBtn')?.addEventListener('click', () => reviewRequest('Approved'));
  document.getElementById('rejectRequestBtn')?.addEventListener('click', () => reviewRequest('Rejected'));
}

async function initDashboard() {
  const authorized = await ensureAdminSession();
  if (!authorized) return;

  const state = readState();
  applyTheme(state.theme, state.accent);

  renderBarChart();
  renderTicketLegend();
  renderAnalytics();
  setupDashboardInteractions();
  setupTicketListRealtime();
  await Promise.all([loadDashboardData(), loadTickets(), loadAnalyticsData()]);
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    setupLoginPage();
  } else {
    initDashboard();
  }
});
