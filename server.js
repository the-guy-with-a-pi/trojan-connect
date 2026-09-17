const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
const users = {}; 
const activeUsers = {};
const messageHistory = {}; // roomName -> [array of message objects]

io.on('connection', (socket) => {
    console.log(`[TCP] User connected: ${socket.id}`);

    socket.on('auth_user', ({ username, password, type }, callback) => {
        if (!username || !password) {
            return callback({ success: false, message: 'Please fill in all fields.' });
        }

        if (type === 'signup') {
            if (users[username]) {
                return callback({ success: false, message: 'Username already taken.' });
            }
            users[username] = { password, friends: [], requests: [] };
            callback({ success: true, username });
        } else {
            if (!users[username]) {
                return callback({ success: false, message: 'Account not found. Please Sign Up first!' });
            }
            if (users[username].password !== password) {
                return callback({ success: false, message: 'Invalid password.' });
            }
            callback({ success: true, username });
        }
    });

    socket.on('register_session', (username) => {
        if (username) {
            activeUsers[username] = socket.id;
            socket.join(`user_${username}`);
        }
    });

    socket.on('search_users', ({ query, currentUser }, callback) => {
        if (!query) return callback([]);
        const matches = Object.keys(users).filter(username => 
            username.toLowerCase().includes(query.toLowerCase()) && 
            username !== currentUser &&
            !users[currentUser].friends.includes(username)
        );
        callback(matches);
    });

    socket.on('send_friend_request', ({ from, to }, callback) => {
        if (!users[to]) return callback({ success: false, message: 'User not found.' });
        if (users[to].requests.includes(from)) return callback({ success: false, message: 'Request already sent.' });
        if (users[to].friends.includes(from)) return callback({ success: false, message: 'Already friends.' });

        users[to].requests.push(from);
        
        if (activeUsers[to]) {
            io.to(activeUsers[to]).emit('friend_request_received', { from });
        }

        callback({ success: true, message: 'Friend request sent!' });
    });

    socket.on('accept_friend_request', ({ currentUser, requester }, callback) => {
        if (!users[currentUser] || !users[requester]) return callback({ success: false });

        users[currentUser].requests = users[currentUser].requests.filter(r => r !== requester);

        if (!users[currentUser].friends.includes(requester)) users[currentUser].friends.push(requester);
        if (users[requester] && !users[requester].friends.includes(currentUser)) users[requester].friends.push(currentUser);

        callback({ 
            success: true, 
            friends: users[currentUser].friends,
            requesterFriends: users[requester].friends 
        });
    });

    socket.on('get_user_data', (username, callback) => {
        if (!users[username]) return callback({ friends: [], requests: [] });
        callback({
            friends: users[username].friends,
            requests: users[username].requests
        });
    });

    socket.on('join_room', (room, callback) => {
        socket.join(room);
        // Send back past message history for this room so it loads correctly
        if (callback) {
            callback(messageHistory[room] || []);
        }
    });

    socket.on('send_message', (data) => {
        const room = data.isDM ? [data.username, data.recipient].sort().join('_') : data.room;
        const messageObj = {
            username: data.username,
            message: data.message,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            isDM: data.isDM,
            recipient: data.recipient,
            room: room
        };

        if (!messageHistory[room]) {
            messageHistory[room] = [];
        }
        messageHistory[room].push(messageObj);

        if (data.isDM && data.recipient) {
            io.to(`user_${data.recipient}`).emit('receive_message', messageObj);
            io.to(`user_${data.username}`).emit('receive_message', messageObj);
        } else {
            io.to(room).emit('receive_message', messageObj);
        }
    });

    socket.on('disconnect', () => {
        for (const [user, sid] of Object.entries(activeUsers)) {
            if (sid === socket.id) {
                delete activeUsers[user];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[TCP] Trojan Connect server running locally on port ${PORT}`);
});