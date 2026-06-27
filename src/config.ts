import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}\nCopy backend/.env.example → backend/.env and fill in your credentials.`);
  return val;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  // Backend API URL — where this server is reachable from clients
  // Used to construct the GNAP callback URL passed to the auth server
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:3001',
  // Frontend URL — where the frontend is served from
  // The frontend is served BY the backend at the same origin, so this matches backendUrl
  // Used for CORS and redirects after callback completion
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3001',

  op: {
    walletAddress: required('OP_WALLET_ADDRESS'),
    keyId:         required('OP_KEY_ID'),
    privateKeyPath: required('OP_PRIVATE_KEY_PATH'),
  },

  db: {
    path: process.env.DB_PATH ?? './openremit.db',
  },

  jwtSecret: process.env.JWT_SECRET ?? 'changeme',
};

if (config.jwtSecret === 'changeme') {
  console.warn('[config] JWT_SECRET is the default placeholder — set a long random value in backend/.env before deploying.');
}
