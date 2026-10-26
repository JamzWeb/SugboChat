let authToken = null;
let currentUser = null;
let socket = null;
let typingTimeout = null;

// UI View Elements
const views = {
  auth: document.getElementById('auth-screen'),
  lobby: document.getElementById('lobby-screen'),
  chat: document.getElementById('chat-screen'),
};

const chatWindow = document.getElementById('chat-window');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-msg-btn');
const partnerNicknameEl = document.getElementById('partner-nickname');
const partnerRoleTagEl = document.getElementById('partner-role-tag');
const typingIndicator = document.getElementById('typing-indicator');
const inChatAdminBar = document.getElementById('in-chat-admin-bar');

// 1. Initial Configuration & Google Sign-In Setup
async function initApp() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();

    if (window.google && config.clientId) {
      window.google.accounts.id.initialize({
        client_id: config.clientId,
        callback: handleGoogleAuthResponse,
      });

      window.google.accounts.id.renderButton(
        document.getElementById('google-btn-container'),
        { theme: 'filled_black', size: 'large', shape: 'pill', width: 280 }
      );
    }
  } catch (err) {
    console.error('Initialization error:', err);
  }
}

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[name].classList.add('active');
}

// 2. Google OAuth Callback
function handleGoogleAuthResponse(response) {
  authToken = response.credential;
  connectWebSocket();
}

// 3. WebSocket Setup & Event Handling
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.onopen = () => {
    // Send Auth Handshake
    socket.send(JSON.stringify({
      type: 'AUTH',
      token: authToken,
      adminMode: document.getElementById('admin-mode-toggle')?.checked || false
    }));
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'AUTH_SUCCESS') {
      currentUser = data.user;
      setupLobbyUI();
      showView('lobby');
    }

    if (data.type === 'BANNED' || data.type === 'FORCE_DISCONNECT') {
      alert(`Account Notice: ${data.message}`);
      window.location.reload();
    }

    if (data.type === 'QUEUE_WAITING') {
      showView('chat');
      partnerNicknameEl.textContent = 'Searching for a partner...';
      partnerRoleTagEl.classList.add('hidden');
      chatInput.disabled = true;
      sendBtn.disabled = true;
      appendSystemMessage('Waiting in queue. Pairing you with another Sugbuanon...');
    }

    if (data.type === 'ROOM_JOINED') {
      chatWindow.innerHTML = '';
      partnerNicknameEl.textContent = data.partner.name;
      chatInput.disabled = false;
      sendBtn.disabled = false;
      chatInput.focus();

      if (data.partner.role === 'admin') {
        partnerRoleTagEl.textContent = '👑 Admin';
        partnerRoleTagEl.className = 'partner-badge admin-crown';
        partnerRoleTagEl.classList.remove('hidden');
        appendSystemMessage('👑 You have paired with an official SugboChat Administrator.');
      } else {
        partnerRoleTagEl.classList.add('hidden');
        appendSystemMessage(`Connected to ${data.partner.name}. Say hello!`);
      }

      // Display in-chat tools if the active user is operating as admin
      if (currentUser.role === 'admin' && currentUser.isAdminMode) {
        inChatAdminBar.classList.remove('hidden');
      } else {
        inChatAdminBar.classList.add('hidden');
      }
    }

    if (data.type === 'MESSAGE_SENT' || data.type === 'MESSAGE_RECEIVED') {
      appendChatMessage(data.message, data.self);
    }

    if (data.type === 'PARTNER_TYPING') {
      if (data.isTyping) typingIndicator.classList.remove('hidden');
      else typingIndicator.classList.add('hidden');
    }

    if (data.type === 'PARTNER_DISCONNECTED') {
      appendSystemMessage('Partner disconnected or skipped.');
      chatInput.disabled = true;
      sendBtn.disabled = true;
    }

    if (data.type === 'SYSTEM_WARNING') {
      alert(data.message);
      appendSystemMessage(data.message);
    }
  };
}

// 4. Lobby UI Updates
function setupLobbyUI() {
  document.getElementById('nickname-input').value = currentUser.nickname;
  const roleBadge = document.getElementById('role-badge');
  roleBadge.textContent = currentUser.role.toUpperCase();

  if (currentUser.role === 'admin') {
    roleBadge.style.background = 'var(--accent-gold)';
    roleBadge.style.color = '#000';
    document.getElementById('admin-toggle-wrapper').classList.remove('hidden');
  }
}

// 5. Chat Interaction Handlers
document.getElementById('start-search-btn').addEventListener('click', () => {
  const adminModeActive = document.getElementById('admin-mode-toggle').checked;
  currentUser.isAdminMode = adminModeActive;
  socket.send(JSON.stringify({ type: 'START_SEARCH', adminMode: adminModeActive }));
});

document.getElementById('skip-btn').addEventListener('click', () => {
  socket.send(JSON.stringify({ type: 'SKIP' }));
  const adminModeActive = document.getElementById('admin-mode-toggle').checked;
  socket.send(JSON.stringify({ type: 'START_SEARCH', adminMode: adminModeActive }));
});

document.getElementById('save-nickname-btn').addEventListener('click', () => {
  const newName = document.getElementById('nickname-input').value.trim();
  if (newName) socket.send(JSON.stringify({ type: 'UPDATE_NICKNAME', nickname: newName }));
});

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.send(JSON.stringify({ type: 'CHAT_MESSAGE', text }));
  chatInput.value = '';
  socket.send(JSON.stringify({ type: 'TYPING', isTyping: false }));
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
  else {
    socket.send(JSON.stringify({ type: 'TYPING', isTyping: true }));
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.send(JSON.stringify({ type: 'TYPING', isTyping: false }));
    }, 1200);
  }
});

// 6. In-Chat Admin Controls
document.getElementById('btn-admin-warn').addEventListener('click', () => {
  socket.send(JSON.stringify({ type: 'ADMIN_ACTION', action: 'WARN' }));
});

document.getElementById('btn-admin-kick').addEventListener('click', () => {
  if (confirm('Kick this partner from the platform?')) {
    socket.send(JSON.stringify({ type: 'ADMIN_ACTION', action: 'KICK' }));
  }
});

// 7. Reporting Flow
document.getElementById('report-btn').addEventListener('click', () => {
  const reason = prompt('Please specify the violation (Harassment, Inappropriate Language, Spam):');
  if (reason) {
    socket.send(JSON.stringify({ type: 'REPORT_PARTNER', reason }));
    alert('Report submitted. Finding a new partner...');
    const adminModeActive = document.getElementById('admin-mode-toggle').checked;
    socket.send(JSON.stringify({ type: 'START_SEARCH', adminMode: adminModeActive }));
  }
});

// 8. DOM Message Appenders
function appendChatMessage(msg, isSelf) {
  const bubble = document.createElement('div');
  const isAdminMsg = msg.senderRole === 'admin';

  let bubbleClass = `bubble ${isSelf ? 'self' : 'peer'}`;
  if (isAdminMsg) bubbleClass += isSelf ? ' admin-self' : ' admin-peer';

  bubble.className = bubbleClass;
  bubble.innerHTML = `
    ${isAdminMsg ? `<div class="bubble-sender">👑 ${msg.senderName} (Admin)</div>` : ''}
    <div>${escapeHtml(msg.text)}</div>
    <div class="bubble-time">${msg.timestamp}</div>
  `;

  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function appendSystemMessage(text) {
  const bubble = document.createElement('div');
  bubble.className = 'system-bubble';
  bubble.textContent = text;
  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 9. Admin Panel Modal & Fetch Logic
const adminModal = document.getElementById('admin-modal');
document.getElementById('open-admin-panel-btn').addEventListener('click', async () => {
  adminModal.classList.remove('hidden');
  const res = await fetch('/api/admin/reports', {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  const reports = await res.json();
  const tbody = document.getElementById('reports-table-body');
  tbody.innerHTML = '';

  reports.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
      <td><strong>${r.reported_name}</strong><br><small>${r.reported_email}</small></td>
      <td>${r.reason}</td>
      <td><pre style="font-size:0.7rem; max-width:200px; overflow:hidden;">${escapeHtml(r.context_json || 'No logs')}</pre></td>
      <td>
        ${r.is_banned ? '<span style="color:red">Banned</span>' : `<button onclick="banUser('${r.reported_id}')" class="btn danger btn-xs">Ban</button>`}
      </td>
    `;
    tbody.appendChild(tr);
  });
});

document.getElementById('close-admin-modal-btn').addEventListener('click', () => {
  adminModal.classList.add('hidden');
});

window.banUser = async function(userId) {
  if (!confirm('Permanently ban this user?')) return;
  await fetch('/api/admin/ban', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ userId, reason: 'Reported abuse violation' })
  });
  alert('Account banned.');
  document.getElementById('open-admin-panel-btn').click(); // Refresh table
};

window.onload = initApp;
