import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { config } from './config';
import express from 'express';
import cors from 'cors';
import { remitRouter }    from './routes/remit';
import { callbackRouter } from './routes/callback';
import { authRouter }     from './routes/auth';
import { usersRouter }    from './routes/users';
import { requestsRouter } from './routes/requests';
import { newsRouter }     from './routes/news';
import { errorHandler }   from './middleware/errorHandler';
import { seedNews }       from './lib/seedNews';
import { seedUsers }      from './lib/seedUsers';

const app = express();
const frontendHtml = readFileSync(path.join(__dirname, 'frontend.html'), 'utf8');

async function createFrontendBundle(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(__dirname, 'frontend.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    minify: false,
  });

  return result.outputFiles[0].text;
}

app.use(cors({ origin: '*', credentials: true }));   // '*' so the standalone HTML file can hit the API
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'openremit-backend' });
});

app.get('/', (_req, res) => {
  res.type('html').send(frontendHtml);
});

app.get('/frontend.js', async (_req, res, next) => {
  try {
    const frontendBundle = await createFrontendBundle();
    res.type('application/javascript').send(frontendBundle);
  } catch (err) {
    next(err);
  }
});

app.use('/api/auth',     authRouter);
app.use('/api/users',    usersRouter);
app.use('/api/requests', requestsRouter);
app.use('/api/news',     newsRouter);
app.use('/api/remit',    remitRouter);
app.use('/api/callback', callbackRouter);

app.use(errorHandler);

async function bootstrap() {
  // Seed demo data on first boot (idempotent)
  seedNews().catch((err)  => console.error('[seed] News seed failed:',  err));
  seedUsers().catch((err) => console.error('[seed] Users seed failed:', err));

  app.listen(config.port, () => {
    console.log(`\n  OpenRemit Safe Ride frontend → http://localhost:${config.port}\n`);
    console.log('  Demo accounts (seeded on first run):');
    console.log('    Parent  thembeka@openremit.dev / demo1234');
    console.log('    Driver  sipho@openremit.dev    / demo1234\n');
  });
}

void bootstrap();
