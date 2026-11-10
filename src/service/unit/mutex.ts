// One holder at a time, in order (the unit's lock: a start, a stop, a supervisor's restart and a move never overlap).

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = 0;
  get locked(): boolean { return this.held > 0; }
  async run<T>(f: () => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    this.held++;
    try { await before; return await f(); }
    finally { this.held--; release(); }
  }
}
