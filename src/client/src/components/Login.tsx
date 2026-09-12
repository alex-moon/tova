import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '../hooks/useAuth';
import { AuthError } from '../services/auth';

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
      if (err instanceof AuthError) {
        setError(err.message);
      } else {
        setError('Authentication failed');
      }
    }
  };

  return (
    <main className="flex h-dvh w-full overflow-hidden">
      <Card className="mx-auto my-auto w-[min(20rem,calc(100vw-2rem))]">
        <CardHeader>
          <div className="mb-1 flex justify-center">
            <img src="/tova-logo.png" alt="Tova" className="size-12" />
          </div>
          <CardTitle>{isRegistering ? 'Create Account' : 'Login to Tova'}</CardTitle>
        </CardHeader>
        <CardContent>
          {error && <div className="mb-4 text-sm text-destructive">{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label htmlFor="email" className="mb-1 block text-sm text-muted-foreground">
                Email
              </label>
              <Input
                id="email"
                className="mb-1"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                required
              />
            </div>
            <div className="mb-4">
              <label htmlFor="password" className="mb-1 block text-sm text-muted-foreground">
                Password
              </label>
              <Input
                id="password"
                type="password"
                className="mb-1"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="mb-4 w-full">
              {isRegistering ? 'Register' : 'Login'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full text-xs"
              onClick={() => setIsRegistering(!isRegistering)}
            >
              {isRegistering ? 'Already have an account? Login' : "Don't have an account? Register"}
            </Button>
            <a href="/api/auth/google" className="block w-full">
              <Button type="button" variant="outline" className="w-full">
                Continue with Google
              </Button>
            </a>
          </form>
        </CardContent>
      </Card>
    </main>
  );
};

export default Login;
