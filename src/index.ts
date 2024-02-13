import express, { Request, Response } from 'express';
import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { body, validationResult } from 'express-validator';
import { config } from 'dotenv';
import bodyParser from 'body-parser';

// Initialize dotenv
if (process.env.NODE_ENV !== 'production') {
  config();
}

export const app = express();
const server = http.createServer(app);

const allowedOrigins = ['https://elixir-ai.vercel.app', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // if your frontend needs to send cookies or credentials with requests
}));

app.use(express.json());
app.use(express.raw({ type: 'application/vnd.custom-type' }));
app.use(express.text({ type: 'text/html' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Healthcheck endpoint
app.get('/', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const api = express.Router();

const wss = new WebSocketServer({ server: server, path: "/ws" });
wss.on('connection', ws => {
  console.log('WebSocket connection established');
  ws.on('message', async rawData => {
    // Convert rawData to string if it's not already a string
    const message = rawData.toString();

    console.log('Received message:', message);

    try {
      const parsedMessage = JSON.parse(message);

      // Insert the message into Supabase
      const { error } = await supabase
        .from('messages')
        .insert([
          {
            chat_id: parsedMessage.chat_id,
            author_id: parsedMessage.author_id,
            content: parsedMessage.content,
          },
        ]);

      if (error) {
        throw new Error(`Failed to insert message into Supabase: ${error.message}`);
      }

      // Broadcast message to all connected clients
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ error: 'Failed to process message' }));
    }
  });
});

api.get('/hello', (req, res) => {
  res.status(200).send({ message: 'hello world' });
});

api.get('/fetch-chat-history/:chatId', async (req: Request, res: Response) => {
  const { chatId } = req.params;

  if (!chatId) {
    return res.status(400).json({ message: 'Chat ID is required' });
  }

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*') // Consider selecting only necessary fields if optimization is needed
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
      // .range(0, 99); // Example of pagination limit for the first 100 messages

    if (error) {
      throw new Error(`Failed to fetch chat history: ${error.message}`);
    }

    res.json(data); // Directly aligns with frontend expectation
  } catch (error) {
    const message = (error as { message: string }).message || 'Error fetching chat history.';
    res.status(500).json({ message });
  }
});

api.get('/fetch-coaches', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name')
      .eq('role', 'coach');

    if (error) throw new Error(`Failed to fetch coaches: ${error.message}`);
    res.json(data);
  } catch (error) {
    const message = (error as { message: string }).message || 'Error fetching coaches.';
    res.status(500).json({ message });
  }
});

api.post('/create-coach-selection', async (req, res) => {
  const { userId, coachId } = req.body;

  try {
    const { error } = await supabase
      .from('user_coach_relationships')
      .insert([{ user_id: userId, coach_id: coachId }]);

    if (error) throw new Error(`Failed to create coach-user relationship: ${error.message}`);
    res.json({ success: true });
  } catch (error) {
    const message = (error as { message: string }).message || 'Error creating coach selection.';
    res.status(500).json({ message });
  }
});


api.get('/fetch-corresponding-user', async (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  const role = req.query.role as string;

  if (!userId || !role) {
    return res.status(400).json({ message: 'UserId and UserRole are required' });
  }

  try {
    let query;
    if (role === 'coach') {
      query = supabase
        .from('user_coach_relationships')
        .select('user_id')
        .eq('coach_id', userId);
    } else {
      query = supabase
        .from('user_coach_relationships')
        .select('coach_id')
        .eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) {
      throw error; // Pass the error object to the catch block
    }

    res.json(data); // Send data as JSON response
  } catch (error) {
    // Type assertion to tell TypeScript that we expect error to have a message property
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message }); // Send error message as JSON response
  }
});

// Endpoint for creating a new chat doesn't require body validation as it creates a blank chat
api.post('/create-chat', async (req: Request, res: Response) => {
  try {
    const newChatId = crypto.randomUUID();
    const { error } = await supabase.from('chats').insert([{ id: newChatId }]);
    
    if (error) throw new Error('Failed to create chat');
    
    res.json({ newChatId });
  } catch (error) {
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message });
  }
});

// Validation for linking users to a chat
api.post('/link-users-to-chat', [
  body('chatId').not().isEmpty().withMessage('Chat ID is required'),
  body('userIds').isArray().withMessage('User IDs must be an array'),
], async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { chatId, userIds } = req.body;
  try {
    const chatUsersInsertError = await Promise.all(
      userIds.map(userId => 
        supabase.from('chats_users').insert({ chat_id: chatId, user_id: userId })
      )
    );

    if (chatUsersInsertError.some(result => result.error)) throw new Error('Failed to link chat with users');
    
    res.json({ success: true });
  } catch (error) {
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message });
  }
});




// Add this endpoint to your Express server
api.get('/fetch-user-by-name', async (req: Request, res: Response) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: 'Username is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('name', username)
      .single();

    if (error || !data) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json(data);
  } catch (error) {
    const errorMessage = (error as Error).message;
    res.status(500).json({ message: 'An unexpected error occurred.', error: errorMessage });
  }
});


api.get('/fetch-user-profile', async (req: Request, res: Response) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('name', username)
      .single();

    if (error) {
      // Assuming Supabase uses this error type for "not found"; adjust based on actual behavior
      if (error.message === 'Item not found') {
        return res.status(404).json({ message: 'User not found' });
      } else {
        // Log the error or handle it as per your error handling policy
        console.error('Supabase error:', error);
        return res.status(500).json({ message: 'An unexpected error occurred' });
      }
    }

    res.json(data);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    // Since .single() can throw for no results, you might want to handle that specifically
    // This catch block will also catch other unexpected errors
    return res.status(500).json({ message: 'An unexpected error occurred', error: (error as { message: string }).message });
  }
});


api.post('/send-message', async (req: Request, res: Response) => {
  const { chat_id, author_id, content } = req.body;
  try {
    const messageId = crypto.randomUUID();

    const { error } = await supabase
      .from('messages')
      .insert([
        { id: messageId, chat_id, author_id, content }
      ]);

    if (error) throw new Error('Failed to send message');

    res.json({ success: true });
  } catch (error) {
    // Type assertion to tell TypeScript that we expect error to have a message property
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message }); // Send error message as JSON response
  }
});




// Version the api
app.use('/api/v1', api);

const port = process.env.PORT || 3333;
server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});