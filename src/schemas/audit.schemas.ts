import { z } from 'zod';
import { AuditStatus, FindingSeverity, FindingStatus } from '../domain/types';

/**
 * Zod schemas serve double duty: runtime input validation (preventing injection
 * and malformed data) and the single source of truth for request types via
 * `z.infer`. Keeping them beside the domain means the contract and the model
 * evolve together.
 */

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO-8601 date/time' });

/** A bounded, trimmed string helper to keep payloads sane and injection-resistant. */
const boundedString = (min: number, max: number): z.ZodString =>
  z.string().trim().min(min).max(max);

export const metadataSchema = z.object({
  facilityName: boundedString(1, 200),
  facilityId: boundedString(1, 64),
  standard: boundedString(1, 100),
  surveyorName: boundedString(1, 200),
  region: boundedString(1, 100),
  tags: z.array(boundedString(1, 40)).max(20).default([]),
});

export const commentInputSchema = z.object({
  body: boundedString(1, 2000),
});

export const findingInputSchema = z.object({
  code: boundedString(1, 20).regex(/^[A-Za-z0-9-]+$/, 'code must be alphanumeric/dash'),
  title: boundedString(1, 200),
  description: boundedString(1, 4000),
  severity: z.nativeEnum(FindingSeverity),
  status: z.nativeEnum(FindingStatus).default(FindingStatus.Open),
  standardClause: boundedString(1, 60),
  assignedTo: boundedString(1, 120).nullable().default(null),
  dueDate: isoDate.nullable().default(null),
  riskWeight: z.number().int().min(0).max(100),
});

/** POST /audits body. */
export const createAuditSchema = z.object({
  auditKey: boundedString(3, 80).regex(/^[A-Za-z0-9:_-]+$/, 'auditKey must be url-safe'),
  title: boundedString(1, 200),
  metadata: metadataSchema,
  findings: z.array(findingInputSchema).max(500).default([]),
});

/**
 * PUT /audits/:id body. A PUT may be full or partial:
 *  - Full replace: provide `metadata`, `title`, `findings` — the resource is
 *    replaced wholesale (findings list is authoritative).
 *  - Partial: provide only the fields you want to change; omit the rest.
 * All fields are therefore optional here; "which semantics" is decided by what
 * the caller sends. `status` transitions are validated in the service layer.
 */
export const updateAuditSchema = z
  .object({
    title: boundedString(1, 200).optional(),
    status: z.nativeEnum(AuditStatus).optional(),
    metadata: metadataSchema.partial().optional(),
    findings: z.array(findingInputSchema).max(500).optional(),
    /** Client-asserted version for optimistic concurrency (see also If-Match). */
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CreateAuditInput = z.infer<typeof createAuditSchema>;
export type UpdateAuditInput = z.infer<typeof updateAuditSchema>;
export type FindingInput = z.infer<typeof findingInputSchema>;
export type MetadataInput = z.infer<typeof metadataSchema>;

/** ---- Query-parameter parsing for the rich GET endpoint ---- */

export const INCLUDABLE_FIELDS = ['findings', 'comments', 'metrics', 'attachments'] as const;
export type IncludableField = (typeof INCLUDABLE_FIELDS)[number];

/**
 * Parse the `?include=a,b,c` parameter. Splits on commas, trims each token, and
 * drops anything that isn't a recognized includable field — so a request like
 * `?include=findings,garbage` yields just `['findings']` rather than erroring.
 */
const includeParam = z
  .string()
  .optional()
  .transform((val) =>
    val
      ? val
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is IncludableField =>
            (INCLUDABLE_FIELDS as readonly string[]).includes(s),
          )
      : [],
  );

export const getAuditQuerySchema = z.object({
  /** `?view=summary` returns the flattened human-readable variant. */
  view: z.enum(['full', 'summary']).default('full'),
  /** `?include=findings,metrics` selective expansion. */
  include: includeParam,
  /** Pagination for the nested findings list. */
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(20),
  /** Filter nested findings. */
  severity: z.nativeEnum(FindingSeverity).optional(),
  findingStatus: z.nativeEnum(FindingStatus).optional(),
  /** Sort nested findings: field:direction, e.g. `dueDate:asc`. */
  sort: z
    .enum([
      'createdAt:asc',
      'createdAt:desc',
      'severity:asc',
      'severity:desc',
      'dueDate:asc',
      'dueDate:desc',
    ])
    .default('severity:desc'),
});

export type GetAuditQuery = z.infer<typeof getAuditQuerySchema>;

/** POST /audits list query (pagination for the collection itself). */
export const listAuditsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(20),
  status: z.nativeEnum(AuditStatus).optional(),
});
export type ListAuditsQuery = z.infer<typeof listAuditsQuerySchema>;