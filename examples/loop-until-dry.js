export const meta = {
  name: 'loop-until-dry',
  description: 'Keep fanning out finders until K consecutive rounds turn up nothing new.',
  whenToUse:
    'Discovery of unknown size (bugs, edge cases, ideas). Pass {target, finders?, dryRounds?, maxRounds?}.',
  phases: [{ title: 'Discover' }],
}

const ITEMS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  required: ['items'],
}

const target = (args && args.target) || 'Find edge cases in a date parser.'
const finders = (args && Number(args.finders)) || 3
const dryLimit = (args && Number(args.dryRounds)) || 2
const maxRounds = (args && Number(args.maxRounds)) || 6 // safety bound for the example

// while-loop in plain JS + per-round parallel fan-out + dedup against `seen`.
// Stop after `dryLimit` consecutive rounds with no new items.
phase('Discover')
const seen = new Set()
const all = []
let dry = 0
let round = 0
while (dry < dryLimit && round < maxRounds) {
  round++
  const batches = await parallel(
    Array.from({ length: finders }, (_, i) => () =>
      agent(
        `Round ${round}, finder ${i + 1}. ${target} Return items not already obvious.`,
        { label: `find-r${round}-${i + 1}`, phase: 'Discover', schema: ITEMS }
      )
    )
  )
  const fresh = batches
    .filter(Boolean)
    .flatMap((b) => b.items || [])
    .filter((it) => it.id && !seen.has(it.id))
  if (fresh.length === 0) {
    dry++
    log(`round ${round}: nothing new (${dry}/${dryLimit} dry)`)
    continue
  }
  dry = 0
  for (const it of fresh) seen.add(it.id)
  all.push(...fresh)
  log(`round ${round}: +${fresh.length} new (total ${all.length})`)
}

return { discovered: all, rounds: round }
