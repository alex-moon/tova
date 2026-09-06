import React, { useState } from 'react';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState('');
  const { login, register } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (isRegistering) {
        await register(email, password);
      } else {
        await login(email, password);
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.message || 'Authentication failed');
      } else {
        setError('Authentication failed');
      }
    }
  };

  return (
    <main>
      <div style={{ margin: 'auto', width: '300px' }} className="card">
        <h2>{isRegistering ? 'Create Account' : 'Login to Tova'}</h2>
        {error && (
          <div style={{ color: 'var(--color-error)', marginBottom: '1rem', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label
              htmlFor="email"
              style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.9rem' }}
            >
              Email
            </label>
            <input
              id="email"
              className="input-field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label
              htmlFor="password"
              style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.9rem' }}
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input-field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginBottom: '1rem' }}
          >
            {isRegistering ? 'Register' : 'Login'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: '100%', fontSize: '0.8rem' }}
            onClick={() => setIsRegistering(!isRegistering)}
          >
            {isRegistering ? 'Already have an account? Login' : "Don't have an account? Register"}
          </button>
        </form>
      </div>
    </main>
  );
};

export default Login;
