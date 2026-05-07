import type { Bindings, GalleryEntry, GenerateJob, GenerateJobInput } from "./types";

const STALE_RUNNING_MS = 90_000;
const JOB_RETENTION_HOURS = 1;

export async function saveJob(env: Bindings, job: GenerateJob, input?: GenerateJobInput): Promise<void> {
  const payload = input ? JSON.stringify(input) : null;
  const result = job.result ? JSON.stringify(job.result) : null;
  const clearPayload = job.status === "success" || job.status === "error";
  const payloadExpr = clearPayload ? "NULL" : "COALESCE(excluded.payload, jobs.payload)";
  await env.DB.prepare(
    `INSERT INTO jobs (id, status, created_at, updated_at, prompt, owner_id, payload, result, detail)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=CASE WHEN jobs.status = 'error' AND jobs.detail = 'cancelled' THEN jobs.status ELSE excluded.status END,
       updated_at=CASE WHEN jobs.status = 'error' AND jobs.detail = 'cancelled' THEN jobs.updated_at ELSE excluded.updated_at END,
       prompt=excluded.prompt,
       result=CASE WHEN jobs.status = 'error' AND jobs.detail = 'cancelled' THEN jobs.result ELSE COALESCE(excluded.result, jobs.result) END,
       detail=CASE WHEN jobs.status = 'error' AND jobs.detail = 'cancelled' THEN jobs.detail ELSE COALESCE(excluded.detail, jobs.detail) END,
       payload=CASE WHEN jobs.status = 'error' AND jobs.detail = 'cancelled' THEN NULL ELSE ${payloadExpr} END`,
  )
    .bind(job.id, job.status, job.created_at, job.updated_at, job.prompt, job.owner_id ?? null, payload, result, job.detail ?? null)
    .run();
}

function rowToJob(row: Record<string, unknown> | null): GenerateJob | null {
  if (!row) return null;
  let producedIds: string[] | undefined;
  if (row.produced_ids) {
    try {
      const parsed = JSON.parse(String(row.produced_ids));
      if (Array.isArray(parsed)) producedIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  return {
    id: String(row.id),
    status: String(row.status) as GenerateJob["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    prompt: String(row.prompt),
    owner_id: row.owner_id ? String(row.owner_id) : undefined,
    result: row.result ? JSON.parse(String(row.result)) : undefined,
    detail: row.detail ? String(row.detail) : undefined,
    produced_ids: producedIds,
  };
}

export async function getJob(env: Bindings, id: string): Promise<GenerateJob | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, created_at, updated_at, prompt, owner_id, result, detail, produced_ids FROM jobs WHERE id = ?`,
  )
    .bind(id)
    .first();
  return rowToJob(row as Record<string, unknown> | null);
}

export async function appendProducedId(env: Bindings, jobId: string, galleryId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs
       SET produced_ids = json(
             CASE
               WHEN produced_ids IS NULL OR produced_ids = '' THEN json_array(?1)
               ELSE json_insert(produced_ids, '$[#]', ?1)
             END
           ),
           updated_at = ?2
     WHERE id = ?3`,
  )
    .bind(galleryId, now, jobId)
    .run();
}

export async function listProducedEntries(env: Bindings, producedIds: string[]): Promise<GalleryEntry[]> {
  if (producedIds.length === 0) return [];
  const placeholders = producedIds.map(() => "?").join(",");
  const rs = await env.DB.prepare(`SELECT * FROM gallery WHERE id IN (${placeholders})`)
    .bind(...producedIds)
    .all();
  const order = new Map(producedIds.map((id, idx) => [id, idx]));
  const rows = (rs.results ?? [])
    .map((r) => rowToEntry(r as Record<string, unknown>))
    .filter((e): e is GalleryEntry => e !== null);
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return rows;
}

export async function listPendingJobIds(env: Bindings, limit = 25): Promise<string[]> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const rs = await env.DB.prepare(
    `SELECT id FROM jobs
       WHERE status = 'queued'
          OR (status = 'running' AND updated_at < ?)
       ORDER BY created_at ASC
       LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all();
  return (rs.results ?? []).map((r) => String((r as { id: unknown }).id));
}

export async function getPendingJobInput(env: Bindings, jobId: string): Promise<GenerateJobInput | null> {
  const row = await env.DB.prepare(`SELECT payload FROM jobs WHERE id = ?`).bind(jobId).first();
  if (!row) return null;
  const payload = (row as { payload: string | null }).payload;
  if (!payload) return null;
  return JSON.parse(payload) as GenerateJobInput;
}

export async function deletePendingJob(env: Bindings, jobId: string): Promise<void> {
  await env.DB.prepare(`UPDATE jobs SET payload = NULL WHERE id = ?`).bind(jobId).run();
}

export async function tryClaimJob(env: Bindings, jobId: string): Promise<GenerateJob | null> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', updated_at = ?
       WHERE id = ?
         AND (status = 'queued' OR (status = 'running' AND updated_at < ?))
       RETURNING id, status, created_at, updated_at, prompt, owner_id, result, detail, produced_ids`,
  )
    .bind(now, jobId, cutoff)
    .first();
  return rowToJob(updated as Record<string, unknown> | null);
}

export async function pruneOldJobs(env: Bindings): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`DELETE FROM jobs WHERE created_at < ?`).bind(cutoff).run();
}

export interface ActiveJob {
  id: string;
  status: "queued" | "running";
  created_at: string;
  updated_at: string;
  prompt: string;
  owner_id?: string;
  payload: GenerateJobInput | null;
}

export async function listActiveJobs(env: Bindings, ownerId?: string): Promise<ActiveJob[]> {
  const params: unknown[] = [];
  let where = `status IN ('queued', 'running')`;
  if (ownerId !== undefined) {
    where += ` AND owner_id = ?`;
    params.push(ownerId);
  }
  const rs = await env.DB.prepare(
    `SELECT id, status, created_at, updated_at, prompt, owner_id, payload
       FROM jobs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT 100`,
  )
    .bind(...params)
    .all();
  return (rs.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    let payload: GenerateJobInput | null = null;
    if (row.payload) {
      try {
        payload = JSON.parse(String(row.payload)) as GenerateJobInput;
      } catch {}
    }
    return {
      id: String(row.id),
      status: String(row.status) as "queued" | "running",
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      prompt: String(row.prompt),
      owner_id: row.owner_id ? String(row.owner_id) : undefined,
      payload,
    };
  });
}

export async function cancelGenerateJob(
  env: Bindings,
  id: string,
  ownerId?: string,
): Promise<{ status: "cancelled" | "not_found" | "already_finished" | "forbidden"; job?: GenerateJob }> {
  const job = await getJob(env, id);
  if (!job) return { status: "not_found" };
  if (job.status === "success" || job.status === "error") {
    return { status: "already_finished", job };
  }
  if (ownerId !== undefined && job.owner_id && job.owner_id !== ownerId) {
    return { status: "forbidden" };
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs
       SET status = 'error',
           detail = 'cancelled',
           payload = NULL,
           updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
  )
    .bind(now, id)
    .run();
  return { status: "cancelled", job: { ...job, status: "error", detail: "cancelled", updated_at: now } };
}

const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export async function pruneOrphanImages(env: Bindings): Promise<{ scanned: number; deleted: number }> {
  const now = Date.now();
  let scanned = 0;
  let deleted = 0;
  let cursor: string | undefined = undefined;

  while (true) {
    const list: R2Objects = await env.IMAGES.list({ limit: 1000, cursor });
    scanned += list.objects.length;

    const candidates = list.objects.filter((obj) => {
      const uploaded = obj.uploaded?.getTime() ?? 0;
      return uploaded > 0 && (now - uploaded) > ORPHAN_GRACE_MS;
    });

    if (candidates.length > 0) {
      const filenames = candidates.map((o) => o.key);
      const known = new Set<string>();
      for (let i = 0; i < filenames.length; i += 100) {
        const chunk = filenames.slice(i, i + 100);
        const placeholders = chunk.map(() => "?").join(",");
        const rs = await env.DB.prepare(
          `SELECT filename FROM gallery WHERE filename IN (${placeholders})`,
        )
          .bind(...chunk)
          .all();
        for (const row of rs.results ?? []) {
          known.add(String((row as { filename: unknown }).filename));
        }
      }
      const orphans = filenames.filter((f) => !known.has(f));
      if (orphans.length > 0) {
        for (let i = 0; i < orphans.length; i += 1000) {
          await env.IMAGES.delete(orphans.slice(i, i + 1000));
        }
        deleted += orphans.length;
      }
    }

    if (list.truncated && list.cursor) {
      cursor = list.cursor;
    } else {
      break;
    }
  }

  return { scanned, deleted };
}

export function generateImageId(): string {
  return crypto.randomUUID();
}

export async function saveImage(
  env: Bindings,
  filename: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await env.IMAGES.put(filename, bytes, {
    httpMetadata: { contentType },
  });
}

export async function getImage(
  env: Bindings,
  filename: string,
): Promise<R2ObjectBody | null> {
  return env.IMAGES.get(filename);
}

export async function deleteImage(env: Bindings, filename: string): Promise<void> {
  await env.IMAGES.delete(filename);
}

function rowToEntry(row: Record<string, unknown> | null): GalleryEntry | null {
  if (!row) return null;
  return {
    id: String(row.id),
    filename: String(row.filename),
    prompt: String(row.prompt),
    size: String(row.size),
    created_at: String(row.created_at),
    model: row.model ? String(row.model) : undefined,
    quality: row.quality ? String(row.quality) : undefined,
    output_format: row.output_format ? String(row.output_format) : undefined,
    output_compression: row.output_compression !== null && row.output_compression !== undefined
      ? Number(row.output_compression)
      : null,
    response_format: row.response_format ? String(row.response_format) : undefined,
    n: row.n !== null && row.n !== undefined ? Number(row.n) : undefined,
    api_path: row.api_path ? String(row.api_path) : undefined,
    api_preset_name: row.api_preset_name ? String(row.api_preset_name) : undefined,
    image_width: row.image_width !== null && row.image_width !== undefined ? Number(row.image_width) : null,
    image_height: row.image_height !== null && row.image_height !== undefined ? Number(row.image_height) : null,
    duration: row.duration ? String(row.duration) : undefined,
    is_public: Number(row.is_public) === 1,
    has_reference: Number(row.has_reference) === 1,
    owner_id: row.owner_id ? String(row.owner_id) : undefined,
  };
}

export async function addToGallery(
  env: Bindings,
  entry: GalleryEntry,
): Promise<GalleryEntry> {
  await env.DB.prepare(
    `INSERT INTO gallery (id, filename, prompt, size, created_at, model, quality, output_format, output_compression, response_format, n, api_path, api_preset_name, image_width, image_height, duration, is_public, has_reference, owner_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      entry.id,
      entry.filename,
      entry.prompt,
      entry.size,
      entry.created_at,
      entry.model ?? null,
      entry.quality ?? null,
      entry.output_format ?? null,
      entry.output_compression ?? null,
      entry.response_format ?? null,
      entry.n ?? null,
      entry.api_path ?? null,
      entry.api_preset_name ?? null,
      entry.image_width ?? null,
      entry.image_height ?? null,
      entry.duration ?? null,
      entry.is_public ? 1 : 0,
      entry.has_reference ? 1 : 0,
      entry.owner_id ?? null,
    )
    .run();
  return entry;
}

export async function updateGalleryEntry(
  env: Bindings,
  id: string,
  updates: { duration?: string },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.duration !== undefined) {
    sets.push("duration = ?");
    params.push(updates.duration);
  }
  if (sets.length === 0) return;
  params.push(id);
  await env.DB.prepare(`UPDATE gallery SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
}

export async function deleteAllGallery(env: Bindings): Promise<{ deleted_entries: number; deleted_images: number }> {
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM gallery`).first();
  const deletedEntries = Number((totalRow as { n: number } | null)?.n ?? 0);

  await env.DB.prepare(`DELETE FROM gallery`).run();

  let deletedImages = 0;
  let cursor: string | undefined = undefined;
  while (true) {
    const list: R2Objects = await env.IMAGES.list({ limit: 1000, cursor });
    if (list.objects.length > 0) {
      const keys = list.objects.map((o) => o.key);
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        await env.IMAGES.delete(chunk);
        deletedImages += chunk.length;
      }
    }
    if (list.truncated && list.cursor) {
      cursor = list.cursor;
    } else {
      break;
    }
  }

  return { deleted_entries: deletedEntries, deleted_images: deletedImages };
}

export async function getEntry(env: Bindings, id: string): Promise<GalleryEntry | null> {
  const row = await env.DB.prepare(`SELECT * FROM gallery WHERE id = ?`).bind(id).first();
  return rowToEntry(row as Record<string, unknown> | null);
}

export async function getEntryByFilename(
  env: Bindings,
  filename: string,
): Promise<GalleryEntry | null> {
  const row = await env.DB.prepare(`SELECT * FROM gallery WHERE filename = ?`).bind(filename).first();
  return rowToEntry(row as Record<string, unknown> | null);
}

export interface GalleryPage {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_prev: boolean;
  has_next: boolean;
  images: GalleryEntry[];
}

export interface GalleryPageOptions {
  page: number;
  pageSize: number;
  includeAllPrivate?: boolean;
  ownerId?: string;
}

export async function getGalleryPage(
  env: Bindings,
  options: GalleryPageOptions,
): Promise<GalleryPage> {
  let where: string;
  const params: unknown[] = [];
  if (options.includeAllPrivate) {
    where = "1 = 1";
  } else if (options.ownerId !== undefined) {
    where = "(is_public = 1 OR owner_id = ?)";
    params.push(options.ownerId);
  } else {
    where = "is_public = 1";
  }

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM gallery WHERE ${where}`)
    .bind(...params)
    .first();
  const total = Number((totalRow as { n: number } | null)?.n ?? 0);
  const totalPages = Math.max(Math.ceil(total / options.pageSize), 1);
  const page = Math.min(Math.max(options.page, 1), totalPages);
  const offset = (page - 1) * options.pageSize;

  const rs = await env.DB.prepare(
    `SELECT * FROM gallery WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, options.pageSize, offset)
    .all();
  const images = (rs.results ?? [])
    .map((r) => rowToEntry(r as Record<string, unknown>))
    .filter((e): e is GalleryEntry => e !== null);

  return {
    total,
    page,
    page_size: options.pageSize,
    total_pages: totalPages,
    has_prev: page > 1,
    has_next: page < totalPages,
    images,
  };
}

export async function deleteGalleryEntry(
  env: Bindings,
  id: string,
): Promise<GalleryEntry | null> {
  const entry = await getEntry(env, id);
  if (!entry) return null;
  await env.DB.prepare(`DELETE FROM gallery WHERE id = ?`).bind(id).run();
  await deleteImage(env, entry.filename).catch(() => {});
  return entry;
}
