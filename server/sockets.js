import { WebSocketServer, WebSocket } from 'ws';
import { verifyGoogleToken } from './auth.js';
import { runQuery, getRow } from './db.js';

// Connected client storage & queue
const connectedUsers = new Map(); // userId -> { ws, user, currentRoom, isAdminMode }
const waitingQueue = [];          // Array of userIds waiting for pairs
const activeRooms = new Map();    // roomId -> { user1Id, user2Id, history: [] }

export function initSockets(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    let currentUser = null;

    ws.on('message', async (data) => {
      try {
        const payload = JSON.parse(data.toString());

        // 1. Initial Handshake / Auth
        if (payload.type === 'AUTH') {
          const user = await verifyGoogleToken(payload.token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed.' }));
            return ws.close();
          }

          if (user.is_banned) {
            ws.send(JSON.stringify({ type: 'BANNED', message: user.ban_reason || 'Account suspended.' }));
            return ws.close();
          }

          currentUser = user;
          connectedUsers.set(user.id, {
            ws,
            user,
            currentRoom: null,
            isAdminMode: user.role === 'admin' && Boolean(payload.adminMode),
          });

          ws.send(JSON.stringify({
            type: 'AUTH_SUCCESS',
            user: {
              id: user.id,
              nickname: user.nickname,
              role: user.role,
              isAdminMode: user.role === 'admin' && Boolean(payload.adminMode),
            },
          }));
          return;
        }

        if (!currentUser) return; // Disallow unauthenticated messages

        // 2. Queue for 1-on-1 Match
        if (payload.type === 'START_SEARCH') {
          leaveCurrentRoom(currentUser.id);
          removeFromQueue(currentUser.id);

          const session = connectedUsers.get(currentUser.id);
          if (session) {
            session.isAdminMode = currentUser.role === 'admin' && Boolean(payload.adminMode);
          }

          // Matchmaking logic (FIFO)
          if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            createRoom(currentUser.id, partnerId);
          } else {
            waitingQueue.push(currentUser.id);
            ws.send(JSON.stringify({ type: 'QUEUE_WAITING' }));
          }
        }

        // 3. Skip / Next Partner
        if (payload.type === 'SKIP') {
          leaveCurrentRoom(currentUser.id);
          ws.send(JSON.stringify({ type: 'ROOM_LEFT' }));
        }

        // 4. Send Message
        if (payload.type === 'CHAT_MESSAGE') {
          const session = connectedUsers.get(currentUser.id);
          if (!session || !session.currentRoom) return;

          const room = activeRooms.get(session.currentRoom);
          if (!room) return;

          const text = (payload.text || '').trim();
          if (!text || text.length > 500) return;

          const isSenderAdmin = currentUser.role === 'admin' && session.isAdminMode;
          const msgObj = {
            id: Date.now().toString(),
            senderRole: isSenderAdmin ? 'admin' : 'user',
            senderName: currentUser.nickname,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };

          // Cache last 10 messages for contextual moderation
          room.history.push({ senderId: currentUser.id, ...msgObj });
          if (room.history.length > 10) room.history.shift();

          const partnerId = room.user1Id === currentUser.id ? room.user2Id : room.user1Id;
          const partnerSession = connectedUsers.get(partnerId);

          // Echo to sender & deliver to partner
          ws.send(JSON.stringify({ type: 'MESSAGE_SENT', message: msgObj, self: true }));
          if (partnerSession && partnerSession.ws.readyState === WebSocket.OPEN) {
            partnerSession.ws.send(JSON.stringify({ type: 'MESSAGE_RECEIVED', message: msgObj, self: false }));
          }
        }

        // 5. Typing Indicators
        if (payload.type === 'TYPING') {
          const session = connectedUsers.get(currentUser.id);
          if (session && session.currentRoom) {
            const room = activeRooms.get(session.currentRoom);
            if (room) {
              const partnerId = room.user1Id === currentUser.id ? room.user2Id : room.user1Id;
              const partner = connectedUsers.get(partnerId);
              if (partner && partner.ws.readyState === WebSocket.OPEN) {
                partner.ws.send(JSON.stringify({ type: 'PARTNER_TYPING', isTyping: Boolean(payload.isTyping) }));
              }
            }
          }
        }

        // 6. Report Partner
        if (payload.type === 'REPORT_PARTNER') {
          const session = connectedUsers.get(currentUser.id);
          if (session && session.currentRoom) {
            const room = activeRooms.get(session.currentRoom);
            if (room) {
              const partnerId = room.user1Id === currentUser.id ? room.user2Id : room.user1Id;
              const historySnapshot = JSON.stringify(room.history);

              await runQuery(
                'INSERT INTO reports (reporter_id, reported_id, reason, context_json) VALUES (?, ?, ?, ?)',
                [currentUser.id, partnerId, payload.reason || 'General Misbehavior', historySnapshot]
              );

              leaveCurrentRoom(currentUser.id);
              ws.send(JSON.stringify({ type: 'REPORT_SUBMITTED' }));
            }
          }
        }

        // 7. In-Chat Admin Special Actions (Instant Warn / Kick)
        if (payload.type === 'ADMIN_ACTION' && currentUser.role === 'admin') {
          const session = connectedUsers.get(currentUser.id);
          if (session && session.currentRoom) {
            const room = activeRooms.get(session.currentRoom);
            if (room) {
              const targetId = room.user1Id === currentUser.id ? room.user2Id : room.user1Id;
              const target = connectedUsers.get(targetId);

              if (target && target.ws.readyState === WebSocket.OPEN) {
                if (payload.action === 'WARN') {
                  target.ws.send(JSON.stringify({
                    type: 'SYSTEM_WARNING',
                    message: '⚠️ Official Admin Warning: Please keep interactions civil and follow guidelines.',
                  }));
                } else if (payload.action === 'KICK') {
                  disconnectUserSession(targetId, 'You were removed from this room by the administrator.');
                }
              }
            }
          }
        }

        // 8. Nickname Change
        if (payload.type === 'UPDATE_NICKNAME') {
          const cleanedName = (payload.nickname || '').trim().replace(/[^a-zA-Z0-9_\-\s]/g, '');
          const lower = cleanedName.toLowerCase();
          const reserved = ['admin', 'staff', 'mod', 'system', 'root'];

          if (cleanedName.length < 3 || cleanedName.length > 20 || reserved.some(r => lower.includes(r))) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid or reserved nickname.' }));
            return;
          }

          await runQuery('UPDATE users SET nickname = ? WHERE id = ?', [cleanedName, currentUser.id]);
          currentUser.nickname = cleanedName;
          ws.send(JSON.stringify({ type: 'NICKNAME_UPDATED', nickname: cleanedName }));
        }

      } catch (err) {
        console.error('Socket message processing error:', err);
      }
    });

    ws.on('close', () => {
      if (currentUser) {
        removeFromQueue(currentUser.id);
        leaveCurrentRoom(currentUser.id);
        connectedUsers.delete(currentUser.id);
      }
    });
  });
}

function createRoom(u1Id, u2Id) {
  const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  activeRooms.set(roomId, { user1Id: u1Id, user2Id: u2Id, history: [] });

  const u1 = connectedUsers.get(u1Id);
  const u2 = connectedUsers.get(u2Id);

  if (!u1 || !u2) return;

  u1.currentRoom = roomId;
  u2.currentRoom = roomId;

  // Inform u1 about u2
  u1.ws.send(JSON.stringify({
    type: 'ROOM_JOINED',
    partner: {
      name: u2.user.nickname,
      role: (u2.user.role === 'admin' && u2.isAdminMode) ? 'admin' : 'user',
    },
  }));

  // Inform u2 about u1
  u2.ws.send(JSON.stringify({
    type: 'ROOM_JOINED',
    partner: {
      name: u1.user.nickname,
      role: (u1.user.role === 'admin' && u1.isAdminMode) ? 'admin' : 'user',
    },
  }));
}

function leaveCurrentRoom(userId) {
  const session = connectedUsers.get(userId);
  if (!session || !session.currentRoom) return;

  const roomId = session.currentRoom;
  const room = activeRooms.get(roomId);
  session.currentRoom = null;

  if (room) {
    const partnerId = room.user1Id === userId ? room.user2Id : room.user1Id;
    const partner = connectedUsers.get(partnerId);

    if (partner) {
      partner.currentRoom = null;
      if (partner.ws.readyState === WebSocket.OPEN) {
        partner.ws.send(JSON.stringify({ type: 'PARTNER_DISCONNECTED' }));
      }
    }
    activeRooms.delete(roomId);
  }
}

function removeFromQueue(userId) {
  const index = waitingQueue.indexOf(userId);
  if (index !== -1) waitingQueue.splice(index, 1);
}

export function disconnectUserSession(userId, message) {
  const session = connectedUsers.get(userId);
  if (session) {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'FORCE_DISCONNECT', message }));
      session.ws.close();
    }
    leaveCurrentRoom(userId);
    removeFromQueue(userId);
    connectedUsers.delete(userId);
  }
}
