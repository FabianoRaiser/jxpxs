import express from 'express';
import { withClient } from '../db/postgres.js';
import { embedMany } from '../embeddings/client.js';
import { getEmbeddingDim } from '../db/schema.js';

const router = express.Router();

function toMovieRow(r) {
  return {
    tmdbId: r.tmdb_id,
    title: r.title,
    originalTitle: r.original_title,
    overview: r.overview,
    tagline: r.tagline,
    releaseDate: r.release_date,
    runtime: r.runtime,
    voteAverage: r.vote_average,
    voteCount: r.vote_count,
    popularity: r.popularity,
    genres: r.genres_json ?? [],
    genreNames: r.genre_names,
    keywordNames: r.keyword_names,
    castPreview: r.cast_preview_json ?? [],
    castNames: r.cast_names,
    directorNames: r.director_names,
    homepage: r.homepage,
    status: r.status,
    budget: r.budget,
    revenue: r.revenue,
    originalLanguage: r.original_language,
  };
}

function toSuggestItem(r) {
  return {
    id: r.tmdb_id,
    title: r.title,
    originalTitle: r.original_title,
    releaseDate: r.release_date,
    voteAverage: r.vote_average,
    subtitle:
      [r.director_names, r.genre_names].filter(Boolean).join(' · ') || r.tagline || '',
  };
}

function toVectorLiteral(vec) {
  if (!Array.isArray(vec)) return null;
  return `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}

async function embedQuery(q) {
  const embeddingDim = getEmbeddingDim();
  const [emb] = await embedMany([q]);
  if (!emb) return null;
  if (emb.length !== embeddingDim) {
    throw new Error(`Embedding com dimensão ${emb.length}, esperado ${embeddingDim}`);
  }
  return toVectorLiteral(emb);
}

router.get('/suggest', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit) || 12, 30);
  const mode = String(req.query.mode || '').trim().toLowerCase();

  if (!q) {
    return res.json({ items: [] });
  }

  try {
    const useSemantic = mode === 'semantic' || (mode !== 'text' && q.length >= 6);

    const items = await withClient(async (client) => {
      if (useSemantic) {
        const vec = await embedQuery(q);
        if (vec) {
          const { rows } = await client.query(
            `
SELECT tmdb_id, title, original_title, release_date, vote_average, tagline, genre_names, director_names
FROM movies
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $2
            `,
            [vec, limit]
          );
          if (rows.length > 0) return rows.map(toSuggestItem);
        }
      }

      if (q.length >= 2) {
        const { rows } = await client.query(
          `
SELECT
  tmdb_id, title, original_title, release_date, vote_average, tagline, genre_names, director_names,
  ts_rank(
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(original_title,'') || ' ' || coalesce(tagline,'') || ' ' || coalesce(genre_names,'') || ' ' || coalesce(director_names,'')),
    plainto_tsquery('simple', $1)
  ) as rank
FROM movies
WHERE to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(original_title,'') || ' ' || coalesce(tagline,'') || ' ' || coalesce(genre_names,'') || ' ' || coalesce(director_names,''))
  @@ plainto_tsquery('simple', $1)
ORDER BY rank DESC
LIMIT $2
          `,
          [q, limit]
        );
        if (rows.length > 0) return rows.map(toSuggestItem);
      }

      const qLike = `%${q}%`;
      const qPrefix = `${q}%`;
      const { rows } = await client.query(
        `
SELECT tmdb_id, title, original_title, release_date, vote_average, tagline, genre_names, director_names, popularity,
  CASE WHEN title ILIKE $2 OR original_title ILIKE $2 THEN 0 ELSE 1 END as prefix_rank
FROM movies
WHERE title ILIKE $1 OR original_title ILIKE $1
ORDER BY prefix_rank ASC, popularity DESC NULLS LAST
LIMIT $3
        `,
        [qLike, qPrefix, limit]
      );
      return rows.map(toSuggestItem);
    });

    return res.json({ items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro na sugestão' });
  }
});

router.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 24), 100);
  const mode = String(req.query.mode || '').trim().toLowerCase();

  if (!q) {
    return res.json({ items: [], total: 0, page, pageSize });
  }

  try {
    const out = await withClient(async (client) => {
      const useSemantic = mode === 'semantic';

      if (useSemantic) {
        const vec = await embedQuery(q);
        if (!vec) {
          return { items: [], total: 0, page, pageSize, mode: 'semantic' };
        }

        const totalRes = await client.query(
          `select count(*)::int as count from movies where embedding is not null`
        );
        const total = totalRes.rows?.[0]?.count ?? 0;

        const { rows } = await client.query(
          `
SELECT *
FROM movies
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
OFFSET $2
LIMIT $3
          `,
          [vec, (page - 1) * pageSize, pageSize]
        );
        return { items: rows.map((r) => toMovieRow(r)), total, page, pageSize, mode: 'semantic' };
      }

      // modo text (full-text do Postgres)
      const qTs = q;
      const totalRes = await client.query(
        `
SELECT count(*)::int as count
FROM movies
WHERE to_tsvector('simple',
  coalesce(title,'') || ' ' ||
  coalesce(original_title,'') || ' ' ||
  coalesce(tagline,'') || ' ' ||
  coalesce(overview,'') || ' ' ||
  coalesce(genre_names,'') || ' ' ||
  coalesce(keyword_names,'') || ' ' ||
  coalesce(cast_names,'') || ' ' ||
  coalesce(director_names,'')
) @@ plainto_tsquery('simple', $1)
        `,
        [qTs]
      );
      const total = totalRes.rows?.[0]?.count ?? 0;

      if (total > 0) {
        const { rows } = await client.query(
          `
SELECT *,
  ts_rank(
    to_tsvector('simple',
      coalesce(title,'') || ' ' ||
      coalesce(original_title,'') || ' ' ||
      coalesce(tagline,'') || ' ' ||
      coalesce(overview,'') || ' ' ||
      coalesce(genre_names,'') || ' ' ||
      coalesce(keyword_names,'') || ' ' ||
      coalesce(cast_names,'') || ' ' ||
      coalesce(director_names,'')
    ),
    plainto_tsquery('simple', $1)
  ) as rank
FROM movies
WHERE to_tsvector('simple',
  coalesce(title,'') || ' ' ||
  coalesce(original_title,'') || ' ' ||
  coalesce(tagline,'') || ' ' ||
  coalesce(overview,'') || ' ' ||
  coalesce(genre_names,'') || ' ' ||
  coalesce(keyword_names,'') || ' ' ||
  coalesce(cast_names,'') || ' ' ||
  coalesce(director_names,'')
) @@ plainto_tsquery('simple', $1)
ORDER BY rank DESC
OFFSET $2
LIMIT $3
          `,
          [qTs, (page - 1) * pageSize, pageSize]
        );
        return { items: rows.map(toMovieRow), total, page, pageSize, mode: 'text' };
      }

      // fallback: ILIKE
      const qLike = `%${q}%`;
      const totalAltRes = await client.query(
        `
SELECT count(*)::int as count
FROM movies
WHERE
  title ILIKE $1 OR original_title ILIKE $1 OR overview ILIKE $1 OR tagline ILIKE $1 OR
  genre_names ILIKE $1 OR keyword_names ILIKE $1 OR cast_names ILIKE $1 OR director_names ILIKE $1
        `,
        [qLike]
      );
      const altTotal = totalAltRes.rows?.[0]?.count ?? 0;
      const { rows } = await client.query(
        `
SELECT *
FROM movies
WHERE
  title ILIKE $1 OR original_title ILIKE $1 OR overview ILIKE $1 OR tagline ILIKE $1 OR
  genre_names ILIKE $1 OR keyword_names ILIKE $1 OR cast_names ILIKE $1 OR director_names ILIKE $1
ORDER BY popularity DESC NULLS LAST
OFFSET $2
LIMIT $3
        `,
        [qLike, (page - 1) * pageSize, pageSize]
      );
      return { items: rows.map(toMovieRow), total: altTotal, page, pageSize, mode: 'fallback' };
    });

    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro na busca' });
  }
});

router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(req.query.pageSize) || 48), 200);
  const sort = String(req.query.sort || 'releaseDate');

  const sortMap = {
    releaseDate: 'release_date desc nulls last, title asc',
    title: 'title asc',
    popularity: 'popularity desc nulls last, title asc',
    voteAverage: 'vote_average desc nulls last, vote_count desc nulls last',
  };
  const sortSql = sortMap[sort] || sortMap.releaseDate;

  try {
    const out = await withClient(async (client) => {
      const totalRes = await client.query('select count(*)::int as count from movies');
      const total = totalRes.rows?.[0]?.count ?? 0;

      const { rows } = await client.query(
        `
SELECT *
FROM movies
ORDER BY ${sortSql}
OFFSET $1
LIMIT $2
        `,
        [(page - 1) * pageSize, pageSize]
      );

      return { items: rows.map(toMovieRow), total, page, pageSize };
    });
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao listar filmes' });
  }
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }

  try {
    const doc = await withClient(async (client) => {
      const { rows } = await client.query('select * from movies where tmdb_id = $1', [id]);
      return rows[0] || null;
    });

    if (!doc) return res.status(404).json({ error: 'Filme não encontrado' });
    return res.json(toMovieRow(doc));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Erro ao carregar filme' });
  }
});

export default router;
