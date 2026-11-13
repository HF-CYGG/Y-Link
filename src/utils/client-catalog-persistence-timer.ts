/** 合并目录写入；代次同时防止已取消但仍被调用的旧回调生效。 */
export const createClientCatalogPersistenceTimer = (write: (owner: string) => void) => {
  let generation = 0
  let owner = ''
  let dirty = false
  let quiet: ReturnType<typeof setTimeout> | undefined
  let maximum: ReturnType<typeof setTimeout> | undefined

  const stopTimers = () => {
    clearTimeout(quiet)
    clearTimeout(maximum)
    quiet = maximum = undefined
  }
  const cancel = () => {
    generation += 1
    dirty = false
    owner = ''
    stopTimers()
  }
  const flush = () => {
    if (!dirty) return
    const currentOwner = owner
    cancel()
    write(currentOwner)
  }
  const schedule = (nextOwner: string) => {
    if (!nextOwner) return
    if (dirty && owner !== nextOwner) cancel()
    owner = nextOwner
    const currentGeneration = generation
    const run = () => {
      if (generation === currentGeneration && dirty && owner === nextOwner) flush()
    }
    if (!dirty) {
      dirty = true
      maximum = setTimeout(run, 1000)
    }
    clearTimeout(quiet)
    quiet = setTimeout(run, 200)
  }
  return { schedule, flush, cancel }
}
