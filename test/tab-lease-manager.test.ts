import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LeaseTimeoutError, TabLeaseManager } from '../src/concurrency/tab-lease-manager.js';

describe('TabLeaseManager', () => {
  it('allows multiple shared leases when enabled', async () => {
    const leases = new TabLeaseManager(5_000, true);
    const a = await leases.acquire('s1', 10, { exclusive: false });
    const b = await leases.acquire('s2', 10, { exclusive: false });
    assert.equal(a.exclusive, false);
    assert.equal(b.exclusive, false);
    assert.equal(leases.snapshot(10).holders.length, 2);
  });

  it('queues exclusive waiters behind an active exclusive lease', async () => {
    const leases = new TabLeaseManager(5_000, true);
    const first = await leases.acquire('s1', 7, { exclusive: true });

    let granted = false;
    const waiting = leases.acquire('s2', 7, { exclusive: true, waitMs: 2_000 }).then((lease) => {
      granted = true;
      return lease;
    });

    await delay(20);
    assert.equal(granted, false);
    assert.equal(leases.snapshot(7).waiting, 1);

    leases.release(first.leaseId);
    const second = await waiting;
    assert.equal(second.sessionId, 's2');
    assert.equal(granted, true);
  });

  it('times out when a lease cannot be acquired', async () => {
    const leases = new TabLeaseManager(5_000, true);
    await leases.acquire('s1', 3, { exclusive: true });
    await assert.rejects(
      () => leases.acquire('s2', 3, { exclusive: true, waitMs: 50 }),
      (error: unknown) => error instanceof LeaseTimeoutError,
    );
  });

  it('releases all leases for a closed session', async () => {
    const leases = new TabLeaseManager(5_000, true);
    await leases.acquire('s1', 1, { exclusive: true });
    const released = leases.releaseSession('s1');
    assert.equal(released.length, 1);
    assert.equal(leases.snapshot(1).holders.length, 0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
