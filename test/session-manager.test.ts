import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionLimitError, SessionManager } from '../src/concurrency/session-manager.js';

describe('SessionManager', () => {
  it('enforces max sessions and max tabs per session', () => {
    const sessions = new SessionManager(2, 1, 60_000);
    const a = sessions.create('client-a');
    const b = sessions.create('client-b');
    assert.equal(sessions.list().length, 2);
    assert.throws(() => sessions.create('client-c'), (error: unknown) => error instanceof SessionLimitError);

    sessions.attachTab(a.sessionId, 11);
    assert.throws(() => sessions.attachTab(a.sessionId, 12), (error: unknown) => error instanceof SessionLimitError);
    sessions.attachTab(b.sessionId, 21);
    assert.equal(sessions.resolveTab(b.sessionId), 21);
  });

  it('adopts opener-spawned tabs without moving the active tab', () => {
    const sessions = new SessionManager(2, 2, 60_000);
    const a = sessions.create('client-a');
    sessions.attachTab(a.sessionId, 11);
    assert.equal(sessions.findOwner(11), a.sessionId);
    assert.equal(sessions.adoptTab(a.sessionId, 12), true);
    assert.equal(sessions.get(a.sessionId).activeTabId, 11);
    assert.equal(sessions.adoptTab(a.sessionId, 13), false);
    assert.equal(sessions.findOwner(99), null);
  });

  it('sweeps idle sessions', () => {
    let now = 1_000;
    const sessions = new SessionManager(4, 4, 100, () => now);
    const session = sessions.create('idle');
    now = 1_200;
    const expired = sessions.sweepIdle();
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.sessionId, session.sessionId);
    assert.equal(sessions.list().length, 0);
  });
});
