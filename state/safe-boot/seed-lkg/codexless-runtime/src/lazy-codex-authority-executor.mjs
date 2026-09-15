export class LazyCodexAuthorityExecutor {
  #factory;
  #delegate = null;
  #pending = null;

  constructor({ factory }) {
    if (typeof factory !== "function") throw new Error("LazyCodexAuthorityExecutor requires a factory");
    this.#factory = factory;
  }

  async resolveAuthority(input) {
    const delegate = await this.#get();
    return delegate.resolveAuthority(input);
  }

  async #get() {
    if (this.#delegate) return this.#delegate;
    this.#pending ??= Promise.resolve(this.#factory()).then(async (delegate) => {
      if (!delegate || typeof delegate.resolveAuthority !== "function" || typeof delegate.validate !== "function") {
        throw new Error("LazyCodexAuthorityExecutor factory returned an invalid authority executor");
      }
      await delegate.validate();
      this.#delegate = delegate;
      return delegate;
    });
    try {
      return await this.#pending;
    } finally {
      if (!this.#delegate) this.#pending = null;
    }
  }
}
