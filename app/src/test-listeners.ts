import { beforeEach } from "vitest";

type Add = Parameters<Window["addEventListener"]>;

/**
 * Each test imports a fresh copy of a page's module, but jsdom keeps one window
 * and one document for the whole file, so listeners an earlier copy added to
 * them would still answer. Remove them before every test.
 */
export function isolateListeners(...targets: (Window | Document)[]) {
  const added: [Window | Document, ...Add][] = [];
  for (const target of targets) {
    const add = target.addEventListener.bind(target) as (...args: Add) => void;
    target.addEventListener = ((...args: Add) => {
      added.push([target, ...args]);
      add(...args);
    }) as typeof target.addEventListener;
  }
  beforeEach(() => {
    for (const [target, type, listener, options] of added.splice(0)) target.removeEventListener(type, listener, options);
  });
}
