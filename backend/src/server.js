import express from 'express';
import cors from 'cors';
import moviesRouter from './routes/movies.js';
import { getPool } from './db/postgres.js';

const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/movies', moviesRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });
});

async function main() {
  const pool = getPool();
  await pool.query('select 1 as ok');
  console.log('Postgres conectado');
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`API em http://0.0.0.0:${PORT}`);
  });

  const shutdown = async () => {
    try {
      await pool.end();
    } catch (e) {
      console.error('Erro ao fechar pool', e);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
