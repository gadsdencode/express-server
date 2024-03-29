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

const allowedOrigins = ['https://elixir-ai.vercel.app', 'https://elixir-alpha-seven.vercel.app', 'http://localhost:3000'];

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

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

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

app.post('/generate-text', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ message: 'Prompt is required' });
  }

  try {
    // For text-only input, use the gemini-pro model
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    res.json({ generatedText: text });
  } catch (error) {
    const message = (error as { message: string }).message || 'Error fetching chat history.';
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

api.post('/fetch-coach-bio-and-image', async (req, res) => {
  const { coachId } = req.body;

  try {
    const { data, error } = await supabase
      .from('coachbio')
      .select('*') // Adjust the selection as needed
      .eq('userId', coachId)
      .single();

    if (error) throw new Error(`Failed to fetch coach bio: ${error.message}`);
    res.json(data);
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
      throw error; // Pass the error object to the catch block
    }

    res.json(data); // Send data as JSON response
  } catch (error) {
    // Type assertion to tell TypeScript that we expect error to have a message property
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message }); // Send error message as JSON response
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


//Endpoint for searching for users by name via ContactSelector
api.get('/search-users', async (req: Request, res: Response) => {
  const { query, page = 1, limit = 10, sort = 'name', order = 'asc' } = req.query;
  if (!query) {
    return res.status(400).json({ message: 'Search query is required' });
  }
  try {
    const offset = (Number(page) - 1) * Number(limit);
    const { data, error, count } = await supabase
      .from('profiles')
      .select('id, name, email', { count: 'exact' })
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

//Endpoint for creating a chat and linking users to that chat via ContactSelector
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
    // Create a new chat
    const newChatId = crypto.randomUUID();
    const { error: chatCreateError } = await supabase.from('chats').insert([{ id: newChatId }]);
    if (chatCreateError) throw chatCreateError;

    // Link both users to the new chat
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