import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { assign, makeOutlet } from '../../tests/fixtures.js';
import { grantRole } from '../users/roles.service.js';

const config = testConfig({
  MANAGER_ALLOWED_EMAILS: 'manager@example.com',
  POS_ALLOWED_EMAILS: '',
});
const app = buildTestApp({ config });

async function agentFor(email: string) {
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}
type Agent = Awaited<ReturnType<typeof agentFor>>;

const patchIntelligence = (agent: Agent, outletId: string, body: object) =>
  agent
    .patch(`/api/v1/staff/outlets/${outletId}/intelligence`)
    .set('X-Requested-With', 'CampusCart')
    .send(body);

const patchCoordinates = (agent: Agent, outletId: string, body: object) =>
  agent
    .patch(`/api/v1/admin/outlets/${outletId}/coordinates`)
    .set('X-Requested-With', 'CampusCart')
    .send(body);

const adminPost = (agent: Agent, path: string, body: object) =>
  agent.post(`/api/v1/admin/outlets${path}`).set('X-Requested-With', 'CampusCart').send(body);

const adminPatch = (agent: Agent, path: string, body: object) =>
  agent.patch(`/api/v1/admin/outlets${path}`).set('X-Requested-With', 'CampusCart').send(body);

let admin: Agent;
let manager: Agent;
let outlet: Awaited<ReturnType<typeof makeOutlet>>;

beforeEach(async () => {
  await resetDatabase();
  outlet = await makeOutlet({ name: 'Main Canteen' });
  admin = await agentFor('admin@example.com');
  manager = await agentFor('manager@example.com');
  await grantRole(prisma, {
    email: 'admin@example.com',
    role: 'ADMIN',
    actor: { type: 'CLI' },
    lists: config,
  });
  await assign('manager@example.com', outlet.id, 'MANAGER');
});

// ─── Intelligence endpoint ───────────────────────────────────────────────────

describe('PATCH /staff/outlets/:outletId/intelligence', () => {
  it('manager sets crowd level and queue length', async () => {
    const res = await patchIntelligence(manager, outlet.id, {
      crowdLevel: 'HIGH',
      queueLength: 12,
    }).expect(200);

    expect(res.body.outlet).toMatchObject({
      crowdLevel: 'HIGH',
      queueLength: 12,
    });
    expect(res.body.outlet.intelligenceUpdatedAt).toBeTruthy();
  });

  it('manager sets all intelligence fields at once', async () => {
    const res = await patchIntelligence(manager, outlet.id, {
      crowdLevel: 'MODERATE',
      queueLength: 5,
      availableSeats: 20,
      outletRating: 4.2,
      specialtyItems: ['Dosa', 'Idli'],
    }).expect(200);

    expect(res.body.outlet).toMatchObject({
      crowdLevel: 'MODERATE',
      queueLength: 5,
      availableSeats: 20,
      outletRating: 4.2,
      specialtyItems: ['Dosa', 'Idli'],
    });
  });

  it('partial update leaves other fields unchanged', async () => {
    await patchIntelligence(manager, outlet.id, {
      crowdLevel: 'LOW',
      queueLength: 3,
    }).expect(200);

    const res = await patchIntelligence(manager, outlet.id, {
      availableSeats: 10,
    }).expect(200);

    expect(res.body.outlet).toMatchObject({
      crowdLevel: 'LOW',
      queueLength: 3,
      availableSeats: 10,
    });
  });

  it('clears fields with null', async () => {
    await patchIntelligence(manager, outlet.id, { crowdLevel: 'HIGH', queueLength: 8 }).expect(200);
    const res = await patchIntelligence(manager, outlet.id, {
      crowdLevel: null,
      queueLength: null,
    }).expect(200);
    expect(res.body.outlet.crowdLevel).toBeNull();
    expect(res.body.outlet.queueLength).toBeNull();
  });

  it('rejects unknown crowdLevel values', async () => {
    await patchIntelligence(manager, outlet.id, { crowdLevel: 'INSANE' }).expect(400);
  });

  it('rejects negative queue length', async () => {
    await patchIntelligence(manager, outlet.id, { queueLength: -1 }).expect(400);
  });

  it('rejects outletRating outside 1–5', async () => {
    await patchIntelligence(manager, outlet.id, { outletRating: 0 }).expect(400);
    await patchIntelligence(manager, outlet.id, { outletRating: 5.1 }).expect(400);
  });

  it('rejects more than 10 specialty items', async () => {
    await patchIntelligence(manager, outlet.id, {
      specialtyItems: Array.from({ length: 11 }, (_, i) => `Item ${i}`),
    }).expect(400);
  });

  it('returns 403 for students and unauthenticated requests', async () => {
    const student = await agentFor('student@example.com');
    await patchIntelligence(student, outlet.id, { crowdLevel: 'LOW' }).expect(403);
    await request(app)
      .patch(`/api/v1/staff/outlets/${outlet.id}/intelligence`)
      .set('X-Requested-With', 'CampusCart')
      .send({ crowdLevel: 'LOW' })
      .expect(401);
  });

  it('returns 403 for managers not assigned to this outlet', async () => {
    const other = await makeOutlet({ name: 'Other' });
    await patchIntelligence(manager, other.id, { crowdLevel: 'LOW' }).expect(403);
  });
});

// ─── Admin coordinates endpoint ──────────────────────────────────────────────

describe('PATCH /admin/outlets/:outletId/coordinates', () => {
  it('sets latitude and longitude', async () => {
    const res = await patchCoordinates(admin, outlet.id, {
      latitude: 12.9716,
      longitude: 77.5946,
    }).expect(200);

    expect(res.body.outlet).toMatchObject({
      id: outlet.id,
      latitude: 12.9716,
      longitude: 77.5946,
    });
  });

  it('clears coordinates with null', async () => {
    await patchCoordinates(admin, outlet.id, { latitude: 12.9716, longitude: 77.5946 }).expect(200);
    const res = await patchCoordinates(admin, outlet.id, {
      latitude: null,
      longitude: null,
    }).expect(200);
    expect(res.body.outlet.latitude).toBeNull();
    expect(res.body.outlet.longitude).toBeNull();
  });

  it('rejects latitude out of range', async () => {
    await patchCoordinates(admin, outlet.id, { latitude: 91, longitude: 0 }).expect(400);
    await patchCoordinates(admin, outlet.id, { latitude: -91, longitude: 0 }).expect(400);
  });

  it('rejects longitude out of range', async () => {
    await patchCoordinates(admin, outlet.id, { latitude: 0, longitude: 181 }).expect(400);
    await patchCoordinates(admin, outlet.id, { latitude: 0, longitude: -181 }).expect(400);
  });

  it('records an audit log entry', async () => {
    await patchCoordinates(admin, outlet.id, { latitude: 12.9716, longitude: 77.5946 }).expect(200);
    expect(
      await prisma.auditLog.count({ where: { action: 'OUTLET_COORDINATES_UPDATED' } }),
    ).toBe(1);
  });

  it('returns 403 for managers and 404 for unknown outlet', async () => {
    await patchCoordinates(manager, outlet.id, { latitude: 0, longitude: 0 }).expect(403);
    await patchCoordinates(
      admin,
      '00000000-0000-0000-0000-000000000000',
      { latitude: 0, longitude: 0 },
    ).expect(404);
  });
});

// ─── Admin campus locations CRUD ─────────────────────────────────────────────

describe('admin campus locations CRUD', () => {
  const sampleLocation = {
    slug: 'main-block',
    name: 'Main Block',
    category: 'Academic',
    latitude: 12.9718,
    longitude: 77.5944,
    description: 'Central academic building',
  };

  it('creates a campus location', async () => {
    const res = await adminPost(admin, '/map/locations', sampleLocation).expect(201);
    expect(res.body.location).toMatchObject({
      slug: 'main-block',
      name: 'Main Block',
      category: 'Academic',
      latitude: 12.9718,
      longitude: 77.5944,
    });
  });

  it('rejects duplicate slugs', async () => {
    await adminPost(admin, '/map/locations', sampleLocation).expect(201);
    await adminPost(admin, '/map/locations', { ...sampleLocation, name: 'Other' }).expect(409);
  });

  it('lists all campus locations', async () => {
    await adminPost(admin, '/map/locations', sampleLocation).expect(201);
    await adminPost(admin, '/map/locations', {
      ...sampleLocation,
      slug: 'sports-complex',
      name: 'Sports Complex',
    }).expect(201);
    const res = await admin.get('/api/v1/admin/outlets/map/locations').expect(200);
    expect(res.body.locations).toHaveLength(2);
  });

  it('updates a campus location', async () => {
    const created = await adminPost(admin, '/map/locations', sampleLocation).expect(201);
    const id = created.body.location.id as string;
    const res = await adminPatch(admin, `/map/locations/${id}`, {
      name: 'Main Academic Block',
      description: 'Updated description',
    }).expect(200);
    expect(res.body.location.name).toBe('Main Academic Block');
    expect(res.body.location.description).toBe('Updated description');
    expect(res.body.location.slug).toBe('main-block'); // slug unchanged
  });

  it('deletes a campus location', async () => {
    const created = await adminPost(admin, '/map/locations', sampleLocation).expect(201);
    const id = created.body.location.id as string;
    await admin
      .delete(`/api/v1/admin/outlets/map/locations/${id}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(204);
    expect(await prisma.campusLocation.count()).toBe(0);
  });

  it('returns 404 for non-existent location', async () => {
    await adminPatch(admin, '/map/locations/00000000-0000-0000-0000-000000000000', {
      name: 'X',
    }).expect(404);
    await admin
      .delete('/api/v1/admin/outlets/map/locations/00000000-0000-0000-0000-000000000000')
      .set('X-Requested-With', 'CampusCart')
      .expect(404);
  });

  it('is forbidden to non-admins', async () => {
    await adminPost(manager, '/map/locations', sampleLocation).expect(403);
    await manager.get('/api/v1/admin/outlets/map/locations').expect(403);
  });
});

// ─── Public map endpoint ──────────────────────────────────────────────────────

describe('GET /api/v1/map', () => {
  it('returns active outlets and campus locations', async () => {
    await patchCoordinates(admin, outlet.id, { latitude: 12.971, longitude: 77.594 }).expect(200);
    await adminPost(admin, '/map/locations', {
      slug: 'library',
      name: 'Library',
      category: 'Facility',
      latitude: 12.972,
      longitude: 77.595,
    }).expect(201);

    const res = await request(app).get('/api/v1/map').expect(200);

    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0]).toMatchObject({
      id: outlet.id,
      slug: outlet.slug,
      latitude: 12.971,
      longitude: 77.594,
    });
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0]).toMatchObject({
      slug: 'library',
      name: 'Library',
      category: 'Facility',
    });
  });

  it('includes outlets with null coordinates', async () => {
    const res = await request(app).get('/api/v1/map').expect(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].latitude).toBeNull();
    expect(res.body.outlets[0].longitude).toBeNull();
  });

  it('excludes inactive outlets', async () => {
    await makeOutlet({ name: 'Archived', isActive: false });
    const res = await request(app).get('/api/v1/map').expect(200);
    expect(res.body.outlets).toHaveLength(1);
    expect(res.body.outlets[0].name).toBe('Main Canteen');
  });

  it('only returns active campus locations', async () => {
    await prisma.campusLocation.create({
      data: {
        slug: 'old-block',
        name: 'Old Block',
        category: 'Academic',
        latitude: 12.9,
        longitude: 77.5,
        isActive: false,
      },
    });
    await adminPost(admin, '/map/locations', {
      slug: 'new-block',
      name: 'New Block',
      category: 'Academic',
      latitude: 12.91,
      longitude: 77.51,
    }).expect(201);

    const res = await request(app).get('/api/v1/map').expect(200);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0].slug).toBe('new-block');
  });

  it('is accessible without authentication', async () => {
    await request(app).get('/api/v1/map').expect(200);
  });

  it('outlets are sorted by name, locations by name', async () => {
    const second = await makeOutlet({ name: 'Zeta Café' });
    await patchCoordinates(admin, outlet.id, { latitude: 1, longitude: 1 }).expect(200);
    await patchCoordinates(admin, second.id, { latitude: 2, longitude: 2 }).expect(200);
    await adminPost(admin, '/map/locations', {
      slug: 'z-hall',
      name: 'Z Hall',
      category: 'Hostel',
      latitude: 1,
      longitude: 1,
    }).expect(201);
    await adminPost(admin, '/map/locations', {
      slug: 'a-block',
      name: 'A Block',
      category: 'Academic',
      latitude: 2,
      longitude: 2,
    }).expect(201);

    const res = await request(app).get('/api/v1/map').expect(200);
    expect(res.body.outlets.map((o: { name: string }) => o.name)).toEqual([
      'Main Canteen',
      'Zeta Café',
    ]);
    expect(res.body.locations.map((l: { name: string }) => l.name)).toEqual(['A Block', 'Z Hall']);
  });

  it('includes outlet intelligence fields', async () => {
    await patchIntelligence(manager, outlet.id, {
      crowdLevel: 'LOW',
      outletRating: 4.5,
      specialtyItems: ['Chai'],
    }).expect(200);

    const res = await request(app).get('/api/v1/map').expect(200);
    expect(res.body.outlets[0]).toMatchObject({
      crowdLevel: 'LOW',
      outletRating: 4.5,
      specialtyItems: ['Chai'],
    });
  });
});
