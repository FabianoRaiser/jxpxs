function normalizeBaseUrl(raw) {
  const u = String(raw || '').trim().replace(/\/+$/, '');
  return u;
}

function embeddingsUrl(baseUrl) {
  // LM Studio e vários servidores locais expõem API compatível com OpenAI em /v1/embeddings
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/v1')) return `${base}/embeddings`;
  if (base.includes('/v1/embeddings')) return base;
  return `${base}/v1/embeddings`;
}

export async function embedMany(texts) {
  const baseUrl = process.env.EMBEDDINGS_BASE_URL;
  const model = process.env.EMBEDDINGS_MODEL;
  if (!baseUrl) {
    return texts.map(() => null);
  }
  if (!model) {
    throw new Error('EMBEDDINGS_MODEL não definido');
  }

  const url = embeddingsUrl(baseUrl);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Falha no endpoint de embeddings (${resp.status}): ${body}`);
  }

  const json = await resp.json();
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data || data.length !== texts.length) {
    throw new Error('Resposta de embeddings inesperada (json.data inválido)');
  }

  return data.map((d) => (Array.isArray(d?.embedding) ? d.embedding : null));
}

