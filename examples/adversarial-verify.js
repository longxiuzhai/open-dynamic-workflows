export const meta = {
  name: 'adversarial-verify',
  description: 'Surface candidate findings, then keep only those that survive independent refutation.',
  whenToUse:
    'Review/audit tasks where false positives are costly. Pass {target, voters?} as args.',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, detail: { type: 'string' } },
        required: ['title', 'detail'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted'],
}

const target = (args && args.target) || 'Review this code for correctness bugs.'
const voters = (args && Number(args.voters)) || 3

// Phase 1 — one agent surfaces candidate findings (typed via a schema).
phase('Find')
log('Finding candidate issues')
const found = await agent(target, { label: 'finder', phase: 'Find', schema: FINDINGS })
const findings = found.findings || []
log(`${findings.length} candidates; verifying each with ${voters} skeptics`)

// Phase 2 — pipeline: each finding streams into a panel of independent skeptics.
// A finding is kept only if a majority fail to refute it.
phase('Verify')
const judged = await pipeline(findings, (finding) =>
  parallel(
    Array.from({ length: voters }, () => () =>
      agent(
        `Try to REFUTE this finding using independent reasoning. Default to refuted=true if unsure.\n` +
          `Title: ${finding.title}\nDetail: ${finding.detail}`,
        { phase: 'Verify', schema: VERDICT }
      )
    )
  ).then((votes) => {
    const valid = votes.filter(Boolean)
    const refutations = valid.filter((v) => v.refuted).length
    return { finding, kept: refutations <= Math.floor(voters / 2) }
  })
)

const confirmed = judged.filter(Boolean).filter((j) => j.kept).map((j) => j.finding)
return { confirmed, considered: findings.length }
