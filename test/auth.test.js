import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const userStore = vi.hoisted(() => ({ users: new Map() }));

vi.mock('../src/models/User.js', () => {
  class MockUser {
    constructor(fields) {
      Object.assign(this, fields);
      this.id = `user-${userStore.users.size + 1}`;
      this._id = { toString: () => this.id };
    }

    async save() {
      if (userStore.users.has(this.email)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      userStore.users.set(this.email, this);
      return this;
    }

    static findOne({ email }) {
      const user = userStore.users.get(email) ?? null;
      return {
        select: async () => user,
        then: (resolve, reject) => Promise.resolve(user).then(resolve, reject),
      };
    }

    static async findById(id) {
      return [...userStore.users.values()].find((user) => user.id === id) ?? null;
    }
  }

  return { User: MockUser };
});

const { app } = await import('../src/app.js');

const registration = {
  name: 'Ada Lovelace',
  email: 'Ada@Example.com',
  password: 'correct horse battery staple',
};

async function registerAndLogin() {
  await request(app).post('/api/v1/auth/register').send(registration);
  return request(app).post('/api/v1/auth/login').send({
    email: registration.email,
    password: registration.password,
  });
}

beforeEach(() => userStore.users.clear());

describe('authentication routes', () => {
  it('registers a user with a normalized email and no password hash in the response', async () => {
    const response = await request(app).post('/api/v1/auth/register').send(registration);

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(userStore.users.get('ada@example.com').passwordHash).toMatch(/^\$2[aby]\$/);
    expect(userStore.users.get('ada@example.com').passwordHash).not.toBe(registration.password);
  });

  it('rejects duplicate email registration', async () => {
    await request(app).post('/api/v1/auth/register').send(registration);
    const response = await request(app).post('/api/v1/auth/register').send({
      ...registration,
      email: 'ada@example.com',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { message: 'Email already registered' } });
  });

  it('logs in with valid credentials and returns a signed JWT', async () => {
    const response = await registerAndLogin();

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body).not.toHaveProperty('user.passwordHash');
  });

  it('returns a generic error for invalid credentials', async () => {
    await request(app).post('/api/v1/auth/register').send(registration);
    const response = await request(app).post('/api/v1/auth/login').send({
      email: registration.email,
      password: 'incorrect password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Invalid email or password' } });
  });

  it('rejects a missing JWT', async () => {
    const response = await request(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Unauthorized' } });
  });

  it('rejects an invalid JWT', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Unauthorized' } });
  });

  it('rejects a malformed Authorization header', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Basic invalid-token');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { message: 'Unauthorized' } });
  });

  it('validates registration input', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      ...registration,
      password: 'short',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Invalid request body');
  });

  it('returns the authenticated user profile without the password hash', async () => {
    const login = await registerAndLogin();
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });
});
