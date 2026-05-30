import React, { useState } from 'react';

interface Message {
  _id: string;
  role: 'user' | 'assistant';
  content: string;
  modelName?: string;
}

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isLoading: boolean;
}

const ChatWindow: React.FC<ChatWindowProps> = ({ messages, onSendMessage, isLoading }) => {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSendMessage(input);
      setInput('');
    }
  };

  return (
    <section className="chat-window">
      <header
        style={{
          height: 'var(--header-height)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 1rem',
        }}
      >
        <h3>HFG - Heroku for Groq</h3>
      </header>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages.length === 0 && !isLoading && (
          <div style={{ margin: 'auto', textAlign: 'center', opacity: 0.5 }}>
            <h1>How can I help you today?</h1>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg._id} className={`chat-bubble chat-bubble-${msg.role}`}>
            {msg.content}
            {msg.modelName && (
              <div style={{ fontSize: '0.7rem', opacity: 0.5, marginTop: '0.25rem' }}>
                Model: {msg.modelName}
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="chat-bubble chat-bubble-assistant" style={{ opacity: 0.7 }}>
            Thinking...
          </div>
        )}
      </div>
      <footer style={{ padding: '1rem', borderTop: '1px solid var(--color-border)' }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            className="input-field"
            placeholder="Message Groq..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
          />
          <button type="submit" className="btn btn-primary" disabled={isLoading || !input.trim()}>
            Send
          </button>
        </form>
      </footer>
    </section>
  );
};

export default ChatWindow;
