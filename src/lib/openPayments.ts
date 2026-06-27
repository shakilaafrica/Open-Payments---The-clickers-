import {
  createAuthenticatedClient,
  isPendingGrant,
  isFinalizedGrantWithAccessToken,
} from '@interledger/open-payments';
import type { Grant, GrantContinuation, GrantWithAccessToken, PendingGrant } from '@interledger/open-payments';
import { config } from '../config';

// Singleton — one authenticated client per process lifetime.
// The client signs every request with the Ed25519 private key.
let _client: Awaited<ReturnType<typeof createAuthenticatedClient>> | null = null;

export async function getClient() {
  if (_client) return _client;
  _client = await createAuthenticatedClient({
    walletAddressUrl: config.op.walletAddress,
    keyId:            config.op.keyId,
    privateKey:       config.op.privateKeyPath, // file path — SDK reads the .pem itself
  });
  return _client;
}

// Convert shorthand "$ilp.example.com/alice" → "https://ilp.example.com/alice".
// The SDK also accepts full https:// URLs, so this is safe to call either way.
export function normaliseWalletAddress(addr: string): string {
  return addr.startsWith('$') ? `https://${addr.slice(1)}` : addr;
}

// Type guard for grants that are finalised and carry a usable access token.
// Composes the SDK's own guards so it works for both fresh grant requests
// (PendingGrant | Grant) and grant continuations (GrantContinuation | Grant).
export function isFinalizedGrant(
  grant: PendingGrant | GrantContinuation | Grant
): grant is GrantWithAccessToken {
  return !isPendingGrant(grant) && isFinalizedGrantWithAccessToken(grant);
}
