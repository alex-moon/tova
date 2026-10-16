import { useEffect, useState } from 'react';
import ConnectorService, { ConnectorError } from '../services/connectors';

/*
 * OAuth consent landing page (#327). The provider redirects the browser here
 * with ?code=&state= (same-origin app in dev and prod); the page relays them
 * to POST /api/connectors/oauth/callback, which completes the exchange and
 * creates/updates the connector. Slice-1 minimal surface: the real
 * connectors view (#331) will own this flow's UX.
 */

const ConnectorOAuthCallback = () => {
  // The redirect's query is fixed for the page's lifetime, and the page
  // remounts per redirect: read it once at mount, no memo, no
  // setState-in-effect.
  const params = new URLSearchParams(window.location.search);
  const redirectError = params.get('error');
  const redirectCode = params.get('code');
  const redirectState = params.get('state');
  const initialError = redirectError
    ? `Sign-in was not completed: ${params.get('error_description') || redirectError}`
    : !redirectCode || !redirectState
      ? 'This sign-in link is missing its code or state. Start again from settings.'
      : null;

  const [settled, setSettled] = useState<{ kind: 'done' | 'error'; message: string } | null>(
    initialError ? { kind: 'error', message: initialError } : null,
  );

  useEffect(() => {
    if (!redirectCode || !redirectState) return;
    let alive = true;
    ConnectorService.completeOAuth({ code: redirectCode, state: redirectState })
      .then((connector) => {
        if (alive) setSettled({ kind: 'done', message: `${connector.name} connected.` });
      })
      .catch((err) => {
        if (alive) {
          setSettled({
            kind: 'error',
            message:
              err instanceof ConnectorError
                ? err.message
                : 'Sign-in could not be completed. Start again from settings.',
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [redirectCode, redirectState]);

  const working = !initialError && !settled;

  return (
    <div className="flex h-dvh w-full items-center justify-center p-6">
      <div
        data-testid="connector-oauth-callback"
        className="w-full max-w-sm space-y-3 rounded-xl border border-border p-6 text-center"
      >
        <p
          data-testid="connector-oauth-status"
          className={
            settled?.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-foreground'
          }
        >
          {working ? 'Completing sign-in...' : settled?.message}
        </p>
        {!working && (
          <a
            href="/connectors"
            className="block text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Back to connectors
          </a>
        )}
      </div>
    </div>
  );
};

export default ConnectorOAuthCallback;
