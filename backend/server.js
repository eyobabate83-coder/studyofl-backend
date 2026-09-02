// server.js
const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ override: true });
const pool = require('./db');

const PORT = process.env.PORT || 4000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/' && req.method === 'GET') {
    try {
      const dbResult = await pool.query('SELECT NOW()');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        message: 'Studyo backend is running!',
        dbTime: dbResult.rows[0].now
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database query failed', details: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Route not found' }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set a different PORT in .env.`);
    process.exitCode = 1;
    return;
  }

  console.error('Server failed to start:', err.message);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});