import { handleChat } from './handler.mjs';

Deno.serve(req => handleChat(req, Deno.env.get('APINEX_API_KEY')));
