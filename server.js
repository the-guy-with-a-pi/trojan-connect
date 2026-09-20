const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Database Connection (Password: 8760)
const pool = new Pool({
  user: 'trojan',
  host: 'localhost',
  database: 'trojanconnect',
  password: '8760',
  port: 5432,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Database connection error:', err.stack);
  } else {
    console.log('Connected to PostgreSQL database!');
    
    // Create Users table and Messages table with DM support
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT DEFAULT 'global',
        message TEXT,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `, (tableErr) => {
      release();
      if (tableErr) {
        console.error('Error creating schema:', tableErr);
      } else {
        console.log('Database tables verified/initialized.');
      }
    });
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Image Uploads & 2-Hour Auto-Deletion
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});
const upload = multer({ storage: storage });

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// Cleanup job every 10 minutes for files older than 2 hours
setInterval(() => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    files.forEach(file => {
      const filePath = path.join(uploadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && stats.mtimeMs < twoHoursAgo) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 10 * 60 * 1000);

// Socket.io Authentication & Real-time Chat
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle User Registration
  socket.on('register', async ({ username, password }) => {
    try {
      const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      if (result.rows.length > 0) {
        socket.emit('auth-error', 'Username already taken.');
      } else {
        await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
        socket.emit('auth-success', { username });
      }
    } catch (e) {
      socket.emit('auth-error', 'Server error during registration.');
    }
  });

  // Handle User Login
  socket.on('login', async ({ username, password }) => {
    try {
      const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
      if (result.rows.length > 0) {
        socket.emit('auth-success', { username });
      } else {
        socket.emit('auth-error', 'Invalid username or password.');
      }
    } catch (e) {
      socket.emit('auth-error', 'Server error during login.');
    }
  });

  // Fetch online users list
  socket.on('get-users', async () => {
    try {
      const result = await pool.query('SELECT username FROM users ORDER BY username ASC');
      socket.emit('users-list', result.rows.map(r => r.username));
    } catch (e) {}
  });

  // Load chat history (Global or Direct Messages)
  socket.on('load-history', async ({ user, recipient }) => {
    try {
      let query, params;
      if (recipient === 'global') {
        query = 'SELECT sender, recipient, message, image_url, created_at FROM messages WHERE recipient = $1 ORDER BY created_at ASC LIMIT 50';
        params = ['global'];
      } else {
        query = 'SELECT sender, recipient, message, image_url, created_at FROM messages WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1) ORDER BY created_at ASC LIMIT 50';
        params = [user, recipient];
      }
      const result = await pool.query(query, params);
      socket.emit('history-loaded', result.rows);
    } catch (e) {}
  });

  // Handle Chat Messages & DMs
  socket.on('chat-message', (data) => {
    const { sender, recipient, message, imageUrl } = data;
    
    pool.query(
      'INSERT INTO messages (sender, recipient, message, image_url) VALUES ($1, $2, $3, $4)',
      [sender, recipient || 'global', message || '', imageUrl || null],
      (err) => { if (err) console.error(err); }
    );

    io.emit('chat-message', data);
  });
});

server.listen(PORT, () => {
  console.log(`Trojan Connect server running on port ${PORT}`);
});