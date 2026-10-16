import { describe, expect, it } from 'vitest';
import { RequestScheduler, type ScheduledTask } from '../src/world/request-scheduler';
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(limit = 12) {
  const calls: {
    task: ScheduledTask<string>;
    signal: AbortSignal;
    job: ReturnType<typeof deferred>;
  }[] = [];
  const scheduler = new RequestScheduler<string>((task, signal) => {
    const job = deferred();
    calls.push({ task, signal, job });
    return job.promise;
  }, limit);
  return { scheduler, calls };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe('human-priority request scheduling', () => {
  it('preempts automatic work and ignores its late completion', async () => {
    const { scheduler, calls } = harness();
    scheduler.automatic('tick');
    const human = scheduler.enqueue('event')!;
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].task.id).toBe(human.id);
    calls[0].job.resolve();
    await flush();
    expect(scheduler.getSnapshot().active?.id).toBe(human.id);
    calls[1].job.resolve();
    await flush();
    expect(scheduler.getSnapshot().active).toBeNull();
  });
  it('never interrupts a human request and executes subsequent actions FIFO', async () => {
    const { scheduler, calls } = harness();
    scheduler.enqueue('chat-one');
    scheduler.enqueue('event');
    scheduler.enqueue('chat-two');
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(false);
    expect(scheduler.automatic('tick')).toBe(false);
    calls[0].job.resolve();
    await flush();
    expect(calls[1].task.action).toBe('event');
    calls[1].job.resolve();
    await flush();
    expect(calls[2].task.action).toBe('chat-two');
  });
  it('keeps a failed human request and the rest of the queue for explicit retry', async () => {
    const { scheduler, calls } = harness();
    const first = scheduler.enqueue('chat')!;
    scheduler.enqueue('event');
    calls[0].job.reject(new Error('offline'));
    await flush();
    expect(scheduler.getSnapshot().failed?.id).toBe(first.id);
    expect(scheduler.getSnapshot().error).toBe('offline');
    expect(calls).toHaveLength(1);
    scheduler.retry();
    expect(calls[1].task).toBe(first);
    calls[1].job.resolve();
    await flush();
    expect(calls[2].task.action).toBe('event');
  });
  it('skips a failed response without discarding queued actions', async () => {
    const { scheduler, calls } = harness();
    scheduler.enqueue('chat');
    scheduler.enqueue('bread');
    calls[0].job.reject(new Error('bad'));
    await flush();
    scheduler.skipFailed();
    expect(calls[1].task.action).toBe('bread');
    expect(scheduler.getSnapshot().error).toBe('');
  });
  it('a new human action can supersede a failed automatic turn', async () => {
    const { scheduler, calls } = harness();
    scheduler.automatic('tick');
    calls[0].job.reject(new Error('bad'));
    await flush();
    scheduler.enqueue('chat');
    expect(scheduler.getSnapshot().failed).toBeNull();
    expect(calls[1].task.action).toBe('chat');
  });
  it('suspends and resumes human actions with their preparation progress intact', async () => {
    type Action = { prepared: boolean };
    const calls: { action: Action; signal: AbortSignal; job: ReturnType<typeof deferred> }[] = [];
    const scheduler = new RequestScheduler<Action>((task, signal) => {
      task.action.prepared = true;
      const job = deferred();
      calls.push({ action: task.action, signal, job });
      return job.promise;
    });
    scheduler.enqueue({ prepared: false });
    scheduler.suspend();
    expect(calls[0].signal.aborted).toBe(true);
    expect(scheduler.getSnapshot().waiting[0].action.prepared).toBe(true);
    calls[0].job.reject(new Error('aborted'));
    await flush();
    expect(scheduler.getSnapshot().error).toBe('');
    scheduler.resume();
    expect(calls).toHaveLength(2);
    expect(calls[1].action).toBe(calls[0].action);
  });
  it('drops suspended automatic work and prevents requests until resumed', async () => {
    const { scheduler, calls } = harness();
    scheduler.automatic('tick');
    scheduler.suspend();
    scheduler.enqueue('chat');
    expect(calls).toHaveLength(1);
    expect(scheduler.automatic('tick')).toBe(false);
    scheduler.resume();
    expect(calls[1].task.action).toBe('chat');
  });
  it('removes queued work and bounds the queue including its active request', () => {
    const { scheduler, calls } = harness(2);
    scheduler.enqueue('chat');
    const queued = scheduler.enqueue('event')!;
    expect(scheduler.enqueue('too-many')).toBeNull();
    expect(calls).toHaveLength(1);
    scheduler.remove(queued.id);
    expect(scheduler.enqueue('replacement')).not.toBeNull();
  });
  it('reset cancels old work without an old rejection breaking the new request', async () => {
    const { scheduler, calls } = harness();
    scheduler.enqueue('old');
    scheduler.enqueue('queued');
    scheduler.clear();
    scheduler.enqueue('new');
    calls[0].job.reject(new Error('old-failure'));
    await flush();
    expect(scheduler.getSnapshot().error).toBe('');
    expect(scheduler.getSnapshot().active?.action).toBe('new');
    expect(scheduler.getSnapshot().waiting).toEqual([]);
  });
});
