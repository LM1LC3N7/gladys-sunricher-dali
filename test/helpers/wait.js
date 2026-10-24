// Polls a condition (real timers): the tests talk to a real local socket.
export async function until(condition, { timeout = 4_000, step = 10 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const silentLogger = () => {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
};
