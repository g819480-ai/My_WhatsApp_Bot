
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const settingKeys = [
  ['alwaysOnline', 'Always Online'],
  ['autoViewStatus', 'Auto View Status'],
  ['statusReact', 'Status Reactions'],
  ['welcome', 'Welcome Message'],
  ['goodbye', 'Goodbye Message'],
  ['autoReact', 'Auto React'],
  ['aiReplies', 'AI Replies']
];

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || 'Request failed');
  }

  return data;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.textContent = '';
  }, 3000);
}

function escapeHTML(value) {
  return String(value ?? '—').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function showPage(name) {
  $$('[data-panel]').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.panel !== name);
  });

  $$('.nav').forEach(button => {
    button.classList.toggle('active', button.dataset.page === name);
  });

  const titles = {
    overview: 'Overview',
    users: 'User Management',
    sessions: 'Session Management',
    settings: 'Bot Settings',
    logs: 'Activity Logs'
  };

  $('#pageTitle').textContent = titles[name];

  const loaders = {
    overview: loadOverview,
    users: loadUsers,
    sessions: loadSessions,
    settings: loadSettings,
    logs: loadLogs
  };

  loaders[name]?.();
}

$$('.nav').forEach(button => {
  button.addEventListener('click', () => showPage(button.dataset.page));
});

$$('[data-jump]').forEach(button => {
  button.addEventListener('click', () => showPage(button.dataset.jump));
});

async function loadOverview() {
  try {
    const data = await api('/api/admin/overview');

    $('#totalUsers').textContent = data.totalUsers;
    $('#totalSessions').textContent = data.totalSessions;
    $('#connected').textContent = data.connected;
    $('#offline').textContent = data.offline;
  } catch (error) {
    toast(error.message);
  }
}

async function loadUsers() {
  try {
    const data = await api('/api/admin/users');

    $('#usersRows').innerHTML = data.users.map(user => `
      <tr>
        <td>${escapeHTML(user.phone || 'Not linked')}</td>
        <td>${escapeHTML(user.sessionId)}</td>
        <td>${user.sessionRemoved ? 'Session removed' : 'Registered'}</td>
        <td>${formatDate(user.updatedAt)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4">No users found.</td></tr>';
  } catch (error) {
    toast(error.message);
  }
}

async function loadSessions() {
  try {
    const data = await api('/api/admin/sessions');

    $('#sessionRows').innerHTML = data.sessions.map(session => `
      <tr>
        <td>${escapeHTML(session.phone)}</td>
        <td>${escapeHTML(session.sessionId)}</td>
        <td>${escapeHTML(session.status)}</td>
        <td class="actions">
          <button data-disconnect="${escapeHTML(session.sessionId)}">
            Disconnect
          </button>
          <button class="danger" data-remove="${escapeHTML(session.sessionId)}">
            Remove
          </button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="4">No sessions found.</td></tr>';

    $$('[data-disconnect]').forEach(button => {
      button.onclick = () => disconnectSession(button.dataset.disconnect);
    });

    $$('[data-remove]').forEach(button => {
      button.onclick = () => removeSession(button.dataset.remove);
    });
  } catch (error) {
    toast(error.message);
  }
}

async function disconnectSession(sessionId) {
  if (!confirm('Disconnect this account? Saved credentials will be preserved.')) {
    return;
  }

  try {
    await api(
      `/api/admin/sessions/${encodeURIComponent(sessionId)}/disconnect`,
      { method: 'POST' }
    );

    toast('Session disconnected.');
    loadSessions();
  } catch (error) {
    toast(error.message);
  }
}

async function removeSession(sessionId) {
  if (!confirm('Permanently delete this session and its saved WhatsApp credentials?')) {
    return;
  }

  try {
    await api(
      `/api/admin/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    );

    toast('Session removed.');
    loadSessions();
    loadOverview();
  } catch (error) {
    toast(error.message);
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/admin/settings');
    const settings = data.settings;

    $('#settingsGrid').innerHTML = settingKeys.map(([key, label]) => `
      <label class="setting">
        ${label}
        <input type="checkbox"
          data-setting="${key}"
          ${settings[key] ? 'checked' : ''}>
      </label>
    `).join('');

    $('#emoji').value = settings.statusReactEmoji || '❤️';
  } catch (error) {
    toast(error.message);
  }
}

$('#saveSettings').onclick = async () => {
  const body = {};

  $$('[data-setting]').forEach(input => {
    body[input.dataset.setting] = input.checked;
  });

  body.statusReactEmoji = $('#emoji').value;

  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(body)
    });

    toast('Settings saved.');
  } catch (error) {
    toast(error.message);
  }
};

async function loadLogs() {
  try {
    const data = await api('/api/admin/logs');

    $('#logRows').innerHTML = data.logs.map(log => `
      <article class="log">
        <time>${formatDate(log.createdAt)} · ${escapeHTML(log.level || 'info')}</time>
        ${escapeHTML(log.message)}
      </article>
    `).join('') || '<p>No activity recorded.</p>';
  } catch (error) {
    toast(error.message);
  }
}

$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  $('#loginError').textContent = '';

  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        password: $('#password').value
      })
    });

    $('#password').value = '';
    enterDashboard();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
};

function enterDashboard() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  showPage('overview');
}

$('#logout').onclick = async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {}

  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
};

$('#refreshUsers').onclick = loadUsers;
$('#refreshSessions').onclick = loadSessions;
$('#refreshLogs').onclick = loadLogs;

(async () => {
  try {
    const data = await api('/api/admin/me');
    if (data.ok) enterDashboard();
  } catch {}
})();
