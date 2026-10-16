import { useEffect, useState } from 'react';
import { ChevronDown, Plus, Unplug, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { ConnectorInfo } from '@shared/connectors';
import { CONNECTOR_CATALOG } from '@shared/connectorCatalog';
import type { CatalogEntry } from '@shared/connectorCatalog';
import { instructionsFor } from '@shared/connectorInstructions';
import type { ConnectorInstructions } from '@shared/connectorInstructions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ConnectorService, { ConnectorError } from '../services/connectors';
import ConnectorLogo from './ConnectorLogo';

/*
 * The connectors view (#331, epic #328): a curated grid of catalog cards
 * (market-share ordered, #326), a per-connector connect modal, and an
 * "add anything else" custom affordance for power users. Mobile-first:
 * single-column grid and a bottom-sheet modal at phone width.
 *
 * Connected/not is a url-join — catalog definitions have fixed endpoints,
 * so a personal connector row with the same url means connected (trailing
 * slashes normalized — real rows carry them, e.g. the Copilot MCP url).
 * Custom rows (no matching definition) render in their own list.
 */

// Trailing-slash-insensitive url identity for the catalog join — the one
// place this normalization lives, so cards, modal, and custom list agree.
const normUrl = (url: string): string => url.replace(/\/+$/, '');

// The grid renders live entries only (#333): the watchlist rides in the
// catalog as data and re-appears by flipping state, but the view shows the
// verified set — no "coming soon" cards. Watchlisted providers' rows (connected
// via the custom affordance before a flip) still surface under "Added by you",
// so CATALOG_ENDPOINTS covers the whole catalog while the GRID uses live only.
const LIVE_CATALOG = CONNECTOR_CATALOG.filter((d) => d.state === 'live');
const CATALOG_ENDPOINTS = new Set(CONNECTOR_CATALOG.map((d) => normUrl(d.endpoint)));

const findRowByUrl = (rows: ConnectorInfo[], url: string): ConnectorInfo | undefined =>
  rows.find((c) => c.scope === 'user' && normUrl(c.url) === normUrl(url));

type ModalTarget =
  { kind: 'catalog'; entry: CatalogEntry } | { kind: 'custom'; connector: ConnectorInfo } | null;

// Renders one render path for provider instruction content (#332): real
// steps when the ref resolves, generic honest copy when the entry has none.
const InstructionSteps = ({ instructions }: { instructions: ConnectorInstructions }) => (
  <div
    data-testid="connector-modal-instructions"
    className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs"
  >
    <p className="mb-2">{instructions.intro}</p>
    <ol className="space-y-2">
      {instructions.steps.map((step, i) => (
        <li key={i} className="flex gap-2">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold"
          >
            {i + 1}
          </span>
          <span className="min-w-0">
            {step.title && <span className="block font-medium">{step.title}</span>}
            <span className="block text-muted-foreground">{step.body}</span>
          </span>
        </li>
      ))}
    </ol>
    {instructions.scopeNote && (
      <p className="mt-2 rounded border-border bg-background/60 p-2 text-muted-foreground">
        {instructions.scopeNote}
      </p>
    )}
  </div>
);

const statusBadge = (connector: ConnectorInfo): { label: string; className: string } => {
  if (connector.authState === 'needs-reauth')
    return { label: 'Re-connect needed', className: 'text-destructive border-destructive' };
  return connector.status === 'connected'
    ? { label: 'Connected', className: 'text-green-600 border-green-600' }
    : { label: 'Not connected', className: 'text-muted-foreground border-border' };
};

const ConnectorsView = () => {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalTarget>(null);
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    let alive = true;
    ConnectorService.list()
      .then((next) => {
        if (alive) setConnectors(next);
      })
      .catch((err) => {
        if (alive && err instanceof ConnectorError) setLoadError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Custom rows: personal connectors whose url matches no catalog endpoint.
  const customRows = (connectors ?? []).filter(
    (c) => c.scope === 'user' && !CATALOG_ENDPOINTS.has(normUrl(c.url)),
  );
  const connectedCount = (connectors ?? []).filter(
    (c) => c.scope === 'user' && c.status === 'connected' && c.authState !== 'needs-reauth',
  ).length;

  const refresh = async () => {
    try {
      setConnectors(await ConnectorService.list());
    } catch (err) {
      if (err instanceof ConnectorError) setLoadError(err.message);
    }
  };

  return (
    <div
      data-testid="connectors-view"
      className="mx-auto h-dvh w-full max-w-4xl overflow-y-auto p-4 pt-14 pb-16"
    >
      <header className="mb-4">
        <h1 className="font-heading text-xl font-semibold">Connectors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Link the services you already use — the assistant can then use them during chats.
        </p>
        {connectors && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="connectors-count">
            {connectedCount} connected
          </p>
        )}
      </header>

      {loadError && (
        <div
          role="alert"
          data-testid="connectors-error"
          className="mb-3 rounded-lg border border-destructive bg-destructive/10 p-2 text-xs text-destructive"
        >
          {loadError}
        </div>
      )}

      {connectors === null && !loadError ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LIVE_CATALOG.map((entry) => {
            const connected = findRowByUrl(connectors ?? [], entry.endpoint);
            const badge = connected
              ? statusBadge(connected)
              : entry.state === 'watchlisted'
                ? { label: 'Coming soon', className: 'text-muted-foreground border-border' }
                : { label: 'Connect', className: 'text-foreground border-border' };
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  data-testid={`connector-card-${entry.id}`}
                  onClick={() => setModal({ kind: 'catalog', entry })}
                  className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-accent/50"
                >
                  <ConnectorLogo
                    name={entry.name}
                    iconRef={entry.iconRef}
                    brandColor={entry.brandColor}
                    className="size-9 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{entry.name}</span>
                      <span
                        data-testid={`connector-card-${entry.id}-status`}
                        className={`shrink-0 rounded border px-1 text-[10px] uppercase ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {entry.summary}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {customRows.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Added by you</h2>
          <ul className="space-y-2 text-sm">
            {customRows.map((c) => {
              const badge = statusBadge(c);
              return (
                <li
                  key={c.id}
                  data-testid={`connector-row-${c.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                        c.status === 'connected'
                          ? 'bg-green-500'
                          : c.status === 'unreachable'
                            ? 'bg-red-500'
                            : 'bg-gray-400'
                      }`}
                      aria-label={`Status: ${c.status}`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{c.url}</span>
                    </span>
                    <span
                      className={`shrink-0 rounded border px-1 text-[10px] uppercase ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid={`connector-row-${c.id}-manage`}
                    onClick={() => setModal({ kind: 'custom', connector: c })}
                  >
                    Manage
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <CustomConnectSection
        show={showCustom}
        onToggle={() => setShowCustom((prev) => !prev)}
        onAdded={refresh}
      />

      {modal && (
        <ConnectorModal
          target={modal}
          connectors={connectors ?? []}
          onClose={() => setModal(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
};

const CustomConnectSection = ({
  show,
  onToggle,
  onAdded,
}: {
  show: boolean;
  onToggle: () => void;
  onAdded: () => void;
}) => {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [pendingAdd, setPendingAdd] = useState(false);
  const [pendingOauth, setPendingOauth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && url.trim().length > 0;

  const addToken = async () => {
    setPendingAdd(true);
    setError(null);
    try {
      const trimmed = authToken.trim();
      await ConnectorService.add({
        type: 'mcp.pat',
        name: name.trim(),
        url: url.trim(),
        ...(trimmed ? { authToken: trimmed } : {}),
      });
      setName('');
      setUrl('');
      setAuthToken('');
      onAdded();
    } catch (err) {
      setError(err instanceof ConnectorError ? err.message : 'Could not add connector.');
    } finally {
      setPendingAdd(false);
    }
  };

  const addSignin = async () => {
    setPendingOauth(true);
    setError(null);
    try {
      const authorizationUrl = await ConnectorService.startOAuth({
        name: name.trim(),
        url: url.trim(),
      });
      if (!authorizationUrl.startsWith('https://')) {
        setError('The sign-in URL is not secure — this provider cannot be connected right now.');
        return;
      }
      window.open(authorizationUrl, '_self');
    } catch (err) {
      // 422 = no OAuth advertised: the token form above is the fallback.
      setError(err instanceof ConnectorError ? err.message : 'Could not start sign-in.');
      setPendingOauth(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-border p-3">
      <button
        type="button"
        aria-expanded={show}
        data-testid="connectors-custom-toggle"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-sm font-medium"
      >
        <Plus className="size-4" />
        Add anything else by URL
        <ChevronDown
          className={`ml-auto size-4 transition-transform ${show ? 'rotate-180' : ''}`}
        />
      </button>
      {show && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            For a server that is not in the grid above: give it a name and paste its https&nbsp;URL.
            If it advertises sign-in we can connect it that way, otherwise a token works.
          </p>
          <label className="block text-xs">
            <span className="mb-1 block">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              data-testid="connector-add-name"
              placeholder="my-tools"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block">URL (https)</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              maxLength={2048}
              data-testid="connector-add-url"
              placeholder="https://example.com/mcp"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block">Auth token (if needed)</span>
            <Input
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              maxLength={4000}
              data-testid="connector-add-token"
              placeholder="token"
              autoComplete="off"
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={addSignin}
              disabled={!canSubmit || pendingOauth}
              data-testid="connector-add-oauth"
            >
              {pendingOauth ? 'Opening sign-in...' : 'Connect with sign-in'}
            </Button>
            <Button
              variant="outline"
              onClick={addToken}
              disabled={!canSubmit || pendingAdd}
              data-testid="connector-add-save"
            >
              {pendingAdd ? 'Testing connection...' : 'Add with token'}
            </Button>
          </div>
          {error && (
            <div
              role="alert"
              data-testid="connector-add-error"
              className="text-xs text-destructive"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

const ConnectorModal = ({
  target,
  connectors,
  onClose,
  onChanged,
}: {
  target: NonNullable<ModalTarget>;
  connectors: ConnectorInfo[];
  onClose: () => void;
  onChanged: () => void;
}) => {
  const [authToken, setAuthToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ConnectorError ? err.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  };

  const navigateToConsent = (authorizationUrl: string): boolean => {
    // Defense in depth with the server's https-only discovery guard: never
    // navigate to anything that is not a https consent screen.
    if (!authorizationUrl.startsWith('https://')) {
      setError('The sign-in URL is not secure — this provider cannot be connected right now.');
      return false;
    }
    window.open(authorizationUrl, '_self');
    return true;
  };

  const connectOauth = (name: string, url: string) =>
    run(async () => {
      navigateToConsent(await ConnectorService.startOAuth({ name, url }));
    });

  const reconnect = (id: string) =>
    run(async () => {
      navigateToConsent(await ConnectorService.reauth(id));
    });

  const connectToken = (entry: CatalogEntry) =>
    run(async () => {
      const trimmed = authToken.trim();
      await ConnectorService.add({
        type: 'mcp.pat',
        name: entry.name,
        url: entry.endpoint,
        authToken: trimmed,
      });
      setAuthToken('');
      onChanged();
      onClose();
    });

  const disconnect = (id: string) =>
    run(async () => {
      await ConnectorService.remove(id);
      onChanged();
      onClose();
    });

  // What the modal body offers, resolved per target kind and state.
  let title: string;
  let summary: string;
  let grants: string;
  let entry: CatalogEntry | undefined;
  let row: ConnectorInfo | undefined;
  if (target.kind === 'catalog') {
    entry = target.entry;
    title = entry.name;
    summary = entry.summary ?? '';
    grants =
      entry.authType === 'mcp.oauth'
        ? `Connecting signs in at ${entry.name} and stores the access for your account. You can disconnect at any time.`
        : `Connecting uses an API token you create at ${entry.name}; it is stored encrypted and never shown again.`;
    row = findRowByUrl(connectors, entry.endpoint);
  } else {
    row = target.connector;
    title = row.name;
    summary = row.url;
    grants =
      row.authState === 'needs-reauth'
        ? 'The connection needs to be signed in again.'
        : 'Connected for your account.';
  }

  const needsReauth = row?.authState === 'needs-reauth';
  const watchlisted = entry?.state === 'watchlisted';
  const entryInstructions = entry ? instructionsFor(entry) : undefined;
  // Catalog PAT entries connect by token, and a tokenless row is a dead end
  // (no update path) — the token is required up front. OAuth connects with
  // browser consent only.
  const connectDisabled = pending || !entry || (entry.authType === 'mcp.pat' && !authToken.trim());

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="connector-modal"
          aria-label={`${title} connector`}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-background p-4 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
        >
          <div className="flex items-start gap-3">
            <ConnectorLogo
              name={title}
              iconRef={entry?.iconRef}
              brandColor={entry?.brandColor}
              className="size-10 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <Dialog.Title data-testid="connector-modal-title" className="text-base font-semibold">
                {title}
              </Dialog.Title>
              {summary && (
                <Dialog.Description className="text-xs text-muted-foreground">
                  {summary}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="-m-1 shrink-0 cursor-pointer rounded-lg p-2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </div>

          {watchlisted ? (
            <div
              data-testid="connector-modal-watchlist"
              className="mt-3 rounded-lg border border-border bg-muted/50 p-3 text-sm"
            >
              <p className="font-medium">Coming soon</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {entry?.watchlistNote ??
                  'This connector is on the watchlist and cannot be connected yet.'}
              </p>
            </div>
          ) : (
            <>
              <p className="mt-3 text-sm">{grants}</p>

              {entry?.authType === 'mcp.pat' && !row && (
                <>
                  <label className="mt-3 block text-xs">
                    <span className="mb-1 block">API token from {entry.name}</span>
                    <Input
                      type="password"
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                      maxLength={4000}
                      data-testid="connector-modal-token"
                      placeholder="token"
                      autoComplete="off"
                      onFocus={(e) => e.target.scrollIntoView({ block: 'center' })}
                    />
                    <span className="mt-1 block text-muted-foreground">
                      {entryInstructions
                        ? 'The token is submitted once, stored encrypted, and never shown again.'
                        : `Create an API token in your ${entry.name} account settings and paste it here. The token is stored encrypted and never shown again.`}
                    </span>
                  </label>
                  {entryInstructions && <InstructionSteps instructions={entryInstructions} />}
                </>
              )}

              {entry?.authType === 'mcp.oauth' && entryInstructions && !row && (
                <details className="mt-3 text-xs" data-testid="connector-modal-token-fallback">
                  <summary className="cursor-pointer text-muted-foreground">
                    Prefer an API token instead?
                  </summary>
                  <p className="mt-2 text-muted-foreground">
                    OAuth sign-in is the recommended path here. If you specifically want
                    token-scoped access, create a token with the steps below and connect it through
                    “Add anything else by URL”.
                  </p>
                  <InstructionSteps instructions={entryInstructions} />
                </details>
              )}

              {row && (
                <p
                  data-testid="connector-modal-status"
                  className="mt-3 text-xs text-muted-foreground"
                >
                  {needsReauth
                    ? 'Signed-in access has expired or was revoked.'
                    : row.status === 'connected'
                      ? 'Connected and ready.'
                      : `Status: ${row.status.replace('-', ' ')}.`}
                </p>
              )}

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                {row ? (
                  <>
                    {needsReauth && row.type === 'mcp.oauth' && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        data-testid="connector-modal-reconnect"
                        onClick={() => reconnect(row!.id)}
                      >
                        Re-connect
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={pending}
                      data-testid="connector-modal-disconnect"
                      onClick={() => disconnect(row!.id)}
                    >
                      <Unplug className="size-4" />
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={connectDisabled}
                    data-testid="connector-modal-connect"
                    onClick={() =>
                      entry!.authType === 'mcp.oauth'
                        ? connectOauth(entry!.name, entry!.endpoint)
                        : connectToken(entry!)
                    }
                  >
                    {pending
                      ? entry?.authType === 'mcp.oauth'
                        ? 'Opening sign-in...'
                        : 'Testing connection...'
                      : 'Connect'}
                  </Button>
                )}
              </div>
            </>
          )}

          {error && (
            <div
              role="alert"
              data-testid="connector-modal-error"
              className="mt-3 text-xs text-destructive"
            >
              {error}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ConnectorsView;
