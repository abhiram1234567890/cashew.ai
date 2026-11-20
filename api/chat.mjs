import { handleChat } from '../supabase/functions/chat/handler.mjs';

export default {
  fetch(request) {
    return handleChat(request, process.env.APINEX_API_KEY);
  },
};
