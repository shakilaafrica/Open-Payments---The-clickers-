/**
 * seedUsers.ts
 *
 * Seeds two demo accounts used by the Safe Ride frontend demo flow:
 *   Parent  — thembeka@openremit.dev / demo1234
 *   Driver  — sipho@openremit.dev    / demo1234
 *
 * Wallet addresses must match what the frontend sends to /api/remit/quote.
 * Register these handles at https://wallet.interledger-test.dev first,
 * then paste the exact URLs below.
 *
 * This function is idempotent — safe to call on every startup.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

const DEMO_USERS = [
  {
    email:         'thembeka@openremit.dev',
    displayName:   'Thembeka M.',
    password:      'demo1234',
    walletAddress: 'https://ilp.interledger-test.dev/shakila',
  },
  {
    email:         'sipho@openremit.dev',
    displayName:   'Sipho D.',
    password:      'demo1234',
    walletAddress: 'https://ilp.interledger-test.dev/helloworld',
  },
];

export async function seedUsers(): Promise<void> {
  for (const u of DEMO_USERS) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email)).get();
    if (existing) continue; // already seeded — skip

    const now = new Date();
    await db.insert(users).values({
      id:            crypto.randomUUID(),
      displayName:   u.displayName,
      email:         u.email,
      passwordHash:  await bcrypt.hash(u.password, 10),
      walletAddress: u.walletAddress,
      createdAt:     now,
    });
    console.log(`[seed] Created demo user: ${u.email}`);
  }
  
}
