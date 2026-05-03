import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { withClient } from '../db/postgres.js';
import { ddlSql, getEmbeddingDim } from '../db/schema.js';
import { embedMany } from '../embeddings/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeJsonParse(str, fallback) {
  if (str == null || str === '') return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function directorsFromCrew(crew) {
  if (!Array.isArray(crew)) return '';
  const names = crew
    .filter((c) => c.job === 'Director')
    .map((c) => c.name)
    .filter(Boolean);
  return [...new Set(names)].join(', ');
}

function topCastNames(cast, n = 10) {
  if (!Array.isArray(cast)) return '';
  return cast
    .slice(0, n)
    .map((c) => c.name)
    .filter(Boolean)
    .join(', ');
}

function castPreview(cast, n = 5) {
  if (!Array.isArray(cast)) return [];
  return cast.slice(0, n).map((c) => ({
    name: c.name,
    character: c.character,
  }));
}

function keywordNamesFromRow(keywordsCell) {
  const k = safeJsonParse(keywordsCell, []);
  if (!Array.isArray(k)) return '';
  return k.map((x) => x.name).filter(Boolean).join(', ');
}

function num(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function toVectorLiteral(vec) {
  if (!Array.isArray(vec)) return null;
  // pgvector aceita literal no formato: '[1,2,3]'
  return `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}

function docTextForEmbedding(d) {
  return [
    d.title,
    d.originalTitle,
    d.tagline,
    d.overview,
    d.genreNames,
    d.keywordNames,
    d.castNames,
    d.directorNames,
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const DATA_DIR =
    process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'database_filmes');
  const force = process.env.FORCE_SEED === '1';

  const moviesPath = path.join(DATA_DIR, 'tmdb_5000_movies.csv');
  const creditsPath = path.join(DATA_DIR, 'tmdb_5000_credits.csv');

  if (!fs.existsSync(moviesPath) || !fs.existsSync(creditsPath)) {
    console.error('CSV não encontrado em', DATA_DIR);
    process.exit(1);
  }

  console.log('Lendo créditos…');
  const creditsRaw = parse(fs.readFileSync(creditsPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  const creditsByMovie = new Map();
  for (const row of creditsRaw) {
    const mid = num(row.movie_id);
    if (mid == null) continue;
    creditsByMovie.set(mid, {
      cast: safeJsonParse(row.cast, []),
      crew: safeJsonParse(row.crew, []),
    });
  }

  console.log('Lendo filmes…');
  const moviesRaw = parse(fs.readFileSync(moviesPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true, 
  });

  const docs = [];

  for (const row of moviesRaw) {
    const tmdbId = num(row.id);
    if (tmdbId == null) continue;

    const cred = creditsByMovie.get(tmdbId) || { cast: [], crew: [] };
    const genres = safeJsonParse(row.genres, []);
    const genreList = Array.isArray(genres)
      ? genres.map((g) => ({ id: g.id, name: g.name }))
      : [];
    const genreNames = genreList.map((g) => g.name).filter(Boolean).join(', ');

    let releaseDate;
    if (row.release_date) {
      const d = new Date(row.release_date);
      releaseDate = Number.isNaN(d.getTime()) ? undefined : d;
    }

    docs.push({
      tmdbId,
      title: row.title || '',
      originalTitle: row.original_title || '',
      overview: row.overview || '',
      tagline: row.tagline || '',
      releaseDate,
      runtime: num(row.runtime),
      voteAverage: num(row.vote_average),
      voteCount: num(row.vote_count),
      popularity: num(row.popularity),
      genres: genreList,
      genreNames,
      keywordNames: keywordNamesFromRow(row.keywords),
      castPreview: castPreview(cred.cast),
      castNames: topCastNames(cred.cast),
      directorNames: directorsFromCrew(cred.crew),
      homepage: row.homepage || '',
      status: row.status || '',
      budget: num(row.budget),
      revenue: num(row.revenue),
      originalLanguage: row.original_language || '',
    });
  }

  const embeddingDim = getEmbeddingDim();

  await withClient(async (client) => {
    await client.query('begin');
    try {
      await client.query(ddlSql({ embeddingDim }));

      const { rows } = await client.query('select count(*)::int as count from movies');
      const count = rows?.[0]?.count ?? 0;
      if (count > 0 && !force) {
        console.log(
          `Seed ignorado: já existem ${count} filmes (FORCE_SEED=1 para recriar).`
        );
        await client.query('commit');
        return;
      }

      if (force && count > 0) {
        await client.query('truncate table movies');
        console.log('Tabela limpa (FORCE_SEED).');
      }

      console.log(`Gerando embeddings e inserindo ${docs.length} filmes…`);

      const batchSize = Math.max(1, Math.min(Number(process.env.SEED_BATCH_SIZE) || 32, 256));
      for (let i = 0; i < docs.length; i += batchSize) {
        const batch = docs.slice(i, i + batchSize);
        const texts = batch.map(docTextForEmbedding);
        const embeddings = await embedMany(texts);

        for (let j = 0; j < batch.length; j++) {
          const d = batch[j];
          const emb = embeddings[j];
          if (emb && emb.length !== embeddingDim) {
            throw new Error(
              `Embedding com dimensão ${emb.length}, esperado ${embeddingDim} (tmdbId=${d.tmdbId})`
            );
          }
          const vectorLiteral = toVectorLiteral(emb);

          await client.query(
            `
INSERT INTO movies (
  tmdb_id,
  title,
  original_title,
  overview,
  tagline,
  release_date,
  runtime,
  vote_average,
  vote_count,
  popularity,
  genres_json,
  genre_names,
  keyword_names,
  cast_preview_json,
  cast_names,
  director_names,
  homepage,
  status,
  budget,
  revenue,
  original_language,
  embedding
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
  CASE WHEN $22::text IS NULL THEN NULL ELSE $22::vector END
)
ON CONFLICT (tmdb_id) DO UPDATE SET
  title = EXCLUDED.title,
  original_title = EXCLUDED.original_title,
  overview = EXCLUDED.overview,
  tagline = EXCLUDED.tagline,
  release_date = EXCLUDED.release_date,
  runtime = EXCLUDED.runtime,
  vote_average = EXCLUDED.vote_average,
  vote_count = EXCLUDED.vote_count,
  popularity = EXCLUDED.popularity,
  genres_json = EXCLUDED.genres_json,
  genre_names = EXCLUDED.genre_names,
  keyword_names = EXCLUDED.keyword_names,
  cast_preview_json = EXCLUDED.cast_preview_json,
  cast_names = EXCLUDED.cast_names,
  director_names = EXCLUDED.director_names,
  homepage = EXCLUDED.homepage,
  status = EXCLUDED.status,
  budget = EXCLUDED.budget,
  revenue = EXCLUDED.revenue,
  original_language = EXCLUDED.original_language,
  embedding = EXCLUDED.embedding,
  updated_at = now()
            `,
            [
              d.tmdbId,
              d.title,
              d.originalTitle || null,
              d.overview || null,
              d.tagline || null,
              d.releaseDate ? new Date(d.releaseDate).toISOString().slice(0, 10) : null,
              d.runtime ?? null,
              d.voteAverage ?? null,
              d.voteCount ?? null,
              d.popularity ?? null,
              JSON.stringify(d.genres ?? []),
              d.genreNames || null,
              d.keywordNames || null,
              JSON.stringify(d.castPreview ?? []),
              d.castNames || null,
              d.directorNames || null,
              d.homepage || null,
              d.status || null,
              d.budget ?? null,
              d.revenue ?? null,
              d.originalLanguage || null,
              vectorLiteral,
            ]
          );
        }

        if ((i / batchSize) % 10 === 0) {
          console.log(`... ${Math.min(i + batchSize, docs.length)}/${docs.length}`);
        }
      }

      console.log('Seed concluído.');
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
