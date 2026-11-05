const DEMO_DATA = {
  stats: [
    { label: 'Total employees', value: '147', trend: '+12%' },
    { label: 'Registered laptops', value: '214', trend: '+7%' },
    { label: 'Currently assigned', value: '132', trend: '+5%' },
    { label: 'Available laptops', value: '82', trend: 'Stable' },
    { label: 'Active schedules', value: '9', trend: '4 today' },
    { label: 'Blocked websites', value: '76', trend: '+8%' },
    { label: 'Incognito policy', value: 'Enabled', trend: 'Valid' },
    { label: 'Open tickets', value: '17', trend: '4 urgent' },
    { label: 'Pending replacement', value: '4', trend: 'Review' },
  ],
  activities: [
    'Employee integration completed for 5 new laptops.',
    'Website blocking schedule updated for marketing team.',
    'Laptop replacement request approved for Selena Park.',
    'Global Incognito policy successfully synchronized with 42 devices.',
    'Ticket category retention cleanup executed for 12 closed tickets.',
  ],
  notifications: [
    { title: 'Ticket escalated', text: 'Ticket #MND-643 was assigned to IT Ops.' },
    { title: 'Policy update', text: 'Workday scheduling block is now active for all eligible devices.' },
    { title: 'Laptop replacement', text: 'Replacement device for David Kim is ready for collection.' },
  ],
  blocking: [
    { name: 'Social media limit', scope: 'Global', time: '09:00 - 17:30', status: 'Active' },
    { name: 'News and media block', scope: 'Assigned', time: '08:00 - 18:00', status: 'Scheduled' },
    { name: 'Streaming restriction', scope: 'Individual', time: 'All day', status: 'Paused' },
  ],
  assignments: [
    { userId: 'USR-1001', employee: 'Selena Park', laptop: 'ML-209', date: '2026-10-15', status: 'Active' },
    { userId: 'USR-1002', employee: 'David Kim', laptop: 'ML-310', date: '2026-09-29', status: 'Active' },
    { userId: 'USR-1003', employee: 'Priya Shah', laptop: 'ML-512', date: '2026-10-02', status: 'Terminated' },
  ],
  requests: [
    { employee: 'Selena Park', type: 'Laptop Replacement', reason: 'Battery swelling reported by employee.', status: 'Pending' },
    { employee: 'David Kim', type: 'Reassignment', reason: 'Requested a better workstation setup.', status: 'Approved' },
    { employee: 'Priya Shah', type: 'Account Access', reason: 'Need broader access to project tasks.', status: 'Rejected' },
  ],
  employees: [
    { userId: 'USR-1001', name: 'Selena Park', email: 'selena.park@mindlock.com', department: 'Operations', position: 'Operations Manager', role: 'Administrator', laptop: 'ML-209', status: 'Active' },
    { userId: 'USR-1002', name: 'David Kim', email: 'david.kim@mindlock.com', department: 'Engineering', position: 'Software Engineer', role: 'Employee', laptop: 'ML-310', status: 'Active' },
    { userId: 'USR-1003', name: 'Priya Shah', email: 'priya.shah@mindlock.com', department: 'Marketing', position: 'Marketing Specialist', role: 'IT Staff', laptop: 'ML-512', status: 'Suspended' },
    { userId: 'USR-1004', name: 'Morgan Lee', email: 'morgan.lee@mindlock.com', department: 'Support', position: 'Support Associate', role: 'Employee', laptop: '', status: 'Active' },
  ],
  laptops: [
    { id: 'ML-209', model: 'Dell Latitude 7440', status: 'Assigned', assignment: 'Selena Park', sync: '2 min ago' },
    { id: 'ML-310', model: 'HP EliteBook 845', status: 'Assigned', assignment: 'David Kim', sync: '5 min ago' },
    { id: 'ML-512', model: 'Lenovo ThinkPad T14', status: 'Maintenance', assignment: 'Priya Shah', sync: '1 day ago' },
    { id: 'ML-513', model: 'Dell Latitude 5450', status: 'Available', assignment: 'Unassigned', sync: 'Never' },
  ],
};

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
    return saved ? JSON.parse(saved) : { theme: 'light', accent: '#2563eb', incognitoEnabled: false, notificationsHidden: false };
  } catch (error) {
    return { theme: 'light', accent: '#2563eb', incognitoEnabled: false, notificationsHidden: false };
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

  sessionStorage.setItem('mindlock-show-update-logs-after-login', 'true');
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

  statsGrid.innerHTML = DEMO_DATA.stats
    .map(
      (stat) => `
        <article class="stat-card">
          <span class="metric-label">${stat.label}</span>
          <strong class="metric-value">${stat.value}</strong>
          <span class="metric-trend ${stat.trend.includes('Review') || stat.trend.includes('Open') ? 'warning' : 'positive'}">${stat.trend}</span>
        </article>
      `,
    )
    .join('');
}

function renderActivityList() {
  const activityList = document.getElementById('activityList');
  if (!activityList) return;
  activityList.innerHTML = DEMO_DATA.activities
    .map(
      (item) => `
        <li>
          <span class="dot"></span>
          <span>${item}</span>
        </li>
      `,
    )
    .join('');
}

function renderNotifications() {
  const container = document.getElementById('notificationList');
  if (!container) return;

  container.innerHTML = DEMO_DATA.notifications
    .map(
      (item) => `
        <li>
          <strong>${item.title}</strong>
          <small>${item.text}</small>
        </li>
      `,
    )
    .join('');
}

function renderBarChart() {
  const usageChart = document.getElementById('usageChart');
  if (!usageChart) return;

  const data = [72, 84, 58, 96, 66, 88, 81];
  usageChart.innerHTML = data
    .map(
      (value) => `
        <div class="bar-group">
          <span style="height:${value}%" title="${value}%"></span>
          <small>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][data.indexOf(value)]}</small>
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

  const items = [
    { label: 'Open', value: '58%', color: '#ef4444' },
    { label: 'In progress', value: '22%', color: '#f59e0b' },
    { label: 'Resolved', value: '15%', color: '#10b981' },
    { label: 'Closed', value: '5%', color: '#3b82f6' },
  ];

  container.innerHTML = items
    .map(
      (item) => `
        <div class="legend-item">
          <span class="legend-dot" style="background:${item.color}"></span>
          <span>${item.label}</span>
          <strong>${item.value}</strong>
        </div>
      `,
    )
    .join('');
}

function renderBlockingTable() {
  const table = document.getElementById('blockingTable');
  if (!table) return;
  table.innerHTML = DEMO_DATA.blocking
    .map(
      (row) => `
        <tr>
          <td>${row.name}</td>
          <td>${row.scope}</td>
          <td>${row.time}</td>
          <td><span class="status-pill ${row.status.toLowerCase() === 'active' ? 'success' : row.status.toLowerCase() === 'scheduled' ? 'warning' : 'neutral'}">${row.status}</span></td>
          <td><button class="text-btn">Edit</button></td>
        </tr>
      `,
    )
    .join('');
}

function renderAssignmentTable() {
  const table = document.getElementById('assignmentTable');
  if (!table) return;
  table.innerHTML = DEMO_DATA.assignments
    .map(
      (row) => `
        <tr>
          <td><button class="text-btn user-details-btn" data-user-id="${escapeHtml(row.userId)}">${escapeHtml(row.userId)}</button></td>
          <td>${escapeHtml(row.employee)}</td>
          <td>${escapeHtml(row.laptop)}</td>
          <td>${escapeHtml(row.date)}</td>
          <td><span class="status-pill ${row.status === 'Active' ? 'success' : 'neutral'}">${row.status}</span></td>
        </tr>
      `,
    )
    .join('');
}

function renderAssignmentOptions() {
  const employeeSelect = document.getElementById('assignmentEmployee');
  const laptopSelect = document.getElementById('assignmentLaptop');
  if (!employeeSelect || !laptopSelect) return;
  const employees = DEMO_DATA.employees.filter((row) => row.status === 'Active' && !row.laptop);
  const laptops = DEMO_DATA.laptops.filter((row) => row.status === 'Available');
  employeeSelect.innerHTML = `<option value="">Select an employee</option>${employees.map((row) => `<option>${escapeHtml(row.name)}</option>`).join('')}`;
  laptopSelect.innerHTML = `<option value="">Select an available laptop</option>${laptops.map((row) => `<option>${escapeHtml(row.id)}</option>`).join('')}`;
}

function renderRequestTable() {
  const table = document.getElementById('requestTable');
  if (!table) return;
  table.innerHTML = DEMO_DATA.requests
    .map(
      (row) => `
        <tr>
          <td>${row.employee}</td>
          <td>${row.type}</td>
          <td>${row.reason}</td>
          <td><span class="status-pill ${row.status === 'Approved' ? 'success' : row.status === 'Pending' ? 'warning' : 'neutral'}">${row.status}</span></td>
          <td><button class="text-btn">Review</button></td>
        </tr>
      `,
    )
    .join('');
}

function renderEmployeeTable() {
  const table = document.getElementById('employeeTable');
  if (!table) return;
  const query = (document.getElementById('employeeSearch')?.value || '').trim().toLowerCase();
  const status = document.getElementById('employeeStatusFilter')?.value || '';
  table.innerHTML = DEMO_DATA.employees
    .filter((row) => (!status || row.status === status) && (!query || `${row.userId} ${row.name} ${row.department} ${row.email}`.toLowerCase().includes(query)))
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.userId)}</td>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.department)}</td>
          <td>${escapeHtml(row.role)}</td>
          <td>${escapeHtml(row.laptop || 'Unassigned')}</td>
          <td><span class="status-pill ${row.status === 'Active' ? 'success' : 'neutral'}">${escapeHtml(row.status)}</span></td>
        </tr>
      `,
    )
    .join('');
}

function renderUserRoleAssignments() {
  const table = document.getElementById('userRoleAssignments');
  if (!table) return;
  table.innerHTML = DEMO_DATA.employees.map((employee) => `
    <tr><td>${escapeHtml(employee.userId)}</td><td>${escapeHtml(employee.name)}</td><td>${escapeHtml(employee.role)}</td></tr>
  `).join('');
}

function renderLaptopTable() {
  const table = document.getElementById('laptopTable');
  if (!table) return;
  const query = (document.getElementById('laptopSearch')?.value || '').trim().toLowerCase();
  const status = document.getElementById('laptopStatusFilter')?.value || '';
  table.innerHTML = DEMO_DATA.laptops
    .filter((row) => (!status || row.status === status) && (!query || `${row.id} ${row.model} ${row.assignment}`.toLowerCase().includes(query)))
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.id)}</td>
          <td>${escapeHtml(row.model)}</td>
          <td><span class="status-pill ${row.status === 'Assigned' ? 'success' : row.status === 'Maintenance' ? 'warning' : 'neutral'}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(row.assignment)}</td>
          <td>${escapeHtml(row.sync)}</td>
        </tr>
      `,
    )
    .join('');
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
    await Promise.all([loadTickets(), loadAnalyticsData()]);
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

  document.querySelectorAll('.eye-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const password = button.parentElement.querySelector('input');
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${password.getAttribute('autocomplete').replace('-', ' ')} password`);
    });
  });
  document.getElementById('changePasswordForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = [...event.currentTarget.querySelectorAll('input[type="password"]')];
    if (fields[1].value !== fields[2].value) {
      fields[2].setCustomValidity('Passwords do not match.');
      fields[2].reportValidity();
      return;
    }
    fields[2].setCustomValidity('');
    alert('Password form validated. Connect Supabase Auth to save the password securely.');
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

  const dismissNoticeBtn = document.getElementById('dismissNoticeBtn');
  if (dismissNoticeBtn) {
    dismissNoticeBtn.addEventListener('click', () => {
      sessionStorage.setItem('mindlock-notifications-hidden', 'true');
      const notificationList = document.getElementById('notificationList');
      if (notificationList) {
        notificationList.innerHTML = '<li><strong>Notifications hidden for this session.</strong></li>';
      }
    });
  }

  const scheduleForm = document.getElementById('scheduleForm');
  if (scheduleForm) {
    scheduleForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const domain = new FormData(scheduleForm).get('domain');
      alert(`Blocking policy saved for ${domain || 'the selected domain'}.`);
    });
  }

  const assignmentForm = document.getElementById('assignmentForm');
  if (assignmentForm) {
    assignmentForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const employee = document.getElementById('assignmentEmployee').value;
      const laptop = document.getElementById('assignmentLaptop').value;
      const profile = DEMO_DATA.employees.find((row) => row.name === employee);
      const device = DEMO_DATA.laptops.find((row) => row.id === laptop);
      if (!profile || !device || device.status !== 'Available') {
        alert('Choose an active employee and an available laptop.');
        return;
      }
      if (DEMO_DATA.assignments.some((row) => row.userId === profile.userId && row.status === 'Active')) {
        alert('This employee already has an active laptop assignment.');
        return;
      }
      device.status = 'Assigned';
      device.assignment = profile.name;
      profile.laptop = device.id;
      DEMO_DATA.assignments.push({ userId: profile.userId, employee: profile.name, laptop: device.id, date: new Date().toISOString().slice(0, 10), status: 'Active' });
      renderAssignmentTable();
      renderLaptopTable();
      renderEmployeeTable();
      renderAssignmentOptions();
      alert(`Laptop ${laptop} assigned to ${employee}.`);
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
    const profile = DEMO_DATA.employees.find((row) => row.userId === button.dataset.userId);
    const device = DEMO_DATA.laptops.find((row) => row.id === profile?.laptop);
    if (!profile) return;
    const details = {
      'User ID': profile.userId,
      'Full name': profile.name,
      Email: profile.email,
      Department: profile.department,
      Position: profile.position,
      Role: profile.role,
      'Account status': profile.status,
      'Assigned laptop': device?.id || 'Unassigned',
      Model: device?.model || '—',
      'Laptop status': device?.status || '—',
      'Last sync': device?.sync || '—',
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
  roleFormToggle?.addEventListener('click', () => roleForm.classList.toggle('hidden'));
  document.getElementById('cancelRoleAssignmentBtn')?.addEventListener('click', () => roleForm.classList.add('hidden'));
  roleForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const userId = document.getElementById('roleUserId').value.trim();
    const role = document.getElementById('roleSelection').value;
    const profile = DEMO_DATA.employees.find((row) => row.userId === userId);
    if (!profile) {
      alert('No matching user ID found in the current directory.');
      return;
    }
    profile.role = role;
    renderEmployeeTable();
    renderUserRoleAssignments();
    alert(`${role} role assigned to ${userId}. Connect the role action to Supabase before production.`);
    roleForm.reset();
    roleForm.classList.add('hidden');
  });

  const createRecordModal = document.getElementById('createRecordModal');
  const createRecordForm = document.getElementById('createRecordForm');
  const openCreateForm = (kind) => {
    const employee = kind === 'employee';
    const title = employee ? 'Add employee' : 'Add laptop';
    document.getElementById('createRecordTitle').textContent = title;
    createRecordForm.dataset.kind = kind;
    createRecordForm.innerHTML = employee
      ? '<label><span>User ID</span><input name="userId" required placeholder="USR-1004"></label><label><span>Full name</span><input name="name" required></label><label><span>Email</span><input name="email" type="email" required></label><label><span>Department</span><input name="department" required></label><label><span>Role</span><select name="role"><option>Employee</option><option>IT Staff</option><option>Administrator</option></select></label><label><span>Status</span><select name="status"><option>Active</option><option>Suspended</option></select></label><div class="span-2 actions-row"><button class="primary-btn" type="submit">Add employee</button></div>'
      : '<label><span>Laptop ID</span><input name="id" required placeholder="ML-513"></label><label><span>Model</span><input name="model" required></label><label><span>Status</span><select name="status"><option>Available</option><option>Maintenance</option><option>Retired</option></select></label><div class="span-2 actions-row"><button class="primary-btn" type="submit">Add laptop</button></div>';
    createRecordModal.classList.remove('hidden');
  };
  document.getElementById('addEmployeeBtn')?.addEventListener('click', () => openCreateForm('employee'));
  document.getElementById('addLaptopBtn')?.addEventListener('click', () => openCreateForm('laptop'));
  createRecordForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = Object.fromEntries(new FormData(createRecordForm));
    if (createRecordForm.dataset.kind === 'employee') {
      if (DEMO_DATA.employees.some((row) => row.userId === formData.userId || row.email === formData.email)) {
        alert('That user ID or email is already in use.');
        return;
      }
      DEMO_DATA.employees.push({ ...formData, laptop: 'Unassigned', position: '', status: formData.status });
      DEMO_DATA.employees[DEMO_DATA.employees.length - 1].laptop = '';
      renderEmployeeTable();
      renderUserRoleAssignments();
      renderAssignmentOptions();
    } else {
      if (DEMO_DATA.laptops.some((row) => row.id === formData.id)) {
        alert('That laptop ID is already registered.');
        return;
      }
      DEMO_DATA.laptops.push({ ...formData, assignment: 'Unassigned', sync: 'Never' });
      renderLaptopTable();
      renderAssignmentOptions();
    }
    createRecordModal.classList.add('hidden');
    createRecordForm.reset();
  });
}

async function initDashboard() {
  const authorized = await ensureAdminSession();
  if (!authorized) return;

  const state = readState();
  applyTheme(state.theme, state.accent);

  renderMetricCards();
  renderActivityList();
  renderNotifications();
  renderBarChart();
  renderTicketLegend();
  renderAnalytics();
  renderBlockingTable();
  renderAssignmentTable();
  renderAssignmentOptions();
  renderRequestTable();
  renderEmployeeTable();
  renderLaptopTable();
  setupDashboardInteractions();
  setupTicketListRealtime();
  loadTickets();
  loadAnalyticsData();
  if (sessionStorage.getItem('mindlock-show-update-logs-after-login') === 'true') {
    sessionStorage.removeItem('mindlock-show-update-logs-after-login');
    document.getElementById('updateLogsModal').classList.remove('hidden');
  }

  if (sessionStorage.getItem('mindlock-notifications-hidden') === 'true') {
    const notificationList = document.getElementById('notificationList');
    if (notificationList) {
      notificationList.innerHTML = '<li><strong>Notifications hidden for this session.</strong></li>';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    setupLoginPage();
  } else {
    initDashboard();
  }
});
