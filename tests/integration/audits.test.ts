import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { InMemoryAuditRepository } from '../../src/repositories/inMemoryAuditRepository';
import { AuditService } from '../../src/services/auditService';
import { AttachmentService } from '../../src/services/attachmentService';
import { LocalStorageDriver } from '../../src/storage/localStorageDriver';
import { jobQueue } from '../../src/jobs/jobQueue';
import { registerAuditCreatedJob } from '../../src/jobs/auditCreatedJob';
import { systemClock } from '../../src/utils/clock';
import { env } from '../../src/config/env';

function makeToken(role: 'user' | 'admin'): string {
  return jwt.sign(
    { sub: 'test-user-1', name: 'Test User', roles: [role] },
    env.JWT_SECRET,
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: '1h' },
  );
}

const ADMIN_TOKEN = makeToken('admin');
const USER_TOKEN  = makeToken('user');

const VALID_PAYLOAD = {
  auditKey: 'FAC-001:2026-Q1',
  title: 'Q1 Compliance Audit',
  metadata: {
    facilityName: 'General Hospital',
    facilityId:   'FAC-001',
    standard:     'DNV NIAHO',
    surveyorName: 'Jane Smith',
    region:       'Northeast',
    tags:         ['priority'],
  },
  findings: [],
};

function buildApp() {
  const repo    = new InMemoryAuditRepository();
  const storage = new LocalStorageDriver();
  registerAuditCreatedJob(repo);
  jobQueue.start();
  const auditService      = new AuditService(repo, systemClock, jobQueue);
  const attachmentService = new AttachmentService(repo, storage, systemClock);
  return createApp(auditService, attachmentService);
}

describe('POST /api/v1/audits', () => {
  it('creates an audit and returns 201 with Location header', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.headers['location']).toMatch(/\/audits\//);
    expect(res.body.data.auditKey).toBe('FAC-001:2026-Q1');
    expect(res.body.data.version).toBe(1);
  });

  it('returns 409 on duplicate auditKey', async () => {
    const app = buildApp();
    await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    const res = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_BUSINESS_KEY');
  });

  it('returns 401 without a token', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/v1/audits')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(401);
  });

  it('returns 403 for user role (no create permission)', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid payload', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
  });
});

describe('GET /api/v1/audits/:id', () => {
  it('returns 200 with full audit data', async () => {
    const app = buildApp();
    const created = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    const res = await supertest(app)
      .get(`/api/v1/audits/${created.body.data.id}`)
      .set('Authorization', `Bearer ${USER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.auditKey).toBe('FAC-001:2026-Q1');
  });

  it('returns 200 with summary view', async () => {
    const app = buildApp();
    const created = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    const res = await supertest(app)
      .get(`/api/v1/audits/${created.body.data.id}?view=summary`)
      .set('Authorization', `Bearer ${USER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.riskScore).toBeDefined();
    expect(res.body.data.findings).toBeUndefined();
  });

  it('returns 404 for unknown id', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .get('/api/v1/audits/nonexistent-id')
      .set('Authorization', `Bearer ${USER_TOKEN}`);

    expect(res.status).toBe(404);
  });
});

describe('PUT /api/v1/audits/:id', () => {
  it('updates the audit and increments version', async () => {
    const app = buildApp();
    const created = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    const id = created.body.data.id as string;

    const res = await supertest(app)
      .put(`/api/v1/audits/${id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('If-Match', '"1"')
      .send({ title: 'Updated Title' });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated Title');
    expect(res.body.data.version).toBe(2);
  });

  it('returns 409 on version conflict', async () => {
    const app = buildApp();
    const created = await supertest(app)
      .post('/api/v1/audits')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(VALID_PAYLOAD);

    const id = created.body.data.id as string;

    const res = await supertest(app)
      .put(`/api/v1/audits/${id}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .set('If-Match', '"99"')  // wrong version
      .send({ title: 'Should Fail' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });
});

describe('GET /health', () => {
  it('returns 200 without authentication', async () => {
    const app = buildApp();
    const res = await supertest(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});