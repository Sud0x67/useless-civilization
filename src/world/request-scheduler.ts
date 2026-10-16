export type ScheduledTask<T> = { id: number; kind: 'automatic' | 'human'; action: T };
export type Schedule<T> = {
  active: ScheduledTask<T> | null;
  waiting: ScheduledTask<T>[];
  failed: ScheduledTask<T> | null;
  error: string;
  suspended: boolean;
};

// Only an automatic turn may be preempted by a new human action. Human work is FIFO.
export class RequestScheduler<T> {
  private state: Schedule<T> = {
    active: null,
    waiting: [],
    failed: null,
    error: '',
    suspended: false,
  };
  private controller: AbortController | null = null;
  private nextId = 1;
  private listeners = new Set<() => void>();

  constructor(
    private execute: (task: ScheduledTask<T>, signal: AbortSignal) => Promise<void>,
    readonly limit = 12,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<Schedule<T>>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private abortActive() {
    this.controller?.abort();
    this.controller = null;
  }
  private start(task: ScheduledTask<T>) {
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ active: task, error: '' });
    void this.execute(task, controller.signal).then(
      () => {
        if (this.state.active?.id !== task.id || controller.signal.aborted) return;
        this.controller = null;
        this.publish({ active: null });
        this.drain();
      },
      (error) => {
        if (this.state.active?.id !== task.id || controller.signal.aborted) return;
        this.controller = null;
        this.publish({
          active: null,
          failed: task,
          error: error instanceof Error ? error.message : '请求失败，请重试。',
        });
      },
    );
  }
  private drain() {
    if (
      this.state.suspended ||
      this.state.active ||
      this.state.failed ||
      !this.state.waiting.length
    )
      return;
    const [next, ...waiting] = this.state.waiting;
    this.publish({ waiting });
    this.start(next);
  }
  automatic(action: T) {
    if (this.state.suspended || this.state.active || this.state.failed || this.state.waiting.length)
      return false;
    this.start({ id: this.nextId++, kind: 'automatic', action });
    return true;
  }
  enqueue(action: T) {
    const humanCount = [this.state.active, this.state.failed, ...this.state.waiting].filter(
      (t) => t?.kind === 'human',
    ).length;
    if (humanCount >= this.limit) return null;
    if (this.state.active?.kind === 'automatic') {
      this.abortActive();
      this.publish({ active: null });
    }
    if (this.state.failed?.kind === 'automatic') this.publish({ failed: null, error: '' });
    const task: ScheduledTask<T> = { id: this.nextId++, kind: 'human', action };
    this.publish({ waiting: [...this.state.waiting, task] });
    this.drain();
    return task;
  }
  retry() {
    if (!this.state.failed || this.state.active || this.state.suspended) return;
    const task = this.state.failed;
    this.publish({ failed: null, error: '' });
    this.start(task);
  }
  skipFailed() {
    this.publish({ failed: null, error: '' });
    this.drain();
  }
  remove(id: number) {
    this.publish({ waiting: this.state.waiting.filter((t) => t.id !== id) });
  }
  suspend() {
    const active = this.state.active;
    this.abortActive();
    this.publish({
      active: null,
      suspended: true,
      waiting: active?.kind === 'human' ? [active, ...this.state.waiting] : this.state.waiting,
    });
  }
  resume() {
    this.publish({ suspended: false });
    this.drain();
  }
  clear() {
    this.abortActive();
    this.publish({ active: null, waiting: [], failed: null, error: '' });
  }
}
