export type SuggestItem = {
  id: number;
  title: string;
  originalTitle?: string;
  releaseDate?: string;
  voteAverage?: number;
  subtitle?: string;
};

export type SearchMode = 'auto' | 'text' | 'semantic';

export async function fetchSuggest(
  q: string,
  opts?: { mode?: SearchMode; limit?: number }
): Promise<SuggestItem[]> {
  const u = new URL('/api/movies/suggest', globalThis.location?.origin ?? 'http://localhost');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', String(opts?.limit ?? 15));
  if (opts?.mode && opts.mode !== 'auto') u.searchParams.set('mode', opts.mode);
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('Falha na sugestão');
  const j = (await r.json()) as { items: SuggestItem[] };
  return j.items ?? [];
}

export type MovieListItem = {
  tmdbId: number;
  title: string;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  releaseDate?: string;
  runtime?: number;
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
  genres?: { id: number; name: string }[];
  genreNames?: string;
  keywordNames?: string;
  castNames?: string;
  directorNames?: string;
  castPreview?: { name?: string; character?: string }[];
  homepage?: string;
  status?: string;
  budget?: number;
  revenue?: number;
  originalLanguage?: string;
};


export async function fetchMovies(params: {
  page: number;
  pageSize: number;
  sort: string;
}): Promise<{ items: MovieListItem[]; total: number }> {
  const u = new URL('/api/movies', globalThis.location?.origin ?? 'http://localhost');
  u.searchParams.set('page', String(params.page));
  u.searchParams.set('pageSize', String(params.pageSize));
  u.searchParams.set('sort', params.sort);
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('Falha ao listar');
  return r.json();
}

export async function fetchSearch(params: {
  q: string;
  page: number;
  pageSize: number;
  mode?: SearchMode;
}): Promise<{ items: MovieListItem[]; total: number }> {
  const u = new URL('/api/movies/search', globalThis.location?.origin ?? 'http://localhost');
  u.searchParams.set('q', params.q);
  u.searchParams.set('page', String(params.page));
  u.searchParams.set('pageSize', String(params.pageSize));
  if (params.mode && params.mode !== 'auto') u.searchParams.set('mode', params.mode);
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error('Falha na busca');
  return r.json();
}

export async function fetchMovieById(tmdbId: number): Promise<MovieListItem> {
  const r = await fetch(`/api/movies/${tmdbId}`);
  if (r.status === 404) throw new Error('Filme não encontrado');
  if (!r.ok) throw new Error('Falha ao carregar filme');
  return r.json() as Promise<MovieListItem>;
}
