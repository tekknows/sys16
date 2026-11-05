const DEMO_USERS = [
  { email: 'sys@admin.com', password: 'admin123', name: 'System Administrator' },
  { email: 'it@mindlock.com', password: 'admin123', name: 'IT Operations' },
];

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
  tickets: [
    { id: 'MND-643', employee: 'Selena Park', category: 'Browser Extension Issue', status: 'Open', updated: '12 min ago' },
    { id: 'MND-668', employee: 'David Kim', category: 'Website Blocking Issue', status: 'In Progress', updated: '46 min ago' },
    { id: 'MND-681', employee: 'Priya Shah', category: 'Laptop Hardware Problem', status: 'Resolved', updated: '1 day ago' },
  ],
  analytics: [
    { label: 'Tracked active devices', value: '198', trend: 'last 24 hours' },
    { label: 'Total tracked time', value: '428h', trend: 'this week' },
    { label: 'Policy blocks', value: '1,284', trend: 'this week' },
  ],
  topSites: ['docs.google.com — 18h 42m', 'github.com — 15h 18m', 'slack.com — 12h 06m', 'youtube.com — 3h 24m'],
};

const STORAGE_KEYS = {
  session: 'mindlock-admin-session',
  settings: 'mindlock-admin-settings',
};

function readState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.settings);
    return saved ? JSON.parse(saved) : { theme: 'light', accent: '#2563eb', incognitoEnabled: false, notificationsHidden: false };
  } catch (error) {
    return { theme: 'light', accent: '#2563eb', incognitoEnabled: false, notificationsHidden: false };
  }
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
    btn.textContent = themeName === 'dark' ? 'Light mode' : 'Dark mode';
  }
}

function ensureAdminSession() {
  const session = localStorage.getItem(STORAGE_KEYS.session);
  if (!session) {
    window.location.href = 'index.html';
  }
}

function validateCredentials(email, password) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  const matchedUser = DEMO_USERS.find((user) => user.email === normalizedEmail && user.password === password);
  return matchedUser || null;
}

function handleLogin(ev) {
  ev.preventDefault();
  const email = document.getElementById('email')?.value || '';
  const password = document.getElementById('password')?.value || '';
  const errorLabel = document.getElementById('loginError');

  if (!email || !password) {
    errorLabel.textContent = 'Please enter your email and password.';
    errorLabel.classList.remove('hidden');
    return;
  }

  const user = validateCredentials(email, password);
  if (!user) {
    errorLabel.textContent = 'Invalid credentials. Please use the default admin credentials or update your database settings.';
    errorLabel.classList.remove('hidden');
    return;
  }

  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({ email: user.email, name: user.name, role: 'Administrator' }));
  const remember = document.getElementById('remember')?.checked;
  if (remember) {
    localStorage.setItem('mindlock-remember-admin', user.email);
  } else {
    localStorage.removeItem('mindlock-remember-admin');
  }

  window.location.href = 'dashboard.html';
}

function setupLoginPage() {
  const loginForm = document.getElementById('loginForm');
  const demoBtn = document.getElementById('demoLoginBtn');
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

  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      document.getElementById('email').value = 'sys@admin.com';
      document.getElementById('password').value = 'admin123';
      document.getElementById('remember').checked = true;
      handleLogin({ preventDefault: () => {} });
    });
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
  if (stats) {
    stats.innerHTML = DEMO_DATA.analytics.map((item) => `
      <article class="stat-card"><span class="metric-label">${escapeHtml(item.label)}</span><strong class="metric-value">${escapeHtml(item.value)}</strong><span class="metric-trend positive">${escapeHtml(item.trend)}</span></article>
    `).join('');
  }
  if (chart) {
    chart.innerHTML = [62, 76, 57, 91, 68, 34, 24].map((value, index) => `
      <div class="bar-group"><span style="height:${value}%" title="${value}%"></span><small>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index]}</small></div>
    `).join('');
  }
  if (sites) {
    sites.innerHTML = DEMO_DATA.topSites.map((site) => `<li><span class="dot"></span><span>${escapeHtml(site)}</span></li>`).join('');
  }
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
  const query = (document.getElementById('ticketSearch')?.value || '').trim().toLowerCase();
  const status = document.getElementById('ticketStatusFilter')?.value || '';
  const category = document.getElementById('ticketCategoryFilter')?.value || '';
  table.innerHTML = DEMO_DATA.tickets
    .filter((row) => (!status || row.status === status) && (!category || row.category === category) && (!query || `${row.id} ${row.employee}`.toLowerCase().includes(query)))
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.id)}</td>
          <td>${escapeHtml(row.employee)}</td>
          <td>${escapeHtml(row.category)}</td>
          <td><span class="status-pill ${row.status === 'Open' ? 'warning' : row.status === 'Resolved' ? 'success' : 'neutral'}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(row.updated)}</td>
        </tr>
      `,
    )
    .join('');
}

function setActiveSection(name) {
  document.querySelectorAll('.nav-link').forEach((button) => {
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
}

function setupDashboardInteractions() {
  document.querySelectorAll('.nav-link').forEach((button) => {
    button.addEventListener('click', () => setActiveSection(button.dataset.section));
  });

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderMetricCards();
      renderActivityList();
      renderNotifications();
      renderBarChart();
      renderTicketLegend();
    });
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEYS.session);
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
  const updateLogsBtn = document.getElementById('updateLogsBtn');
  updateLogsBtn?.addEventListener('click', () => document.getElementById('updateLogsModal')?.classList.remove('hidden'));

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
    document.getElementById(id)?.addEventListener('input', renderTicketTable);
    document.getElementById(id)?.addEventListener('change', renderTicketTable);
  });

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

function initDashboard() {
  ensureAdminSession();

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
  renderTicketTable();
  setupDashboardInteractions();

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
