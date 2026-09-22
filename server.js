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

// PostgreSQL Connection (Password: 8760)
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
    
    // Initialize Database Schema (Users, Friendships, Messages)
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        status TEXT NOT NULL -- 'pending', 'accepted'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL, -- 'global' or specific username for DMs
        message TEXT,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `, (tableErr) => {
      release();
      if (tableErr) {
        console.error('Error initializing schema:', tableErr);
      } else {
        console.log('Discord-style database schema initialized successfully.');
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

// 2-Hour Automatic Cleanup Job (Runs every 10 mins)
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

// Socket.io Real-time Logic
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Registration
  socket.on('register', async ({ username, password }) => {
    try {
      if (!username || !password) {
        return socket.emit('auth-error', 'Username and password required.');
      }
      await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, password]);
      socket.emit('auth-success', { username });
    } catch (e) {
      socket.emit('auth-error', 'Username already taken or database error.');
    }
  });

  // Login
  socket.on('login', async ({ username, password }) => {
    try {
      const res = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
      if (res.rows.length > 0) {
        socket.emit('auth-success', { username });
      } else {
        socket.emit('auth-error', 'Invalid username or password.');
      }
    } catch (e) {
      socket.emit('auth-error', 'Server error during login.');
    }
  });

  // Friend Requests System
  socket.on('send-friend-request', async ({ sender, recipient }) => {
    if (sender === recipient) return;
    try {
      // Check if already friends or request pending
      const check = await pool.query(
        'SELECT * FROM friendships WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)',
        [sender, recipient]
      );
      if (check.rows.length === 0) {
        await pool.query('INSERT INTO friendships (sender, receiver, status) VALUES ($1, $2, $3)', [sender, recipient, 'pending']);
        io.emit('friend-update');
      }
    } catch (e) {}
  });

  socket.on('accept-friend-request', async ({ user, friend }) => {
    try {
      await pool.query(
        'UPDATE friendships SET status = $1 WHERE (sender = $2 AND receiver = $3) OR (sender = $3 AND receiver = $2)',
        ['accepted', user, friend]
      );
      io.emit('friend-update');
    } catch (e) {}
  });

  socket.on('get-friends-data', async ({ username }) => {
    try {
      // Get all users for discovery
      const allUsers = await pool.query('SELECT username FROM users WHERE username != $1 ORDER BY username ASC', [username]);
      // Get friendships
      const friendships = await pool.query('SELECT * FROM friendships WHERE sender = $1 OR receiver = $1', [username]);
      
      socket.emit('friends-data', {
        users: allUsers.rows.map(r => r.username),
        friendships: friendships.rows
      });
    } catch (e) {}
  });

  // Load Message History (Global or DM)
  socket.on('load-history', async ({ recipient, currentUser }) => {
    try {
      let query, params;
      if (recipient === 'global') {
        query = 'SELECT sender, recipient, message, image_url AS "imageUrl", created_at AS "createdAt" FROM messages WHERE recipient = $1 ORDER BY created_at ASC LIMIT 100';
        params = ['global'];
      } else {
        query = 'SELECT sender, recipient, message, image_url AS "imageUrl", created_at AS "createdAt" FROM messages WHERE (sender = $1 AND recipient = $2) OR (sender = $2 AND recipient = $1) ORDER BY created_at ASC LIMIT 100';
        params = [currentUser, recipient];
      }
      const res = await pool.query(query, params);
      socket.emit('history-loaded', res.rows);
    } catch (e) {}
  });

  // Chat Messages
  socket.on('chat-message', async (data) => {
    const { sender, recipient, message, imageUrl } = data;
    try {
      const result = await pool.query(
        'INSERT INTO messages (sender, recipient, message, image_url) VALUES ($1, $2, $3, $4) RETURNING sender, recipient, message, image_url AS "imageUrl", created_at AS "createdAt"',
        [sender, recipient || 'global', message || '', imageUrl || null]
      );
      io.emit('chat-message', result.rows[0]);
    } catch (err) {
      console.error('Error saving chat message:', err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Trojan Connect Discord-style server running on port ${PORT}`);
});