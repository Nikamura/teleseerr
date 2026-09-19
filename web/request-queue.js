/**
 * Share the server's two-request allowance across reads and mutations in this tab.
 * @param {number} [concurrency]
 */
export function createRequestQueue(concurrency = 2) {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  function enqueue(work) {
    if (waiting.length >= 64) return Promise.reject(new Error("Too many queued requests"));
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        active++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          active--;
          drain();
        });
      });
      drain();
    });
  }

  function drain() {
    while (active < concurrency && waiting.length) waiting.shift()();
  }

  return enqueue;
}
