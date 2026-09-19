// Reserve synchronously before sending, but release failures so another event can retry delivery.
export class NotificationDelivery {
  private sent = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();

  async send(key: string, deliver: () => Promise<void>): Promise<void> {
    const now = Date.now();
    for (const [id, time] of this.sent) if (now - time > 86400_000) this.sent.delete(id);
    if (this.sent.has(key)) return;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(deliver)
      .then(() => {
        this.sent.set(key, Date.now());
        const first = this.sent.keys().next().value;
        if (this.sent.size > 10_000 && first !== undefined) this.sent.delete(first);
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}
