import axios from 'axios';

// Connector separating views from axios. Feedback POST/DELETE go through
// this module; views should not import axios directly (PR #27 review).
const FeedbackService = {
  async record(messageId: string, value: 'up' | 'down'): Promise<void> {
    await axios.post(`/api/messages/${messageId}/feedback`, { value });
  },

  async clear(messageId: string): Promise<void> {
    await axios.delete(`/api/messages/${messageId}/feedback`);
  },
};

export default FeedbackService;
