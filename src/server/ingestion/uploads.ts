import { localDate } from "../../lib/dates";
import { requireCompanyAccess } from "../auth/authz";
import { sha256Hex } from "../crypto";
import type { Queryable } from "../db";
import { type CsvValidationResult, validateCsv } from "./csv";

// Server-side CSV intake: authorize → validate → store (idempotent by content
// hash per company). The browser never supplies parsed rows.

export interface StoredUpload {
  uploadId: string | null;
  duplicateOf: string | null;
  validation: Omit<CsvValidationResult, "rows">;
}

export async function storeValidatedUpload(
  db: Queryable,
  opts: { userId: string; companyId: string; filename: string; text: string; byteSize: number; now?: Date },
): Promise<StoredUpload> {
  const { workspaceId } = await requireCompanyAccess(db, opts.userId, opts.companyId, "manage");
  const company = (await db.query<{ timezone: string }>(`select timezone from public.companies where id = $1`, [opts.companyId])).rows[0]!;
  const today = localDate(opts.now ?? new Date(), company.timezone);
  const result = validateCsv(opts.text, { today, byteSize: opts.byteSize });
  const { rows, ...validation } = result;
  if (!result.ok) return { uploadId: null, duplicateOf: null, validation };

  const hash = sha256Hex(opts.text.replace(/^﻿/, ""));
  const existing = await db.query<{ id: string }>(`select id from public.csv_uploads where company_id = $1 and content_sha256 = $2`, [
    opts.companyId,
    hash,
  ]);
  if (existing.rows[0]) {
    // Same file again: rows were dropped after the earlier import, so keep this copy until it is imported.
    await db.query(`update public.csv_uploads set rows = $2, summary = $3, status = 'validated' where id = $1 and status <> 'queued'`, [
      existing.rows[0].id,
      JSON.stringify(rows),
      JSON.stringify(result.summary),
    ]);
    return { uploadId: existing.rows[0].id, duplicateOf: existing.rows[0].id, validation };
  }

  const filename = opts.filename.replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "upload.csv";
  const ins = await db.query<{ id: string }>(
    `insert into public.csv_uploads (workspace_id, company_id, uploaded_by, filename, byte_size, row_count, content_sha256, rows, summary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (company_id, content_sha256) do update set filename = public.csv_uploads.filename
     returning id`,
    [workspaceId, opts.companyId, opts.userId, filename, opts.byteSize, rows.length, hash, JSON.stringify(rows), JSON.stringify(result.summary)],
  );
  await db.query(
    `insert into public.audit_logs (workspace_id, company_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'csv.uploaded', 'csv_upload', $4, $5)`,
    [workspaceId, opts.companyId, opts.userId, ins.rows[0]!.id, JSON.stringify({ rows: rows.length, bytes: opts.byteSize })],
  );
  return { uploadId: ins.rows[0]!.id, duplicateOf: null, validation };
}
