import { Router } from 'express';
import crypto from 'node:crypto';
import { eq, ne, and, desc } from 'drizzle-orm';
import { isPendingGrant } from '@interledger/open-payments';
import { db } from '../db';
import { transactions, users } from '../db/schema';
import { getClient, normaliseWalletAddress, isFinalizedGrant } from '../lib/openPayments';
import { createQuoteTransaction } from '../lib/quoteFlow';
import { config } from '../config';
import { requireAuth } from '../middleware/requireAuth';

export const remitRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/remit/wallet-info?url=<wallet-address>
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.get('/wallet-info', requireAuth, async (req, res, next) => {
  try {
    const url = ((req.query.url as string) ?? '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });
    const client = await getClient();
    const wallet = await client.walletAddress.get({ url: normaliseWalletAddress(url) });
    res.json({ assetCode: wallet.assetCode, assetScale: wallet.assetScale });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/remit/quote
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const { senderWalletAddress, receiverWalletAddress, amount, paymentType } = req.body as {
      senderWalletAddress:   string;
      receiverWalletAddress: string;
      amount:      string;
      paymentType: 'FIXED_SEND' | 'FIXED_RECEIVE';
    };
    if (!senderWalletAddress || !receiverWalletAddress || !amount || !paymentType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['FIXED_SEND', 'FIXED_RECEIVE'].includes(paymentType)) {
      return res.status(400).json({ error: 'paymentType must be FIXED_SEND or FIXED_RECEIVE' });
    }
    const result = await createQuoteTransaction({
      senderWalletAddress, receiverWalletAddress, amount, paymentType,
      userId: req.user!.id,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/remit/consent
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.post('/consent', requireAuth, async (req, res, next) => {
  try {
    const { transactionId } = req.body as { transactionId: string };
    if (!transactionId) return res.status(400).json({ error: 'Missing transactionId' });

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!tx || tx.userId !== req.user!.id) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'PENDING') return res.status(400).json({ error: `Transaction is ${tx.status}, expected PENDING` });

    const client        = await getClient();
    const sendingWallet = await client.walletAddress.get({ url: tx.senderWalletAddress });
    const nonce         = crypto.randomUUID();
    const callbackUrl   = `${config.backendUrl}/api/callback?transactionId=${transactionId}`;

    const outgoingGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      {
        access_token: {
          access: [{
            type:       'outgoing-payment',
            actions:    ['create', 'read'],
            identifier: sendingWallet.id,
            limits: {
              debitAmount: {
                value:      tx.debitAmount!,
                assetCode:  tx.assetCode,
                assetScale: tx.assetScale,
              },
            },
          }],
        },
        interact: {
          start: ['redirect'],
          finish: { method: 'redirect', uri: callbackUrl, nonce },
        },
      }
    );

    if (!isPendingGrant(outgoingGrant) || !outgoingGrant.interact?.redirect) {
      throw new Error('Expected interactive outgoing-payment grant with interact.redirect');
    }

    await db.update(transactions).set({
      status:             'AWAITING_GRANT',
      grantContinueUri:   outgoingGrant.continue.uri,
      grantContinueToken: outgoingGrant.continue.access_token.value,
      grantInteractNonce: nonce,
      updatedAt:          new Date(),
    }).where(eq(transactions.id, transactionId));

    res.json({ interactUrl: outgoingGrant.interact.redirect });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/remit/status/:id
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.get('/status/:id', async (req, res, next) => {
  try {
    const [tx] = await db.select({
      id:                    transactions.id,
      status:                transactions.status,
      paymentType:           transactions.paymentType,
      senderWalletAddress:   transactions.senderWalletAddress,
      receiverWalletAddress: transactions.receiverWalletAddress,
      debitAmount:           transactions.debitAmount,
      receiveAmount:         transactions.receiveAmount,
      assetCode:             transactions.assetCode,
      assetScale:            transactions.assetScale,
      receiveAssetCode:      transactions.receiveAssetCode,
      receiveAssetScale:     transactions.receiveAssetScale,
      outgoingPaymentUrl:    transactions.outgoingPaymentUrl,
      quoteExpiresAt:        transactions.quoteExpiresAt,
      errorMessage:          transactions.errorMessage,
      createdAt:             transactions.createdAt,
      recipientName:         users.displayName,
      recipientId:           users.id,
    }).from(transactions)
      .leftJoin(users, eq(users.walletAddress, transactions.receiverWalletAddress))
      .where(eq(transactions.id, req.params.id));
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json(tx);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/remit/dropoff                          ← NEW for Safe Ride
//
// Called by the driver after confirming drop-off.
// Verifies the transaction is COMPLETED (payment released by wallet callback)
// and returns a receipt. In production you'd also verify the driver's JWT and
// match the transactionId to a PIN that was previously validated.
//
// ILP flow recap at this point:
//   1. Parent called /quote → incoming-payment + quote created on ILP network
//   2. Parent called /consent → GNAP interactive grant requested
//   3. Parent approved at wallet → /api/callback fired
//   4. Callback continued grant → outgoing payment created on ILP network (COMPLETED)
//   5. Driver calls /dropoff → we verify COMPLETED, return receipt
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.post('/dropoff', requireAuth, async (req, res, next) => {
  try {
    const { transactionId, scholarName } = req.body as {
      transactionId: string;
      scholarName:   string;
    };
    if (!transactionId) return res.status(400).json({ error: 'Missing transactionId' });

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // For demo transactions (id starts with "demo-") we accept them without
    // hitting the ILP network — useful when running without real wallet creds.
    if (transactionId.startsWith('demo-')) {
      return res.json({
        ok:         true,
        demo:       true,
        txId:       transactionId,
        amount:     tx.debitAmount ?? '0',
        assetCode:  tx.assetCode   ?? 'ZAR',
        assetScale: tx.assetScale  ?? 2,
        scholar:    scholarName,
        completedAt: new Date().toISOString(),
        ilpNote:    'Demo mode — no real ILP payment was created.',
      });
    }

    // Real ILP: payment must already be COMPLETED (wallet callback already fired)
    if (tx.status !== 'COMPLETED') {
      return res.status(400).json({
        error:  `Payment is ${tx.status} — it must be COMPLETED before drop-off can be confirmed.`,
        status: tx.status,
      });
    }

    // Optionally read the outgoing payment from the ILP network for the receipt
    let ilpPaymentUrl = tx.outgoingPaymentUrl ?? null;

    res.json({
      ok:             true,
      demo:           false,
      txId:           transactionId,
      amount:         tx.debitAmount ?? '0',
      assetCode:      tx.assetCode   ?? 'ZAR',
      assetScale:     tx.assetScale  ?? 2,
      scholar:        scholarName,
      completedAt:    new Date().toISOString(),
      outgoingPaymentUrl: ilpPaymentUrl,
      ilpNote:        'Payment was released via Interledger Open Payments on wallet approval.',
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/remit/history
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.get('/history', requireAuth, async (req, res, next) => {
  try {
    const me = req.user!.id;
    const txFields = {
      id: transactions.id, status: transactions.status,
      paymentType: transactions.paymentType,
      senderWalletAddress: transactions.senderWalletAddress,
      receiverWalletAddress: transactions.receiverWalletAddress,
      debitAmount: transactions.debitAmount, receiveAmount: transactions.receiveAmount,
      assetCode: transactions.assetCode, assetScale: transactions.assetScale,
      receiveAssetCode: transactions.receiveAssetCode, receiveAssetScale: transactions.receiveAssetScale,
      outgoingPaymentUrl: transactions.outgoingPaymentUrl,
      quoteExpiresAt: transactions.quoteExpiresAt, errorMessage: transactions.errorMessage,
      createdAt: transactions.createdAt,
      counterpartyName: users.displayName, counterpartyId: users.id,
    };
    const sent = await db.select(txFields).from(transactions)
      .leftJoin(users, eq(users.walletAddress, transactions.receiverWalletAddress))
      .where(eq(transactions.userId, me)).orderBy(desc(transactions.createdAt)).limit(20).all();
    const [meRow] = await db.select({ walletAddress: users.walletAddress }).from(users).where(eq(users.id, me));
    const received = meRow?.walletAddress
      ? await db.select(txFields).from(transactions)
          .leftJoin(users, eq(users.id, transactions.userId))
          .where(and(eq(transactions.receiverWalletAddress, meRow.walletAddress), ne(transactions.userId, me)))
          .orderBy(desc(transactions.createdAt)).limit(20).all()
      : [];
    const rows = [
      ...sent.map(r => ({ ...r, direction: 'sent' as const, counterpartyWallet: r.receiverWalletAddress })),
      ...received.map(r => ({ ...r, direction: 'received' as const, counterpartyWallet: r.senderWalletAddress })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20);
    res.json(rows);
  } catch (err) { next(err); }
});
