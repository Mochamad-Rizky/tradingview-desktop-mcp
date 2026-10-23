import type { DashboardInfo } from '@contract';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { ApiError, apiGet, onUnauthorized } from '@/api/client';
import { queryKeys } from '@/api/query-client';
import { readToken, storeToken } from '@/api/token';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const NOT_ACCEPTED = 'That token was not accepted.';
const EMPTY = 'Enter the access token.';
const UNSENDABLE =
  'That token holds a space or a character that a token cannot hold. Check what was pasted.';
const UNREACHABLE = 'The server could not be reached. Check that it is still running.';

// The server reads the token as one word after "Bearer", and a header carries ASCII: anything else
// (a space inside, quotes a word processor curled) cannot be the token, and need not be sent.
const SENDABLE = /^[\x21-\x7E]+$/;

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401
      ? NOT_ACCEPTED
      : `The server refused the request (${String(error.status)}): ${error.message}`;
  }
  return UNREACHABLE;
}

interface TokenFormProps {
  error: string | null;
  onError: (message: string | null) => void;
  onConnected: (info: DashboardInfo) => void;
}

function TokenForm({ error, onError, onConnected }: TokenFormProps) {
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const titleId = useId();
  const inputId = useId();
  const helpId = useId();

  const connect = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = value.trim();
    if (token === '') {
      onError(EMPTY);
      return;
    }
    if (!SENDABLE.test(token)) {
      onError(UNSENDABLE);
      return;
    }
    setChecking(true);
    onError(null);
    try {
      // Checked before it is stored, so that a wrong token never replaces a stored one.
      const info = await apiGet<DashboardInfo>('/api/info', { token });
      storeToken(token);
      onConnected(info);
    } catch (failure) {
      onError(messageFor(failure));
      setChecking(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 id={titleId} className="font-heading text-base leading-snug font-medium">
            Connect to the server
          </h1>
          <CardDescription>TradingView MCP dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            aria-labelledby={titleId}
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(event) => {
              void connect(event);
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={inputId}>Access token</Label>
              <Input
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={value}
                aria-describedby={helpId}
                aria-invalid={error === null ? undefined : true}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
              <p id={helpId} className="text-sm text-muted-foreground">
                The value of <code className="font-mono">TV_MCP_AUTH_TOKEN</code> that the server
                was started with. It is kept in this tab only.
              </p>
            </div>
            {error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={checking} aria-busy={checking}>
              Connect
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

// Shows `children` only with a token, and asks for one otherwise. A 401 from any call later (the
// server restarted with another token, say) comes back here. The token of a #token= link is in
// storage already: the entry takes it from the address before the first render. The gate only
// reads storage, and keeps whether there is a token, never the token itself.
export function TokenGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [signedIn, setSignedIn] = useState(() => readToken() !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onUnauthorized(() => {
        // Nothing read with the old token is shown with the next one.
        queryClient.clear();
        setError(NOT_ACCEPTED);
        setSignedIn(false);
      }),
    [queryClient],
  );

  if (!signedIn) {
    return (
      <TokenForm
        error={error}
        onError={setError}
        onConnected={(info) => {
          // The check read the server facts: the app shows them at once, before its own request.
          queryClient.setQueryData(queryKeys.info, info);
          setError(null);
          setSignedIn(true);
        }}
      />
    );
  }
  return children;
}
