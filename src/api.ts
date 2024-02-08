import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const app = express();

app.use(cors({ origin: true }));

app.use(express.json());
app.use(express.raw({ type: 'application/vnd.custom-type' }));
app.use(express.text({ type: 'text/html' }));

// Healthcheck endpoint
app.get('/', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const api = express.Router();

api.get('/hello', (req, res) => {
  res.status(200).send({ message: 'hello world' });
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

api.post('/create-chat-with-user', async (req: Request, res: Response) => {
  const { userId, newUserName } = req.body;
  try {
    const { data: otherUserData, error: otherUserError } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', newUserName)
      .single();

    if (otherUserError) throw new Error('User not found');

    const newChatId = crypto.randomUUID();

    const { error: chatInsertError } = await supabase
      .from('chats')
      .insert([{ id: newChatId }]);

    if (chatInsertError) throw new Error('Failed to create chat');

    const { error: chatUsersInsertError } = await supabase
      .from('chats_users')
      .insert([
        { chat_id: newChatId, user_id: userId },
        { chat_id: newChatId, user_id: otherUserData.id }
      ]);

    if (chatUsersInsertError) throw new Error('Failed to link chat with users');

    res.json({ newChatId });
  } catch (error) {
    // Type assertion to tell TypeScript that we expect error to have a message property
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message }); // Send error message as JSON response
  }
});

api.get('/fetch-user-profile', async (req: Request, res: Response) => {
  const username = req.query.username as string;
  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('name', username)
      .single();

    if (error) throw new Error('User not found');

    res.json(data);
  } catch (error) {
    // Type assertion to tell TypeScript that we expect error to have a message property
    const message = (error as { message: string }).message || 'An unexpected error occurred';
    res.status(500).json({ message }); // Send error message as JSON response
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
