import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { initSockets } from './sockets.js';
import adminRoutes from './adminRoutes.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Admin APIs
app.use('/api/admin', adminRoutes);

// Health check / Config exposed to client
app.get('/api/config', (req, res) => {
  res.json({
    clientId: process.env.GOOGLE_CLIENT_ID || '',
  });
});

// Initialize WebSocket layer
initSockets(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SugboChat active and listening on port http://localhost:${PORT}`);
});
