import { registerHooks } from 'node:module'

// 把宿主才提供的 @deepseek-ai/dsh-tools 指到本地 stub，别往插件 node_modules 里塞假包（会遮蔽真包）。
const STUB = new URL('./stub-tools.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: STUB, shortCircuit: true, format: 'module' }
    }
    return nextResolve(specifier, context)
  },
})
