const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

// State management
let onlineUsers = 0;
let waitingQueue = []; // Array of socket IDs waiting for a stranger
const activePairs = new Map(); // socketId -> { partnerId, roomId }

// Broadcast current online count to everyone
function broadcastOnlineCount() {
  io.emit('online_count', onlineUsers);
}

io.on('connection', (socket) => {
  onlineUsers++;
  broadcastOnlineCount();

  // Helper: Safely leave queue without triggering unpair events
  const leaveQueue = () => {
    waitingQueue = waitingQueue.filter((id) => id !== socket.id);
  };

  // Helper: Clean up active chat session cleanly
  const endSession = (reason = 'disconnected') => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      const { partnerId } = pair;
      activePairs.delete(socket.id);
      activePairs.delete(partnerId);

      // Notify partner that session ended
      io.to(partnerId).emit('partner_left', { reason });
    }
  };

  // 1. Matchmaking request
  socket.on('find_partner', (userData) => {
    // Prevent double queueing or queueing while already in a pair
    leaveQueue();
    endSession('skipped');

    socket.userData = userData || { nickname: 'Anonymous' };

    // Find first valid waiting socket who isn't this user
    while (waitingQueue.length > 0) {
      const candidateId = waitingQueue.shift();
      const partnerSocket = io.sockets.sockets.get(candidateId);

      // Verify the candidate is still connected and not self
      if (partnerSocket && candidateId !== socket.id) {
        const roomId = `room_${socket.id}_${candidateId}`;

        socket.join(roomId);
        partnerSocket.join(roomId);

        activePairs.set(socket.id, { partnerId: candidateId, roomId });
        activePairs.set(candidateId, { partnerId: socket.id, roomId });

        // Notify both users with full success payload
        socket.emit('match_found', {
          roomId,
          partner: partnerSocket.userData || { nickname: 'Sugboanon' }
        });

        partnerSocket.emit('match_found', {
          roomId,
          partner: socket.userData || { nickname: 'Sugboanon' }
        });
        return;
      }
    }

    // No valid candidate found -> join waiting queue
    waitingQueue.push(socket.id);
    socket.emit('waiting_for_partner');
  });

  // 2. Chat messages between paired strangers
  socket.on('send_message', (data) => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      // Send directly to the partner's socket
      io.to(pair.partnerId).emit('receive_message', {
        id: Date.now(),
        text: data.text,
        sender: 'partner',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
  });

  // 3. Manual skip / next button
  socket.on('skip_partner', () => {
    endSession('skipped');
    socket.emit('partner_left', { reason: 'you_skipped' });
  });

  // 4. Disconnect cleanup
  socket.on('disconnect', () => {
    onlineUsers = Math.max(0, onlineUsers - 1);
    broadcastOnlineCount();
    leaveQueue();
    endSession('disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`SugboChat listening on port ${PORT}`);
});
