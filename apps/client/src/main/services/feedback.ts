import axios from 'axios';

// Connector separating views from axios; feedback POST/DELETE go through here.
const FeedbackService = {
  async record(messageId: string, value: 'up' | 'down'): Promise<void> {
    await axios.post(`/api/messages/${messageId}/feedback`, { value });
  },

  async clear(messageId: string): Promise<void> {
    await axios.delete(`/api/messages/${messageId}/feedback`);
  },
};

export default FeedbackService;
