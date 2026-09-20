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

// ==========================================
// 1. POSTGRESQL DATABASE SETUP (Password: 8760)
// ==========================================
const pool = new Pool({
  user: 'trojan',
  host: 'localhost',
  database: 'trojanconnect',
  password: '8760',
  port: 5432,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client from PostgreSQL pool:', err.stack);
  } else {
    console.log('Connected to PostgreSQL database successfully!');
    
    // Automatically create the messages table if it doesn't exist yet
    client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        message TEXT,
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, (tableErr) => {
      release();
      if (tableErr) {
        console.error('Error creating messages table:', tableErr);
      } else {
        console.log('Messages database schema verified/created.');
      }
    });
  }
});

// ==========================================
// 2. MIDDLEWARE & STATIC FILES
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 3. IMAGE UPLOADS & 2-HOUR AUTO-DELETION
// ==========================================
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

// Upload Endpoint for Pictures
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

// Background Cleanup Job: Runs every 10 minutes, deletes files older than 2 hours
setInterval(() => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    
    files.forEach(file => {
      const filePath = path.join(uploadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && stats.mtimeMs < twoHoursAgo) {
          fs.unlink(filePath, (err) => {
            if (!err) console.log(`Auto-deleted expired image to save space: ${file}`);
          });
        }
      });
    });
  });
}, 10 * 60 * 1000); // 10 minutes interval

// ==========================================
// 4. SOCKET.IO, CHAT & WEBRTC SIGNALING
// ==========================================
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send historical messages from PostgreSQL to newly connected users
  pool.query('SELECT username, message, image_url, created_at FROM messages ORDER BY created_at ASC LIMIT 50', (err, result) => {
    if (!err) {
      socket.emit('load-history', result.rows);
    }
  });

  // Handle standard chat messages & picture links
  socket.on('chat-message', (data) => {
    const { username, message, imageUrl } = data;
    
    // Save to PostgreSQL database
    pool.query(
      'INSERT INTO messages (username, message, image_url) VALUES ($1, $2, $3)',
      [username, message || '', imageUrl || null],
      (err) => {
        if (err) console.error('Error saving message to database:', err);
      }
    );

    // Broadcast message to all connected clients
    io.emit('chat-message', { username, message, imageUrl, created_at: new Date() });
  });

  // WebRTC Voice Channels & Screen Sharing Signaling
  socket.on('join-voice-channel', (roomID) => {
    socket.join(roomID);
    const otherUsers = Array.from(io.sockets.adapter.rooms.get(roomID) || []).filter(id => id !== socket.id);
    socket.emit('all-users', otherUsers);
  });

  socket.on('sending-signal', payload => {
    io.to(payload.userToSignal).emit('user-joined', {
      signal: payload.signal,
      callerID: payload.callerID
    });
  });

  socket.on('returning-signal', payload => {
    io.to(payload.callerID).emit('receiving-returned-signal', {
      signal: payload.signal,
      id: socket.id
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`Trojan Connect server running live on port ${PORT}`);
});