export function getEmbeddingDim() {
  const raw = process.env.EMBEDDINGS_DIM ?? '768';
  const dim = Number(raw);
  if (!Number.isFinite(dim) || dim <= 0) {
    throw new Error(`EMBEDDINGS_DIM inválido: ${raw}`);
  }
  return dim;
}

export function ddlSql({ embeddingDim }) {
  return `
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION
    WHEN duplicate_object OR unique_violation THEN
      -- Em algumas condições raras, o catálogo pode acusar duplicidade mesmo com IF NOT EXISTS.
      -- Se já existir, seguimos.
      NULL;
  END;
END $$;

CREATE TABLE IF NOT EXISTS movies (
  tmdb_id            integer PRIMARY KEY,
  title              text NOT NULL,
  original_title     text,
  overview           text,
  tagline            text,
  release_date       date,
  runtime            integer,
  vote_average       double precision,
  vote_count         integer,
  popularity         double precision,
  genres_json        jsonb,
  genre_names        text,
  keyword_names      text,
  cast_preview_json  jsonb,
  cast_names         text,
  director_names     text,
  homepage           text,
  status             text,
  budget             double precision,
  revenue            double precision,
  original_language  text,
  embedding          vector(${embeddingDim}),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS movies_title_idx ON movies (title);
CREATE INDEX IF NOT EXISTS movies_release_date_idx ON movies (release_date DESC);
CREATE INDEX IF NOT EXISTS movies_popularity_idx ON movies (popularity DESC);
CREATE INDEX IF NOT EXISTS movies_vote_average_idx ON movies (vote_average DESC);

-- Índice vetorial (pgvector). HNSW é mais rápido, mas pode não estar disponível em todas as versões.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS movies_embedding_hnsw_idx ON movies USING hnsw (embedding vector_cosine_ops)';
  EXCEPTION WHEN undefined_object OR feature_not_supported THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS movies_embedding_ivfflat_idx ON movies USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  END;
END $$;
`;
}

