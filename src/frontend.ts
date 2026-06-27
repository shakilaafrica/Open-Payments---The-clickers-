type UserProfile = {
  id: string;
  email: string;
  displayName: string;
  walletAddress?: string | null;
  avatar?: string | null;
};

type TransactionRecord = {
  id: string;
  status: string;
  paymentType?: string;
  debitAmount?: string | number | null;
  assetCode?: string | null;
  assetScale?: number | null;
  counterpartyName?: string | null;
  counterpartyId?: string | null;
  senderWalletAddress?: string | null;
  receiverWalletAddress?: string | null;
  createdAt?: string;
  outgoingPaymentUrl?: string | null;
  errorMessage?: string | null;
};

type HealthResponse = {
  ok: boolean;
  service: string;
};

type SessionState = {
  apiBase: string;
  parentToken: string;
  driverToken: string;
  parentProfile: UserProfile | null;
  driverProfile: UserProfile | null;
  health: HealthResponse | null;
  transactions: TransactionRecord[];
  selectedAmount: string;
  status: string;
  loading: boolean;
  activeTxId: string;
  consentUrl: string;
  pin: string;
  flowError: string;
};

const DEMO_CREDENTIALS = {
  parent: { email: 'thembeka@openremit.dev', password: 'demo1234' },
  driver: { email: 'sipho@openremit.dev', password: 'demo1234' },
};

const state: SessionState = {
  apiBase: window.location.origin,
  parentToken: '',
  driverToken: '',
  parentProfile: null,
  driverProfile: null,
  health: null,
  transactions: [],
  selectedAmount: '34',
  status: 'Connecting to the backend…',
  loading: true,
  activeTxId: '',
  consentUrl: '',
  pin: '',
  flowError: '',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatAmount(raw: string | number | null | undefined, assetCode = 'ZAR'): string {
  if (raw == null || raw === '') return '—';
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isNaN(value)) return '—';
  if (assetCode === 'USD' || assetCode === 'EUR') {
    return `${value.toFixed(2)} ${assetCode}`;
  }
  return `R${value / 100}`;
}

async function requestJson<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${state.apiBase}${path}`, {
    ...init,
    headers,
  });

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'error' in payload ? String((payload as { error?: string }).error) : `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

async function login(role: 'parent' | 'driver'): Promise<void> {
  const creds = DEMO_CREDENTIALS[role];
  const payload = await requestJson<{ token: string; user: UserProfile }>(
    '/api/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email: creds.email, password: creds.password }),
    }
  );

  if (role === 'parent') {
    state.parentToken = payload.token;
    state.parentProfile = payload.user;
  } else {
    state.driverToken = payload.token;
    state.driverProfile = payload.user;
  }
}

async function handleCallbackUrl(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('status');
  const id = params.get('id');

  if (!status || !id) return;

  try {
    const tx = await requestJson<{
      status: string;
      outgoingPaymentUrl?: string | null;
      errorMessage?: string | null;
    }>(`/api/remit/status/${id}`);

    state.activeTxId = id;

    if (tx.status === 'COMPLETED') {
      state.pin = String(Math.floor(10000 + Math.random() * 90000));
      state.status = 'Payment completed. Share the PIN with the driver.';
      state.flowError = '';
      state.consentUrl = '';
    } else if (tx.status === 'FAILED') {
      state.flowError = tx.errorMessage || 'The transaction failed.';
      state.status = 'The flow did not complete.';
    } else {
      state.status = `Current status: ${tx.status}`;
    }

    // Clear the URL parameters so they don't persist on refresh
    window.history.replaceState({}, '', window.location.pathname);
  } catch (error) {
    console.error('[callback] Error processing callback URL:', error);
  }
}

async function loadBackendData(): Promise<void> {
  state.loading = true;
  state.status = 'Connecting to the backend…';
  render();

  try {
    state.health = await requestJson<HealthResponse>('/api/health');
    await Promise.all([login('parent'), login('driver')]);
    const [meParent, meDriver, history] = await Promise.all([
      requestJson<UserProfile>('/api/auth/me', {}, state.parentToken),
      requestJson<UserProfile>('/api/auth/me', {}, state.driverToken),
      requestJson<TransactionRecord[]>('/api/remit/history', {}, state.parentToken),
    ]);

    state.parentProfile = meParent;
    state.driverProfile = meDriver;
    state.transactions = history;
    state.status = 'Live backend data is loaded.';
    state.loading = false;
    state.flowError = '';
  } catch (error) {
    state.loading = false;
    state.status = error instanceof Error ? error.message : 'Unable to reach the backend.';
  }

  render();
}

async function startOpenPaymentsFlow(): Promise<void> {
  if (!state.parentToken || !state.parentProfile || !state.driverProfile) {
    state.flowError = 'Log in first.';
    render();
    return;
  }

  const parentWallet = state.parentProfile.walletAddress;
  const driverWallet = state.driverProfile.walletAddress;
  if (!parentWallet || !driverWallet) {
    state.flowError = 'The backend profile is missing a wallet address.';
    render();
    return;
  }

  state.loading = true;
  state.flowError = '';
  state.status = 'Creating the quote and consent flow…';
  render();

  try {
    const quote = await requestJson<{ transactionId: string }>(
      '/api/remit/quote',
      {
        method: 'POST',
        body: JSON.stringify({
          senderWalletAddress: parentWallet,
          receiverWalletAddress: driverWallet,
          amount: String(Number(state.selectedAmount) * 100),
          paymentType: 'FIXED_SEND',
        }),
      },
      state.parentToken
    );

    state.activeTxId = quote.transactionId;
    const consent = await requestJson<{ interactUrl: string }>(
      '/api/remit/consent',
      {
        method: 'POST',
        body: JSON.stringify({ transactionId: quote.transactionId }),
      },
      state.parentToken
    );

    state.consentUrl = consent.interactUrl;
    state.status = 'Redirecting to wallet approval…';
    state.loading = false;
    state.pin = '';
    render();

    // Auto-open the consent URL in a new window
    window.open(consent.interactUrl, '_blank', 'noreferrer');
  } catch (error) {
    state.loading = false;
    state.flowError = error instanceof Error ? error.message : 'The flow could not start.';
    state.status = 'The Open Payments flow needs a valid wallet configuration.';
    render();
  }
}

async function checkTransactionStatus(): Promise<void> {
  if (!state.activeTxId) {
    state.flowError = 'Start the flow first.';
    render();
    return;
  }

  state.loading = true;
  state.status = 'Checking the transaction status…';
  render();

  try {
    const tx = await requestJson<{
      status: string;
      outgoingPaymentUrl?: string | null;
      errorMessage?: string | null;
    }>(`/api/remit/status/${state.activeTxId}`);

    if (tx.status === 'COMPLETED') {
      state.pin = String(Math.floor(10000 + Math.random() * 90000));
      state.status = 'Payment completed. Share the PIN with the driver.';
      state.flowError = '';
    } else if (tx.status === 'FAILED') {
      state.flowError = tx.errorMessage || 'The transaction failed.';
      state.status = 'The flow did not complete.';
    } else {
      state.status = `Current status: ${tx.status}`;
    }
  } catch (error) {
    state.flowError = error instanceof Error ? error.message : 'Could not fetch the transaction status.';
    state.status = 'The backend did not return transaction status.';
  }

  state.loading = false;
  render();
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) return;

  const parentWallet = state.parentProfile?.walletAddress || 'Waiting for backend…';
  const driverWallet = state.driverProfile?.walletAddress || 'Waiting for backend…';
  const recentTransactions = state.transactions.slice(0, 4).map((tx) => {
    const amount = formatAmount(tx.debitAmount, tx.assetCode || 'ZAR');
    const peer = tx.counterpartyName || tx.receiverWalletAddress || tx.senderWalletAddress || '—';
    return `
      <li class="transaction-item">
        <div>
          <strong>${escapeHtml(peer)}</strong>
          <div class="muted">${escapeHtml(tx.status || 'Unknown')} · ${escapeHtml(tx.paymentType || 'payment')}</div>
        </div>
        <div class="amount">${escapeHtml(amount)}</div>
      </li>
    `;
  }).join('');

  app.innerHTML = `
    <div class="shell">
      <header class="hero">
        <div>
          <div class="badge">Open Payments · Interledger</div>
          <h1>OpenRemit Safe Ride</h1>
          <p>Parent authorises a trip with a live grant flow, while the driver validates the ride and confirms drop-off.</p>
        </div>
        <div class="hero-card">
          <div class="label">Backend status</div>
          <div class="hero-value">${state.health ? 'Connected' : 'Connecting…'}</div>
          <div class="muted">${state.status}</div>
        </div>
      </header>

      <main class="layout">
        <section class="panel">
          <h2>Live backend accounts</h2>
          <div class="accounts">
            <article class="card">
              <div class="card-title">Parent</div>
              <div class="card-name">${state.parentProfile ? escapeHtml(state.parentProfile.displayName) : 'Loading…'}</div>
              <div class="muted">${state.parentProfile ? escapeHtml(state.parentProfile.email) : '—'}</div>
              <div class="wallet">${escapeHtml(parentWallet)}</div>
            </article>
            <article class="card">
              <div class="card-title">Driver</div>
              <div class="card-name">${state.driverProfile ? escapeHtml(state.driverProfile.displayName) : 'Loading…'}</div>
              <div class="muted">${state.driverProfile ? escapeHtml(state.driverProfile.email) : '—'}</div>
              <div class="wallet">${escapeHtml(driverWallet)}</div>
            </article>
          </div>
        </section>

        <section class="panel">
          <h2>Recent remit activity</h2>
          <ul class="transaction-list">
            ${recentTransactions || '<li class="empty">No transactions yet.</li>'}
          </ul>
        </section>

        <section class="panel flow-panel">
          <div class="flow-header">
            <div>
              <h2>Open Payments flow</h2>
              <p class="muted">Uses the live backend quote and consent endpoints.</p>
            </div>
            <div class="pill">${state.loading ? 'Working…' : 'Ready'}</div>
          </div>

          <div class="amount-row">
            ${['20', '34', '50', '68'].map((value) => `
              <button class="amount-chip ${state.selectedAmount === value ? 'selected' : ''}" data-amount="${value}">
                R${value}
              </button>
            `).join('')}
          </div>

          <button id="start-flow" class="primary">Start Open Payments flow</button>

          <div class="status-box">
            ${state.flowError ? `<div class="error">${escapeHtml(state.flowError)}</div>` : ''}
            ${state.pin ? `<div class="pin">PIN: <strong>${state.pin}</strong></div>` : ''}
          </div>

          <div class="footer-row">
            <button id="check-status" class="secondary">Check status</button>
            <button id="refresh" class="secondary">Refresh from backend</button>
          </div>
        </section>
      </main>
    </div>
  `;

  const amountButtons = app.querySelectorAll<HTMLButtonElement>('.amount-chip');
  amountButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedAmount = button.dataset.amount || '34';
      render();
    });
  });

  app.querySelector('#start-flow')?.addEventListener('click', () => void startOpenPaymentsFlow());
  app.querySelector('#check-status')?.addEventListener('click', () => void checkTransactionStatus());
  app.querySelector('#refresh')?.addEventListener('click', () => void loadBackendData());
}

function boot(): void {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.innerHTML = '';
  document.body.appendChild(root);

  const style = document.createElement('style');
  style.textContent = `
    :root { color-scheme: light; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f7fb; color: #10213a; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: linear-gradient(135deg, #f7fbf8 0%, #eef4f8 100%); color: #10213a; }
    #app { padding: 24px; }
    .shell { max-width: 1160px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .hero { display: flex; justify-content: space-between; gap: 16px; align-items: center; background: linear-gradient(135deg, #0b6e4f 0%, #1d8f64 100%); padding: 24px; border-radius: 24px; color: white; box-shadow: 0 16px 38px rgba(11, 110, 79, 0.25); }
    .hero h1 { font-size: 2rem; margin: 6px 0 8px; }
    .hero p { margin: 0; max-width: 700px; line-height: 1.5; color: rgba(255,255,255,0.86); }
    .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,0.16); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; }
    .hero-card { min-width: 250px; background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.24); border-radius: 16px; padding: 14px 16px; }
    .hero-value { font-size: 1.3rem; font-weight: 700; margin-top: 6px; }
    .layout { display: grid; gap: 18px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panel { background: white; border-radius: 20px; padding: 20px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08); }
    .flow-panel { grid-column: 1 / -1; }
    .accounts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .card { border-radius: 16px; background: #f7fafb; padding: 14px; border: 1px solid #e7edf1; }
    .card-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #4c6a7d; margin-bottom: 8px; font-weight: 700; }
    .card-name { font-weight: 700; font-size: 1.04rem; }
    .wallet { margin-top: 8px; color: #0b6e4f; font-size: 0.95rem; word-break: break-all; }
    .muted { color: #627487; font-size: 0.93rem; line-height: 1.45; }
    .transaction-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
    .transaction-item { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #edf2f5; }
    .transaction-item:last-child { border-bottom: none; }
    .amount { font-weight: 700; color: #0b6e4f; }
    .empty { padding: 10px 0; color: #627487; }
    .flow-header { display: flex; justify-content: space-between; align-items: center; gap: 14px; margin-bottom: 14px; }
    .pill { display: inline-flex; align-items: center; justify-content: center; padding: 8px 10px; border-radius: 999px; background: #e8f5ee; color: #0b6e4f; font-weight: 700; }
    .amount-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 14px; }
    .amount-chip { border: 1px solid #d2e4da; border-radius: 999px; padding: 10px 16px; background: white; color: #2b3d4d; cursor: pointer; font-weight: 700; }
    .amount-chip.selected { background: #0b6e4f; color: white; border-color: #0b6e4f; }
    .primary, .secondary { border: none; border-radius: 12px; padding: 12px 16px; font-weight: 700; cursor: pointer; } 
    .primary { background: #0b6e4f; color: white; width: 100%; }
    .secondary { background: #eef4f8; color: #21435b; }
    .status-box { margin-top: 14px; padding: 14px; border-radius: 14px; background: #f8fbfd; border: 1px solid #e6edf2; min-height: 58px; }
    .error { color: #c13030; font-weight: 600; margin-bottom: 6px; }
    .link { color: #0b6e4f; font-weight: 600; text-decoration: none; }
    .pin { margin-top: 8px; color: #0b6e4f; font-size: 1.1rem; }
    .footer-row { display: flex; gap: 10px; margin-top: 14px; }
    .footer-row button { flex: 1; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .hero { flex-direction: column; align-items: start; } .accounts { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(style);
  render();
  void Promise.all([handleCallbackUrl(), loadBackendData()]);
}

document.addEventListener('DOMContentLoaded', boot);
