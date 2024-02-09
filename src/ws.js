import { Server as WebSocketServer } from 'ws';
import http from 'http';

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', function connection(ws) {
ws.on('message', function incoming(message) {
    console.log('received: %s', message);
    // Echo the message to all connected clients
    wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(message);
    }
    });
});
});

server.listen(process.env.PORT || 3000, () => {
console.log(`Server started on port ${server.address().port}`);
});
