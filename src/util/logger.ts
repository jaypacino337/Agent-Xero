const ts = () => new Date().toISOString();

export const log = {
  info: (mod: string, msg: string, extra?: unknown) =>
    console.log(`${ts()} [${mod}] ${msg}`, extra ?? ""),
  warn: (mod: string, msg: string, extra?: unknown) =>
    console.warn(`${ts()} [${mod}] WARN ${msg}`, extra ?? ""),
  error: (mod: string, msg: string, extra?: unknown) =>
    console.error(`${ts()} [${mod}] ERROR ${msg}`, extra ?? ""),
};

export const shortId = () => Math.random().toString(36).slice(2, 10);
