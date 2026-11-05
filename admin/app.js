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
    { employee: 'Selena Park', laptop: 'ML-209', date: '2026-10-15', status: 'Active' },
    { employee: 'David Kim', laptop: 'ML-310', date: '2026-09-29', status: 'Active' },
    { employee: 'Priya Shah', laptop: 'ML-512', date: '2026-10-02', status: 'Terminated' },
  ],
  requests: [
    { employee: 'Selena Park', type: 'Laptop Replacement', reason: 'Battery swelling reported by employee.', status: 'Pending' },
    { employee: 'David Kim', type: 'Reassignment', reason: 'Requested a better workstation setup.', status: 'Approved' },
    { employee: 'Priya Shah', type: 'Account Access', reason: 'Need broader access to project tasks.', status: 'Rejected' },
  ],
  employees: [
    { name: 'Selena Park', department: 'Operations', role: 'Administrator', laptop: 'ML-209', status: 'Active' },
    { name: 'David Kim', department: 'Engineering', role: 'Employee', laptop: 'ML-310', status: 'Active' },
    { name: 'Priya Shah', department: 'Marketing', role: 'IT Staff', laptop: 'ML-512', status: 'Suspended' },
  ],
  laptops: [
    { id: 'ML-209', model: 'Dell Latitude 7440', status: 'Assigned', assignment: 'Selena Park', sync: '2 min ago' },
    { id: 'ML-310', model: 'HP EliteBook 845', status: 'Assigned', assignment: 'David Kim', sync: '5 min ago' },
    { id: 'ML-512', model: 'Lenovo ThinkPad T14', status: 'Maintenance', assignment: 'Priya Shah', sync: '1 day ago' },
  ],
  tickets: [
    { id: 'MND-643', employee: 'Selena Park', category: 'Browser Extension Issue', status: 'Open', updated: '12 min ago' },
    { id: 'MND-668', employee: 'David Kim', category: 'Website Blocking Issue', status: 'In Progress', updated: '46 min ago' },
    { id: 'MND-681', employee: 'Priya Shah', category: 'Laptop Hardware Problem', status: 'Resolved', updated: '1 day ago' },
  ],
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
      togglePassword.textContent = isHidden ? 'Hide' : 'Show';
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
          <small>W${Math.ceil(Math.random() * 7)}</small>
        </div>
      `,
    )
    .join('');
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
          <td>${row.employee}</td>
          <td>${row.laptop}</td>
          <td>${row.date}</td>
          <td><span class="status-pill ${row.status === 'Active' ? 'success' : 'neutral'}">${row.status}</span></td>
        </tr>
      `,
    )
    .join('');
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
  table.innerHTML = DEMO_DATA.employees
    .map(
      (row) => `
        <tr>
          <td>${row.name}</td>
          <td>${row.department}</td>
          <td>${row.role}</td>
          <td>${row.laptop}</td>
          <td><span class="status-pill ${row.status === 'Active' ? 'success' : 'neutral'}">${row.status}</span></td>
        </tr>
      `,
    )
    .join('');
}

function renderLaptopTable() {
  const table = document.getElementById('laptopTable');
  if (!table) return;
  table.innerHTML = DEMO_DATA.laptops
    .map(
      (row) => `
        <tr>
          <td>${row.id}</td>
          <td>${row.model}</td>
          <td><span class="status-pill ${row.status === 'Assigned' ? 'success' : row.status === 'Maintenance' ? 'warning' : 'neutral'}">${row.status}</span></td>
          <td>${row.assignment}</td>
          <td>${row.sync}</td>
        </tr>
      `,
    )
    .join('');
}

function renderTicketTable() {
  const table = document.getElementById('ticketTable');
  if (!table) return;
  table.innerHTML = DEMO_DATA.tickets
    .map(
      (row) => `
        <tr>
          <td>${row.id}</td>
          <td>${row.employee}</td>
          <td>${row.category}</td>
          <td><span class="status-pill ${row.status === 'Open' ? 'warning' : row.status === 'Resolved' ? 'success' : 'neutral'}">${row.status}</span></td>
          <td>${row.updated}</td>
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
      const state = readState();
      state.notificationsHidden = true;
      saveState(state);
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
      alert(`Laptop ${laptop} assigned to ${employee}.`);
    });
  }
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
  renderBlockingTable();
  renderAssignmentTable();
  renderRequestTable();
  renderEmployeeTable();
  renderLaptopTable();
  renderTicketTable();
  setupDashboardInteractions();

  if (state.notificationsHidden) {
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
