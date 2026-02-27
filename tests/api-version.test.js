import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../server.js';

describe('GET /api/version', () => {
	it('returns app version payload', async () => {
		const res = await request(app).get('/api/version');
		expect(res.status).toBe(200);
		expect(typeof res.body.version).toBe('string');
		expect(res.body.version.length).toBeGreaterThan(0);
		expect(typeof res.body.displayVersion).toBe('string');
		expect(res.body.displayVersion).toContain(res.body.version);
		expect(typeof res.body.bootId).toBe('string');
	});
});
