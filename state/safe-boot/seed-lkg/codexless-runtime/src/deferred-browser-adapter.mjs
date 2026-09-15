export function createDeferredBrowserAdapter({ factory, methods }) {
  if (typeof factory !== "function") throw new Error("deferred browser adapter requires a factory");
  if (!Array.isArray(methods) || !methods.every((name) => typeof name === "string" && name)) {
    throw new Error("deferred browser adapter requires method names");
  }
  let state = null;
  let pending = null;
  let closed = false;

  async function ensure() {
    if (closed) throw new Error("deferred browser adapter is closed");
    if (state) return state;
    pending ??= Promise.resolve(factory()).then((created) => {
      if (!created?.browser) throw new Error("deferred browser factory returned no browser executor");
      state = created;
      return created;
    });
    try {
      return await pending;
    } finally {
      if (!state) pending = null;
    }
  }

  const adapter = {};
  for (const method of methods) {
    adapter[method] = async (input) => {
      const current = await ensure();
      const fn = current.browser?.[method];
      if (typeof fn !== "function") throw new Error(`deferred browser executor does not implement ${method}`);
      return fn.call(current.browser, input);
    };
  }
  adapter.restart = async () => {
    if (!state) return { status: "not-started" };
    if (typeof state.restart !== "function") throw new Error("deferred browser executor cannot restart");
    return state.restart();
  };
  adapter.close = async () => {
    if (closed) return;
    closed = true;
    const current = state;
    state = null;
    pending = null;
    if (typeof current?.close === "function") await current.close();
  };
  adapter.initialized = () => Boolean(state);
  return adapter;
}
