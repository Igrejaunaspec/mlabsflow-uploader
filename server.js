/**
 * mLabsFlow Uploader — large-file relay for mLabs Flow
 * ------------------------------------------------------------------
 * Cloudflare Workers (free plan) refuses any request body over 100MB,
 * which is too small for full-length church video files. This small
 * service exists ONLY to receive those large uploads, over HTTP/2
 * (Cloud Run's 32MB request cap only applies to HTTP/1), and then:
 *
 *   - For Instagram media: streams the file straight to the SAME R2
 *     bucket the Worker already uses (via R2's S3-compatible API), and
 *     returns the same { ok, key, url } shape the Worker's
 *     /api/instagram/upload-media returns — so the rest of the
 *     Instagram flow (container creation, publish, scheduling) keeps
 *     running unchanged on the Worker.
 *
 *   - For YouTube: fetches/refreshes the channel's OAuth token from
 *     the SAME D1 database (via D1's HTTP API, since this service
 *     doesn't run inside a Worker and can't use the D1 binding), then
 *     forwards the video to YouTube's upload API exactly like the
 *     Worker's /api/youtube/upload does.
 *
 * Nothing else moves. The Kanban board, accounts, and every
 * small-payload route stay on the Cloudflare Worker.
 *
 * Required environment variables (see .env.example):
 *   PORT                    - set automatically by Cloud Run
 *   FRONTEND_URL             - https://igrejaunaspec.github.io/mlabs-flow/
 *   WORKER_PUBLIC_URL         - https://mlabsflow-youtube.diretor-unasp.workers.dev
 *   CF_ACCOUNT_ID
 *   CF_D1_DATABASE_ID
 *   CF_D1_API_TOKEN           - Cloudflare API token, scoped to D1 edit on this DB only
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME            - mlabsflow-instagram-media
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 */

const fastify = require('fastify')({
  http2: true,
  bodyLimit: 1024 * 1024 * 1024, // 1GB safety ceiling (Instagram Reels cap out at 300MB)
});
const cors = require('@fastify/cors');
const multipart = require('@fastify/multipart');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const {
  PORT = 8080,
  FRONTEND_URL,
  WORKER_PUBLIC_URL,
  CF_ACCOUNT_ID,
  CF_D1_DATABASE_ID,
  CF_D1_API_TOKEN,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} = process.env;

function assertEnv() {
  const required = {
    CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_D1_API_TOKEN,
    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, WORKER_PUBLIC_URL,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error('Missing required environment variables:', missing.join(', '));
  }
}
assertEnv();

// ---------- D1 HTTP API (stands in for the env.DB binding a Worker gets for free) ----------

async function d1Query(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_D1_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.success) {
    throw new Error('D1 query failed: ' + JSON.stringify(data.errors || data));
  }
  // Cloudflare's D1 HTTP API returns an array of results (one per statement);
  // we only ever send one statement at a time.
  return data.result[0];
}

async function d1First(sql, params = []) {
  const r = await d1Query(sql, params);
  return (r.results && r.results[0]) || null;
}

async function d1Run(sql, params = []) {
  return d1Query(sql, params);
}

// ---------- R2 (S3-compatible) ----------

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ---------- YouTube OAuth (mirrors the Worker's getValidAccessToken) ----------

async function getValidAccessToken(userId) {
  const row = await d1First(
    'SELECT access_token, refresh_token, expires_at FROM youtube_accounts WHERE id = ?',
    [userId]
  );
  if (!row) return null;

  if (row.expires_at && row.expires_at > Date.now() + 60_000) {
    return row.access_token;
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) return null;
  const tokens = await resp.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  await d1Run(
    'UPDATE youtube_accounts SET access_token = ?, expires_at = ?, updated_at = ? WHERE id = ?',
    [tokens.access_token, expiresAt, Date.now(), userId]
  );

  return tokens.access_token;
}

// ---------- Fastify setup ----------

fastify.register(cors, {
  origin: (origin, cb) => {
    // Same "reflect the caller's origin" posture as the Worker's corsHeaders —
    // these endpoints don't use cookies, so this is safe.
    cb(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
});

fastify.register(multipart, {
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB per file
  },
});

fastify.get('/', async () => ({ ok: true, service: 'mlabsflow-uploader' }));

// ---------- POST /api/instagram/upload-media ----------
// Same contract as the Worker's route of the same name: field "media" -> { ok, key, url }

fastify.post('/api/instagram/upload-media', async (request, reply) => {
  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ error: 'Nenhum arquivo de mídia enviado.' });
  }

  const rawExt = file.filename && file.filename.includes('.') ? file.filename.split('.').pop() : '';
  const ext = (rawExt || (file.mimetype || '').split('/')[1] || 'bin').replace(/[^a-zA-Z0-9]/g, '');
  const key = `${Date.now()}-${cryptoRandomUUID()}.${ext}`;

  try {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: file.file, // streamed, not buffered — safe for large videos
        ContentType: file.mimetype || 'application/octet-stream',
      },
    });
    await upload.done();
  } catch (err) {
    request.log.error(err);
    return reply.code(502).send({ error: 'Falha ao enviar a mídia para o armazenamento.', details: String(err.message || err) });
  }

  const url = `${WORKER_PUBLIC_URL}/media/${key}`;
  return { ok: true, key, url };
});

// ---------- POST /api/youtube/upload ----------
// Same contract as the Worker's route of the same name.

fastify.post('/api/youtube/upload', async (request, reply) => {
  const parts = request.parts();
  let userId = 'default';
  let title = 'Sem título';
  let description = '';
  let privacyStatus = 'private';
  let publishAt = null;
  let videoBuffer = null;
  let videoMime = 'video/*';

  for await (const part of parts) {
    if (part.type === 'file' && part.fieldname === 'video') {
      videoMime = part.mimetype || 'video/*';
      videoBuffer = await part.toBuffer();
    } else if (part.type === 'field') {
      const v = part.value;
      if (part.fieldname === 'userId') userId = v || 'default';
      else if (part.fieldname === 'title') title = v || 'Sem título';
      else if (part.fieldname === 'description') description = v || '';
      else if (part.fieldname === 'privacyStatus') privacyStatus = v || 'private';
      else if (part.fieldname === 'publishAt') publishAt = v || null;
    }
  }

  if (!videoBuffer) {
    return reply.code(400).send({ error: 'Nenhum arquivo de vídeo enviado.' });
  }

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    return reply.code(401).send({ error: 'Canal do YouTube não conectado.' });
  }

  const status = { privacyStatus };
  if (publishAt) {
    status.privacyStatus = 'private';
    status.publishAt = new Date(publishAt).toISOString();
  }

  const metadata = { snippet: { title, description, categoryId: '22' }, status };

  const boundary = 'mlabsflow' + cryptoRandomUUID().replace(/-/g, '');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${videoMime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, videoBuffer, tail]);

  let uploadResp;
  try {
    uploadResp = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
  } catch (err) {
    request.log.error(err);
    return reply.code(502).send({ error: 'Falha ao conectar com o YouTube.', details: String(err.message || err) });
  }

  const result = await uploadResp.json();
  if (!uploadResp.ok) {
    return reply.code(uploadResp.status).send({ error: 'Falha no upload para o YouTube.', details: result });
  }

  return { ok: true, videoId: result.id, url: `https://youtube.com/watch?v=${result.id}` };
});

function cryptoRandomUUID() {
  // Node 20 has crypto.randomUUID() globally under `crypto`, but keep this
  // explicit so the module works even if that global is ever unavailable.
  return require('crypto').randomUUID();
}

fastify
  .listen({ port: Number(PORT), host: '0.0.0.0' })
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`mlabsflow-uploader listening on ${address}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
