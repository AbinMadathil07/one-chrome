import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MutexQueue } from '../src/concurrency/mutex-queue.js';

describe('MutexQueue', () => {
  it('runs tasks for the same key in order', async () => {
    const queue = new MutexQueue();
    const order: number[] = [];

    const first = queue.run('tab:1', async () => {
      await delay(30);
      order.push(1);
      return 1;
    });
    const second = queue.run('tab:1', async () => {
      order.push(2);
      return 2;
    });

    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, [1, 2]);
  });

  it('allows different keys to run concurrently', async () => {
    const queue = new MutexQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(40);
      concurrent -= 1;
    };

    await Promise.all([queue.run('a', task), queue.run('b', task)]);
    assert.equal(maxConcurrent, 2);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
