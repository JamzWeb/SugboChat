// Connect socket (Render auto-detects current host)
const socket = io();

// 1. Online Real-Time Counter
const onlineBadge = document.getElementById('online-count-badge');

socket.on('online_count', (count) => {
  if (onlineBadge) {
    onlineBadge.innerText = `${count} Online Sugboanons`;
  }
});

// 2. Matchmaking State Listeners
socket.on('waiting_for_partner', () => {
  updateStatusUI('Nangita pa og ka-istorya... (Searching for someone)');
});

socket.on('match_found', (data) => {
  // Clear any previous chat log
  clearChatBox();
  updateStatusUI(`Connected to: ${data.partner.nickname || 'Anonymous'}`);
  enableChatInput(true);
});

socket.on('partner_left', (data) => {
  enableChatInput(false);
  if (data.reason === 'you_skipped') {
    updateStatusUI('You skipped the conversation. Tap Find to match again.');
  } else {
    updateStatusUI('Ka-istorya skipped or disconnected. Tap Find to match again.');
  }
});

// 3. User Actions
function startMatch() {
  socket.emit('find_partner', {
    nickname: currentNickname || 'SugboUser'
  });
}

function skipPartner() {
  socket.emit('skip_partner');
}

function sendMessage(text) {
  if (!text.trim()) return;
  socket.emit('send_message', { text });
  appendMyMessage(text);
}
