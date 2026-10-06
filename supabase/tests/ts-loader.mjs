// Загрузчик для тестов на Node: понимает алиас «@/…» и импорты без расширения
// (как в проекте на TypeScript). Нужен только тестам бота.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const REPO = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

export async function resolve(specifier, context, next) {
  let spec = specifier;
  if (spec.startsWith('@/')) spec = pathToFileURL(`${REPO}/${spec.slice(2)}`).href;
  if (spec.startsWith('.') || spec.startsWith('file:')) {
    try {
      return await next(spec, context);
    } catch (e) {
      if (!/\.(m?[jt]s|json)$/.test(spec)) return next(`${spec}.ts`, context);
      throw e;
    }
  }
  return next(spec, context);
}
