import express, { Request, Response } from 'express';
import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import { config } from 'dotenv';
import winston from 'winston';

config(); // Loads environment variables from .env file

interface WebSocketMessage {
  type: string;
  messageId?: string;
  senderId?: string;
  reaction?: string;
  text?: string;
  chat_id?: string;
  userId?: string;
  userName?: string;
  userAvatar?: string;
  createdAt?: string;
  updatedAt?: string;
  author_id?: string;
  content: string;
}

export const app = express();
const server = http.createServer(app);

// CORS setup
const allowedOrigins = ['https://kainbridge.vercel.app', 'https://kainbridge.com/coaching/', 'http://localhost:3000'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.raw({ type: 'application/vnd.custom-type' }));
app.use(express.text({ type: 'text/html' }));

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ],
});

app.use((req, res, next) => {
  logger.info(`Handling ${req.method} request for ${req.url}`);
  next();
});

// Healthcheck endpoint
app.get('/', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

const supabaseUrl = process.env.SUPABASE_URL || 'https://wlsmvssgzxytellyxbrp.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indsc212c3Nnenh5dGVsbHl4YnJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTc2NDkzNTEsImV4cCI6MjAxMzIyNTM1MX0.-7FujJy32v5FhipK173ghinQKQV_Wf4mmhxUiBayjiQ';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const wss = new WebSocketServer({ server, path: '/api/v1/ws' });

wss.on('connection', (ws: WebSocket) => {
  logger.info('WebSocket connection established');

  ws.on('error', (error: Error) => {
    logger.error('WebSocket error:', error);
  });

  ws.on('message', async (rawData: string) => {
    try {
      const message: WebSocketMessage = JSON.parse(rawData);
      await handleWebSocketMessage(message, ws);
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error);
      ws.send(JSON.stringify({ error: 'Invalid message format' }));
    }
  });
});

async function handleWebSocketMessage(message: WebSocketMessage, ws: WebSocket) {
  if (message.type === 'reaction') {
    await handleReaction(message, ws);
  } else if (message.type === 'typing_started' || message.type === 'typing_stopped') {
    await handleTypingEvent(message, ws);
  } else {
    await handleMessage(message, ws);
  }
}

async function handleTypingEvent(message: WebSocketMessage, ws: WebSocket) {
  const { type, senderId, chat_id } = message;
  logger.info(`Received typing event from ${senderId} in chat ${chat_id}: ${type}`);

  if (!senderId || !chat_id) {
    ws.send(JSON.stringify({ error: 'Sender ID and Chat ID are required for typing events' }));
    return;
  }

  let recipients = 0;
  wss.clients.forEach(client => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type, senderId, chat_id }));
      recipients++;
    }
  });
  logger.info(`Typing event ${type} from ${senderId} was sent to ${recipients} other clients.`);
}

async function handleReaction(message: WebSocketMessage, ws: WebSocket) {
  const { messageId, reaction, senderId } = message;

  if (!messageId) {
    ws.send(JSON.stringify({ error: 'Message ID is required for reactions' }));
    return;
  }

  const { data: messageData, error: messageError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .single();

  if (messageError || !messageData) {
    logger.error('Failed to fetch message for reaction:', messageError?.message);
    ws.send(JSON.stringify({ error: 'Failed to fetch message' }));
    return;
  }

  let updatedReactions = messageData.reactions || [];
  const reactionIndex = updatedReactions.findIndex(r => r.emoji === reaction && r.userId === senderId);

  if (reactionIndex !== -1) {
    updatedReactions[reactionIndex].count += 1;
  } else {
    updatedReactions.push({ emoji: reaction, userId: senderId, count: 1 });
  }

  const { error: updateError } = await supabase
    .from('messages')
    .update({ reactions: updatedReactions })
    .eq('id', messageId);

  if (updateError) {
    logger.error('Failed to update reactions:', updateError.message);
    ws.send(JSON.stringify({ error: 'Failed to update reactions' }));
    return;
  }

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'reactionUpdate', messageId: messageId, reactions: updatedReactions }));
    }
  });
}

async function handleMessage(message: WebSocketMessage, ws: WebSocket) {
  const { error } = await supabase
    .from('messages')
    .insert([{
      chat_id: message.chat_id,
      author_id: message.author_id,
      content: message.content,
      status: 'sent',
    }]);

  if (error) {
    logger.error('Failed to insert message:', error.message);
    ws.send(JSON.stringify({ error: 'Failed to process message' }));
    return;
  }

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

const api = express.Router();

app.post('/generate-text', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ message: 'Prompt is required' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = await response.text();

    res.json({ generatedText: text });
  } catch (error) {
    const message = (error as { message: string }).message || 'Error generating text.';
    res.status(500).json({ message });
  }
});

api.get('/hello', (req, res) => {
  res.status(200).send({ message: 'hello world' });
});

api.post('/submit-coach-form', async (req, res) => {
  const { userId, q1, q2, q3, q4, q5 } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required' });
  }

  try {
    const { error } = await supabase
      .from('coachvet')
      .insert([{ userId, q1, q2, q3, q4, q5 }]);

    if (error) {
      throw error;
    }

    res.status(200).json({ message: 'Form submitted successfully' });
  } catch (error) {
    const message = (error as { message: string }).message || 'Error submitting coaching form.';
    res.status(500).json({ message });
  }
});

api.get('/fetch-user-bio-and-image/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('userbio')
      .select('name, jobTitle, bio, email, phone, location, userId, imageUrl')
      .eq('userId', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ message: 'User bio not found.' });
    }

    res.json(data);
  } catch (error) {
    const errorMessage = (error as Error).message || 'Fetching userbio and image failed.';
    res.status(500).json({ message: errorMessage });
  }
});

api.get('/fetch-resume-url/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('userbio')
      .select('resumeUrl')
      .eq('userId', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ message: 'Resume URL not found.' });
    }

    let resumeUrl = data.resumeUrl;

    // Check if the URL is for a .doc or .docx file and format it for Google Docs Viewer
    if (resumeUrl.match(/\.(doc|docx)$/i)) {
      resumeUrl = `https://docs.google.com/gview?url=${encodeURIComponent(resumeUrl)}&embedded=true`;
    }

    res.json({ resumeUrl });
  } catch (error) {
    const errorMessage = (error as Error).message || 'An unexpected error occurred.';
    res.status(500).json({ message: errorMessage });
  }
});

api.get('/fetch-resume-url2/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('coachbio')
      .select('resumeUrl')
      .eq('userId', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ message: 'Resume URL not found.' });
    }

    let resumeUrl = data.resumeUrl;

    // Check if the URL is for a .doc or .docx file and format it for Google Docs Viewer
    if (resumeUrl.match(/\.(doc|docx)$/i)) {
      resumeUrl = `https://docs.google.com/gview?url=${encodeURIComponent(resumeUrl)}&embedded=true`;
    }

    res.json({ resumeUrl });
  } catch (error) {
    const errorMessage = (error as Error).message || 'An unexpected error occurred.';
    res.status(500).json({ message: errorMessage });
  }
});

api.get('/fetch-chat-history/:chatId', async (req: Request, res: Response) => {
  const { chatId } = req.params;

  if (!chatId) {
    return res.status(400).json({ message: 'Chat ID is required' });
  }

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch chat history: ${error.message}`);
    }

    res.json(data);
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

api.post('/fetch-coach-bio-and-image', async (req, res) => {
  const { coachId } = req.body;
  try {
    const { data, error } = await supabase
      .from('coachbio')
      .select('*')
      .eq('userId', coachId);
    if (error) throw new Error(`Failed to fetch coach bio: ${error.message}`);
    if (data.length === 0) {
      return res.status(404).json({ message: 'Coach bio not found' });
    }
    res.json(data[0]);
  } catch (error) {
    const message = (error as { message: string }).message || 'An unexpected error occurred.';
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
      throw error;
    }

    res.json(data);
  } catch (error) {
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message });
  }
});

api.get('/coach-user-relationships', async (req: Request, res: Response) => {
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
      throw error;
    }

    res.json(data);
  } catch (error) {
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message });
  }
});

  api.get('/search-users', async (req: Request, res: Response) => {
    const { query, page = 1, limit = 10, sort = 'name', order = 'asc' } = req.query;
  
    if (!query) {
      return res.status(400).json({ message: 'Search query is required' });
    }
  
    try {
      const offset = (Number(page) - 1) * Number(limit);
      const { data, error, count } = await supabase
        .from('profiles')
        .select('id, name, email, phone, focusCareer, focusLife, type, company', { count: 'exact' })
        .ilike('name', `%${query}%`)
        .order(sort as string, { ascending: order === 'asc' })
        .range(offset, offset + Number(limit) - 1);
  
      if (error) throw error;
  
      res.json({
        profiles: data,
        hasMore: offset + Number(limit) < count,
      });
    } catch (error) {
      const message = (error as { message: string }).message || 'An unexpected error occurred';
      res.status(500).json({ message });
    }
  });
  
  api.get('/search-suggestions', async (req: Request, res: Response) => {
    const { query } = req.query;
  
    if (!query) {
      return res.status(400).json({ message: 'Search query is required' });
    }
  
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name')
        .ilike('name', `%${query}%`)
        .limit(5);
  
      if (error) throw error;
  
      const suggestions = data.map((profile) => profile.name);
      res.json(suggestions);
    } catch (error) {
      const message = (error as { message: string }).message || 'An unexpected error occurred';
      res.status(500).json({ message });
    }
  });
  
  api.post('/create-chat-with-user', [
    body('userId').not().isEmpty().withMessage('User ID is required'),
    body('otherUserId').not().isEmpty().withMessage('Other User ID is required'),
  ], async (req: Request, res: Response) => {
    const errors = validationResult(req);
  
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
  
    const { userId, otherUserId } = req.body;
  
    try {
      const newChatId = crypto.randomUUID();
      const { error: chatCreateError } = await supabase.from('chats').insert([{ id: newChatId }]);
  
      if (chatCreateError) throw chatCreateError;
  
      const users = [userId, otherUserId];
      const chatUsersInsertError = await Promise.all(
        users.map(user =>
          supabase.from('chats_users').insert({ chat_id: newChatId, user_id: user })
        )
      );
  
      if (chatUsersInsertError.some(result => result.error)) throw new Error('Failed to link chat with users');
  
      res.json({ newChatId });
    } catch (error) {
      const message = (error as { message: string }).message || 'An unexpected error occurred';
      res.status(500).json({ message });
    }
  });
  
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
        if (error.message === 'Item not found') {
          return res.status(404).json({ message: 'User not found' });
        } else {
          console.error('Supabase error:', error);
          return res.status(500).json({ message: 'An unexpected error occurred' });
        }
      }
  
      res.json(data);
    } catch (error) {
      console.error('Error fetching user profile:', error);
      return res.status(500).json({ message: 'An unexpected error occurred', error: (error as { message: string }).message });
    }
  });
  
  api.post('/send-message', async (req: Request, res: Response) => {
    const { chat_id, author_id, content } = req.body;
    const trimmedContent = content.trim();
  
    if (trimmedContent === '') {
      return res.status(400).json({ message: 'Message content cannot be empty' });
    }
  
    try {
      const { data: chatData, error: chatError } = await supabase
        .from('chats')
        .select('users:chats_users(user:profiles(role, id))')
        .eq('id', chat_id)
        .single();
  
      if (chatError) throw new Error('Failed to fetch chat details');
  
      const isCoachRecipient = chatData.users.some((chatUser: any) => chatUser.user.role === 'coach' && chatUser.user.id !== author_id);
  
      const { error } = await supabase
        .from('messages')
        .insert([
          {
            chat_id,
            author_id,
            content: trimmedContent,
            status: isCoachRecipient ? 'waiting_for_coach' : 'sent',
          },
        ]);
  
      if (error) throw new Error('Failed to send message');
  
      res.json({ success: true });
    } catch (error) {
      const message = (error as { message: string }).message || 'An unexpected error occurred';
      res.status(500).json({ message });
    }
  });
  
  // Version the api
  app.use('/api/v1', api);
  
  const port = process.env.PORT || 3333;
  server.listen(port, () => {
    console.log(`Server started on port ${port}`);
  });