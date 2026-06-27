import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { transactions, paymentRequests, postUnlocks } from '../db/schema';
import { getClient, isFinalizedGrant } from '../lib/openPayments';
import { config } from '../config';

export const callbackRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/callback
//
// GNAP redirect endpoint — the auth server redirects the user's browser here
// after they complete (or deny) consent.
//
// Query params supplied by the auth server:
//   interact_ref   — exchange token used to continue the grant
//   hash           — GNAP hash for verifying the callback (optional verification)
//
// Query param we added to the callback URL in /consent:
//   transactionId  — our DB row to update
//
// Steps:
//   1. Load the transaction and validate state
//   2. Continue the grant with interact_ref → receive access token
//   3. Create the outgoing payment
//   4. Mark the transaction COMPLETED and redirect the browser to the frontend
// ─────────────────────────────────────────────────────────────────────────────
callbackRouter.get('/', async (req, res) => {
  // On success the auth server sends `interact_ref`. On rejection it sends
  // `result=grant_rejected` (and no interact_ref) — that's the user clicking
  // "Decline" at their wallet's consent page.
  const { interact_ref, transactionId, result } = req.query as Record<string, string>;

  if (!transactionId) {
    return res.status(400).send('Missing transactionId in callback query');
  }

  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId));

  if (!tx || tx.status !== 'AWAITING_GRANT') {
    // Render an error page for invalid state
    const redirectUrl = `${config.frontendUrl}?status=failed&id=${transactionId}&reason=invalid_state`;
    return res.type('html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Invalid Payment State</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: linear-gradient(135deg, #f7fbf8 0%, #eef4f8 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 16px;
            }
            .container {
              background: white;
              border-radius: 20px;
              padding: 32px;
              box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
              max-width: 400px;
              text-align: center;
              animation: slideIn 0.4s ease-out;
            }
            @keyframes slideIn {
              from { opacity: 0; transform: translateY(-20px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .toast {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 16px;
              background: #ffebee;
              border: 1px solid #ffcdd2;
              border-radius: 12px;
              margin-bottom: 24px;
              animation: toastSlide 0.5s ease-out;
            }
            @keyframes toastSlide {
              from { opacity: 0; transform: translateX(-20px); }
              to { opacity: 1; transform: translateX(0); }
            }
            .icon {
              width: 24px;
              height: 24px;
              background: #c13030;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
              font-weight: bold;
              color: white;
              font-size: 14px;
            }
            .toast-text {
              color: #c13030;
              font-weight: 600;
              font-size: 0.95rem;
            }
            h1 {
              font-size: 1.5rem;
              color: #10213a;
              margin-bottom: 12px;
            }
            p {
              color: #627487;
              font-size: 0.95rem;
              line-height: 1.5;
              margin-bottom: 24px;
            }
            .button {
              background: #0b6e4f;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 12px;
              font-weight: 700;
              cursor: pointer;
              font-size: 0.95rem;
              width: 100%;
              transition: background 0.2s;
            }
            .button:hover {
              background: #0a5a42;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="toast">
              <div class="icon">✕</div>
              <div class="toast-text">Invalid Payment</div>
            </div>
            <h1>Something went wrong</h1>
            <p>This payment request is no longer valid. Please start a new payment flow.</p>
            <button class="button" onclick="window.location.href = '${redirectUrl.replace(/"/g, '&quot;')}'">Go to App</button>
          </div>
        </body>
      </html>
    `);
  }

  // If this transaction unlocks a News post, send the reader back to that
  // article on return (on either outcome) instead of the generic status view.
  const [unlock] = await db
    .select({ postId: postUnlocks.postId })
    .from(postUnlocks)
    .where(and(eq(postUnlocks.transactionId, transactionId), eq(postUnlocks.status, 'PENDING')));
  const postSuffix = unlock ? `&post=${unlock.postId}` : '';

  // User declined consent (or the auth server returned no interact_ref): the
  // grant was rejected, so there's nothing to continue. Mark the payment failed
  // with a friendly reason and send them back to the app. Any linked ask/unlock
  // stays PENDING (handled like every other failure), so a retry is possible.
  if (!interact_ref || result === 'grant_rejected') {
    const errorMessage = result === 'grant_rejected'
      ? 'Payment declined — you cancelled the authorisation at your wallet.'
      : 'Authorisation did not complete. Please try the payment again.';

    await db
      .update(transactions)
      .set({
        status:       'FAILED',
        errorMessage: errorMessage,
        updatedAt:    new Date(),
      })
      .where(eq(transactions.id, transactionId));

    // Render an error page with a toast notification
    const redirectUrl = `${config.frontendUrl}?status=failed&id=${transactionId}${postSuffix}`;
    return res.type('html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Payment Declined</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: linear-gradient(135deg, #f7fbf8 0%, #eef4f8 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 16px;
            }
            .container {
              background: white;
              border-radius: 20px;
              padding: 32px;
              box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
              max-width: 400px;
              text-align: center;
              animation: slideIn 0.4s ease-out;
            }
            @keyframes slideIn {
              from { opacity: 0; transform: translateY(-20px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .toast {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 16px;
              background: #ffebee;
              border: 1px solid #ffcdd2;
              border-radius: 12px;
              margin-bottom: 24px;
              animation: toastSlide 0.5s ease-out;
            }
            @keyframes toastSlide {
              from { opacity: 0; transform: translateX(-20px); }
              to { opacity: 1; transform: translateX(0); }
            }
            .icon {
              width: 24px;
              height: 24px;
              background: #c13030;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
              font-weight: bold;
              color: white;
              font-size: 14px;
            }
            .toast-text {
              color: #c13030;
              font-weight: 600;
              font-size: 0.95rem;
            }
            h1 {
              font-size: 1.5rem;
              color: #10213a;
              margin-bottom: 12px;
            }
            p {
              color: #627487;
              font-size: 0.95rem;
              line-height: 1.5;
              margin-bottom: 24px;
            }
            .button {
              background: #0b6e4f;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 12px;
              font-weight: 700;
              cursor: pointer;
              font-size: 0.95rem;
              width: 100%;
              transition: background 0.2s;
            }
            .button:hover {
              background: #0a5a42;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="toast">
              <div class="icon">✕</div>
              <div class="toast-text">Payment Declined</div>
            </div>
            <h1>Authorization Cancelled</h1>
            <p>${errorMessage.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</p>
            <button class="button" onclick="window.location.href = '${redirectUrl.replace(/"/g, '&quot;')}'">Go to App</button>
          </div>
        </body>
      </html>
    `);
  }

  try {
    const client = await getClient();

    // Continue the grant — exchanges interact_ref for an outgoing-payment access token
    const finalizedGrant = await client.grant.continue(
      {
        url:         tx.grantContinueUri!,
        accessToken: tx.grantContinueToken!,
      },
      { interact_ref }
    );

    if (!isFinalizedGrant(finalizedGrant)) {
      throw new Error('Grant continuation did not return an access token. Consent may have been denied or expired.');
    }

    // Resolve the sender's resource server URL to create the outgoing payment
    const sendingWallet = await client.walletAddress.get({ url: tx.senderWalletAddress });

    // Create the outgoing payment using the previously created quote
    const outgoingPayment = await client.outgoingPayment.create(
      {
        url:         sendingWallet.resourceServer,
        accessToken: finalizedGrant.access_token.value,
      },
      {
        walletAddress: sendingWallet.id,
        quoteId:       tx.quoteUrl!,       // quoteId = full quote URL from Step 5 of /quote
        metadata:      { description: 'OpenRemit payment' },
      }
    );

    await db
      .update(transactions)
      .set({
        status:             'COMPLETED',
        outgoingPaymentUrl: outgoingPayment.id,
        updatedAt:          new Date(),
      })
      .where(eq(transactions.id, transactionId));

    // If this payment fulfils a payment request, close the request too.
    // (On failure the request stays PENDING so the payer can retry.)
    await db
      .update(paymentRequests)
      .set({ status: 'COMPLETED', updatedAt: new Date() })
      .where(and(
        eq(paymentRequests.transactionId, transactionId),
        eq(paymentRequests.status, 'PENDING'),
      ));

    // If this payment unlocks a News post, grant access.
    await db
      .update(postUnlocks)
      .set({ status: 'COMPLETED', updatedAt: new Date() })
      .where(and(
        eq(postUnlocks.transactionId, transactionId),
        eq(postUnlocks.status, 'PENDING'),
      ));

    // Render a success page with a toast notification, then redirect to frontend
    const redirectUrl = `${config.frontendUrl}?status=completed&id=${transactionId}${postSuffix}`;
    res.type('html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Payment Approved</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: linear-gradient(135deg, #f7fbf8 0%, #eef4f8 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 16px;
            }
            .container {
              background: white;
              border-radius: 20px;
              padding: 32px;
              box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
              max-width: 400px;
              text-align: center;
              animation: slideIn 0.4s ease-out;
            }
            @keyframes slideIn {
              from { opacity: 0; transform: translateY(-20px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .toast {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 16px;
              background: #e8f5ee;
              border: 1px solid #c8e6c9;
              border-radius: 12px;
              margin-bottom: 24px;
              animation: toastSlide 0.5s ease-out;
            }
            @keyframes toastSlide {
              from { opacity: 0; transform: translateX(-20px); }
              to { opacity: 1; transform: translateX(0); }
            }
            .checkmark {
              width: 24px;
              height: 24px;
              background: #0b6e4f;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
              font-weight: bold;
              color: white;
              font-size: 14px;
            }
            .toast-text {
              color: #0b6e4f;
              font-weight: 600;
              font-size: 0.95rem;
            }
            h1 {
              font-size: 1.5rem;
              color: #10213a;
              margin-bottom: 12px;
            }
            p {
              color: #627487;
              font-size: 0.95rem;
              line-height: 1.5;
              margin-bottom: 24px;
            }
            .button {
              background: #0b6e4f;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 12px;
              font-weight: 700;
              cursor: pointer;
              font-size: 0.95rem;
              width: 100%;
              transition: background 0.2s;
            }
            .button:hover {
              background: #0a5a42;
            }
            .spinner {
              display: inline-block;
              width: 4px;
              height: 4px;
              background: #0b6e4f;
              border-radius: 50%;
              margin-left: 6px;
              animation: blink 1.4s infinite;
            }
            .spinner:nth-child(2) { animation-delay: 0.2s; }
            .spinner:nth-child(3) { animation-delay: 0.4s; }
            @keyframes blink {
              0%, 60%, 100% { opacity: 0.3; }
              30% { opacity: 1; }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="toast">
              <div class="checkmark">✓</div>
              <div class="toast-text">Payment Approved</div>
            </div>
            <h1>Success!</h1>
            <p>Your transaction has been approved. Redirecting you back to the app<span class="spinner"></span><span class="spinner"></span><span class="spinner"></span></p>
            <button class="button" onclick="window.location.href = '${redirectUrl}'">Go to App</button>
          </div>
          <script>
            // Auto-redirect after 2 seconds
            setTimeout(() => {
              window.location.href = '${redirectUrl}';
            }, 2000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[callback] Payment failed:', message);

    await db
      .update(transactions)
      .set({
        status:       'FAILED',
        errorMessage: message,
        updatedAt:    new Date(),
      })
      .where(eq(transactions.id, transactionId));

    // Render an error page with a toast notification
    const redirectUrl = `${config.frontendUrl}?status=failed&id=${transactionId}${postSuffix}`;
    res.type('html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Payment Failed</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: linear-gradient(135deg, #f7fbf8 0%, #eef4f8 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 16px;
            }
            .container {
              background: white;
              border-radius: 20px;
              padding: 32px;
              box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
              max-width: 400px;
              text-align: center;
              animation: slideIn 0.4s ease-out;
            }
            @keyframes slideIn {
              from { opacity: 0; transform: translateY(-20px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .toast {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 16px;
              background: #ffebee;
              border: 1px solid #ffcdd2;
              border-radius: 12px;
              margin-bottom: 24px;
              animation: toastSlide 0.5s ease-out;
            }
            @keyframes toastSlide {
              from { opacity: 0; transform: translateX(-20px); }
              to { opacity: 1; transform: translateX(0); }
            }
            .icon {
              width: 24px;
              height: 24px;
              background: #c13030;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-shrink: 0;
              font-weight: bold;
              color: white;
              font-size: 14px;
            }
            .toast-text {
              color: #c13030;
              font-weight: 600;
              font-size: 0.95rem;
            }
            h1 {
              font-size: 1.5rem;
              color: #10213a;
              margin-bottom: 12px;
            }
            p {
              color: #627487;
              font-size: 0.95rem;
              line-height: 1.5;
              margin-bottom: 24px;
            }
            .button {
              background: #0b6e4f;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 12px;
              font-weight: 700;
              cursor: pointer;
              font-size: 0.95rem;
              width: 100%;
              transition: background 0.2s;
            }
            .button:hover {
              background: #0a5a42;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="toast">
              <div class="icon">!</div>
              <div class="toast-text">Payment Failed</div>
            </div>
            <h1>Something went wrong</h1>
            <p>${escapeHtml(message)}</p>
            <button class="button" onclick="window.location.href = '${redirectUrl}'">Go to App</button>
          </div>
          <script>
            function escapeHtml(text) {
              const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
              return text.replace(/[&<>"']/g, m => map[m]);
            }
          </script>
        </body>
      </html>
    `);
  }
});
