import test from 'node:test';
import assert from 'node:assert/strict';
import { retellConnection } from '../src/retell-connection.js';

const response = { call_id: 'call-example', access_token: 'short-lived-token', transport: 'gateway',
  ice_servers: [{ urls: ['stun:stun.example.test', 'turn:turn.example.test'], username: 'ephemeral', credential: 'temporary' }],
  metadata: { private: 'must not be forwarded' } };

test('v3 connection preserves selected transport and ICE credentials without leaking unrelated fields', () => {
  assert.deepEqual(retellConnection(response), { callId: response.call_id, accessToken: response.access_token,
    transport: 'gateway', iceServers: response.ice_servers });
  assert.equal(Object.hasOwn(retellConnection(response), 'metadata'), false);
});

test('missing v3 connection fields fail closed instead of silently selecting the wrong transport', () => {
  for (const field of ['call_id', 'access_token', 'transport', 'ice_servers']) {
    const broken = { ...response }; delete broken[field];
    assert.throws(() => retellConnection(broken), /incomplete connection/);
  }
  for (const fields of [{ call_id: '' }, { access_token: '' }, { transport: 'unknown' },
    { ice_servers: [{ urls: 42 }] }, { ice_servers: null }]) {
    assert.throws(() => retellConnection({ ...response, ...fields }), /incomplete connection/);
  }
  assert.deepEqual(retellConnection({ ...response, ice_servers: [] }).iceServers, []);
});
