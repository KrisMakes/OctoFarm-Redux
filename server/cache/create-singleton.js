/**
 * Lazily construct a single shared instance.
 *
 * Six cache modules each carried their own copy of
 * `let x; function getX() { if (!!x) return x; x = new C(); return x; }`.
 */
function createSingleton(Ctor) {
  let instance;
  return () => {
    if (!instance) {
      instance = new Ctor();
    }
    return instance;
  };
}

module.exports = { createSingleton };
