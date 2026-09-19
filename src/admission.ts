// Process-local admission control: bounded identities, burst rate and concurrent work.
export class Admission {
  private users = new Map<string, { tokens: number; at: number; active: number }>();
  private tokens: number;
  private at: number;
  private active = 0;

  constructor(
    private readonly burst = 20,
    private readonly perSecond = 1,
    private readonly concurrent = 8,
    private readonly perUserConcurrent = 2,
    private readonly now = Date.now,
  ) {
    this.tokens = burst * 3;
    this.at = now();
  }

  acquire(id: string): (() => void) | null {
    const now = this.now();
    for (const [key, value] of this.users) {
      if (value.active === 0 && now - value.at > 60_000) this.users.delete(key);
    }
    this.tokens = Math.min(
      this.burst * 3,
      this.tokens + ((now - this.at) / 1000) * this.perSecond * 3,
    );
    this.at = now;
    let user = this.users.get(id);
    if (!user) {
      if (this.users.size >= 10_000) return null;
      user = { tokens: this.burst, at: now, active: 0 };
      this.users.set(id, user);
    }
    user.tokens = Math.min(this.burst, user.tokens + ((now - user.at) / 1000) * this.perSecond);
    user.at = now;
    if (
      user.tokens < 1 ||
      this.tokens < 1 ||
      user.active >= this.perUserConcurrent ||
      this.active >= this.concurrent
    )
      return null;
    user.tokens--;
    this.tokens--;
    user.active++;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      user.active--;
      this.active--;
    };
  }
}
