/**
 * The Phase 9 checkpoint: one real analysis, end to end, against live data.
 *
 * Builds inputs from the database, runs the engine, assembles the evidence bundle,
 * calls Gemini, runs the semantic guards, persists everything with its statement
 * lineage, then reads it all back out of Postgres and prints it.
 *
 * Everything shown is read back from storage rather than from memory. A demonstration
 * that prints what it just computed proves the computation; printing what the database
 * returns proves the round trip, which is the part that has to work tomorrow.
 *
 * Usage:
 *   node scripts/checkpoint.mjs             real Gemini call
 *   node scripts/checkpoint.mjs --fabricate inject a fabricated number, show rejection
 *   node scripts/checkpoint.mjs --predict   inject a predictive claim, show rejection
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
for (const [k, v] of Object.entries(env)) process.env[k] = v;

const { createDb, assets, configProfiles, analyses, analysisStatements, aiGenerations, fundamentalFactors } =
  await import('../packages/db/dist/index.js');
const { runFundamentalEngine, isScored } = await import('../packages/engines/dist/index.js');
const { buildFundamentalInputs, buildEvidenceBundle, persistAnalysis } = await import(
  '../packages/worker/dist/index.js'
);
const { GeminiClient, buildPrompt, runGuards, permittedNumbersFrom, PROMPT_NAME, PROMPT_VERSION, GUARD_VERSION } =
  await import('../packages/ai/dist/index.js');
const { DEFAULT_RUNTIME_CONFIG } = await import('../packages/config/dist/index.js');
const { eq, sql, asc } = await import('drizzle-orm');

const MODE = process.argv.includes('--fabricate')
  ? 'FABRICATE'
  : process.argv.includes('--predict')
    ? 'PREDICT'
    : 'REAL';

const rule = (title) => console.log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);

const h = createDb({ connectionString: env.DATABASE_URL });
const now = new Date();

// ── 1. Inputs ───────────────────────────────────────────────────────────────
const newsView = {
  kind: 'INSUFFICIENT_VOLUME',
  articleCount: 6,
  sourceCount: 3,
  requiredArticles: DEFAULT_RUNTIME_CONFIG.news.minArticlesForScore,
  requiredSources: DEFAULT_RUNTIME_CONFIG.news.minSourcesForScore,
};
const { inputs, facts } = await buildFundamentalInputs(h.db, { now, news: newsView });

// ── 2. Engine ───────────────────────────────────────────────────────────────
const c = DEFAULT_RUNTIME_CONFIG;
const result = runFundamentalEngine(
  inputs,
  {
    factors: c.factors,
    normalisation: c.normalisation,
    inflationNetRule: c.inflationNetRule,
    confidence: c.confidence,
    eventRisk: { warnWindowMs: c.eventRisk.warnWindowMs, imminentWindowMs: c.eventRisk.imminentWindowMs },
  },
  now,
);

rule('1. ENGINE RESULT');
console.log(`status     ${result.status}`);
console.log(`coverage   ${(result.coverage * 100).toFixed(1)}%`);
if (result.status === 'SCORED') {
  console.log(`score      ${result.signedScore.toFixed(1)} signed / ${result.displayScore} display — ${result.band}`);
  console.log(`confidence ${result.confidence.value} ${result.confidence.level}`);
}
for (const f of result.factors) {
  console.log(
    isScored(f)
      ? `  ${f.factorId} ${f.score.toFixed(1).padStart(7)}  eff=${(f.weight * f.confidence).toFixed(3)} ${f.freshness}`
      : `  ${f.factorId}  ABSTAIN  eff=0.000  ${f.reason}`,
  );
}

// ── 3. Evidence bundle ──────────────────────────────────────────────────────
const [asset] = await h.db.select().from(assets).where(eq(assets.symbol, 'XAUUSD')).limit(1);
const [profile] = await h.db.select().from(configProfiles).where(eq(configProfiles.isActive, true)).limit(1);

const bundle = buildEvidenceBundle({ asset: asset.symbol, result, facts });

rule('2. EVIDENCE BUNDLE — exactly what Gemini receives');
console.log(JSON.stringify(bundle, null, 2));

// ── 4. Gemini ───────────────────────────────────────────────────────────────
let ai;
if (result.status !== 'SCORED') {
  rule('3. AI — NOT CALLED');
  console.log('The run is INSUFFICIENT_DATA, so there is no score to describe.');
} else {
  const prompt = buildPrompt({ bundleJson: JSON.stringify(bundle, null, 2), asset: asset.symbol });
  const client = new GeminiClient({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL ?? 'gemini-3.5-flash',
    fallbackModel: env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.6-flash',
  });

  const geminiResult = await client.generate(prompt);

  rule('3. GEMINI RAW STRUCTURED RESPONSE');
  console.log(`model    ${geminiResult.model ?? '(none reached)'}`);
  console.log(`kind     ${geminiResult.kind}`);
  if (geminiResult.kind === 'OK') {
    console.log(`latency  ${geminiResult.latencyMs}ms  tokens in/out ${geminiResult.promptTokens}/${geminiResult.responseTokens}`);
    console.log(JSON.stringify(geminiResult.raw, null, 2));
  } else if (geminiResult.kind === 'MALFORMED') {
    console.log('errors:', geminiResult.errors);
    console.log(JSON.stringify(geminiResult.raw, null, 2).slice(0, 1500));
  } else {
    console.log('reason:', geminiResult.reason, '| tried:', geminiResult.modelsTried.join(', '));
  }

  // ── 5. Guards ─────────────────────────────────────────────────────────────
  rule(`4. SEMANTIC GUARDS${MODE === 'REAL' ? '' : `  [INJECTED FAILURE: ${MODE}]`}`);

  if (geminiResult.kind === 'OK') {
    let assessment = geminiResult.assessment;

    // The deliberate failure paths. The model's real answer is tampered with exactly
    // as a hallucinating model would tamper with it, so the guard is exercised on
    // realistic prose rather than on obviously broken input.
    if (MODE === 'FABRICATE') {
      assessment = {
        ...assessment,
        summary: `${assessment.summary} The broad dollar index stands at 121.4, its highest in months.`,
      };
      console.log('Injected: a dollar index of 121.4. The bundle says 118.75.\n');
    } else if (MODE === 'PREDICT') {
      assessment = {
        ...assessment,
        summary: `${assessment.summary} Gold will likely rally as real yields decline further.`,
      };
      console.log('Injected: "Gold will likely rally as real yields decline further."\n');
    }

    const violations = runGuards(assessment, {
      permittedNumbers: permittedNumbersFrom(bundle),
      knownFactorIds: result.factors.map((f) => f.factorId),
      abstainedFactorIds: result.abstained.map((a) => a.factorId),
      requiresGapDisclosure: result.abstained.length > 0,
    });

    if (violations.length === 0) {
      console.log('PASSED — no violations. Every number appears in the bundle; no predictive claims.');
    } else {
      console.log(`REJECTED — ${violations.length} violation(s):`);
      for (const v of violations) {
        console.log(`  [${v.code}] ${v.field}`);
        console.log(`     ${v.detail}`);
        console.log(`     evidence: "${v.evidence}"`);
      }
    }

    ai = {
      providerId: 'gemini',
      model: geminiResult.model,
      promptName: PROMPT_NAME,
      promptVersion: PROMPT_VERSION,
      guardVersion: GUARD_VERSION,
      outcome: violations.length === 0 ? 'VALID' : 'INVALID',
      retryCount: 0,
      rawResponse: geminiResult.raw,
      validationErrors: violations,
      ...(violations.length === 0 ? { assessment } : {}),
      promptTokens: geminiResult.promptTokens,
      responseTokens: geminiResult.responseTokens,
      latencyMs: geminiResult.latencyMs,
    };
  } else {
    console.log('Not run — no valid response to check.');
    ai = {
      providerId: 'gemini',
      model: geminiResult.model ?? 'none',
      promptName: PROMPT_NAME,
      promptVersion: PROMPT_VERSION,
      guardVersion: GUARD_VERSION,
      outcome: geminiResult.kind === 'MALFORMED' ? 'INVALID' : 'PROVIDER_ERROR',
      retryCount: 0,
      rawResponse: geminiResult.kind === 'MALFORMED' ? geminiResult.raw : null,
      validationErrors: geminiResult.kind === 'MALFORMED' ? geminiResult.errors : [geminiResult.reason],
      latencyMs: geminiResult.latencyMs ?? null,
    };
  }
}

// ── 6. Persist ──────────────────────────────────────────────────────────────
const persisted = await persistAnalysis(h.db, {
  assetId: asset.id,
  configProfileId: profile.id,
  result,
  bundle,
  facts,
  ...(ai === undefined ? {} : { ai }),
});

// ── 7. Read it all back ─────────────────────────────────────────────────────
rule('5. STORED ANALYSIS — read back from Postgres');

const [stored] = await h.db.select().from(analyses).where(eq(analyses.id, persisted.analysisId));
console.log(`id                ${stored.id}`);
console.log(`status            ${stored.status}`);
console.log(`fundamental_score ${stored.fundamentalScore ?? 'NULL'}`);
console.log(`confidence        ${stored.confidence ?? 'NULL'} (${stored.confidenceScore ?? 'NULL'})`);
console.log(`coverage          ${stored.coverage}`);
console.log(`unavailable       ${JSON.stringify(stored.unavailableInputs)}`);

const storedFactors = await h.db
  .select()
  .from(fundamentalFactors)
  .where(eq(fundamentalFactors.analysisId, persisted.analysisId))
  .orderBy(asc(fundamentalFactors.factorId));

console.log('\nfundamental_factors:');
for (const f of storedFactors) {
  console.log(
    `  ${f.factorId}  score=${f.score === null ? 'NULL' : f.score.toFixed(1).padStart(6)}  ` +
      `eff=${f.effectiveWeight.toFixed(3)}  ${f.abstainedReason === null ? f.freshness : 'ABSTAINED: ' + f.abstainedReason.slice(0, 46)}`,
  );
}

rule('6. STATEMENT LINEAGE — Amendment A2, as stored');

const statements = await h.db
  .select()
  .from(analysisStatements)
  .where(eq(analysisStatements.analysisId, persisted.analysisId))
  .orderBy(asc(analysisStatements.ordinal));

const byId = new Map(statements.map((s) => [s.id, s]));
const layers = ['FACT', 'INTERPRETATION', 'AI_ASSESSMENT'];

for (const layer of layers) {
  const rows = statements.filter((s) => s.layer === layer);
  console.log(`\n── ${layer}  (${rows.length}) ${'─'.repeat(Math.max(0, 50 - layer.length))}`);
  for (const s of rows.slice(0, layer === 'FACT' ? 4 : 12)) {
    console.log(`\n  [${s.ordinal}] ${s.body}`);
    if (layer === 'FACT') {
      console.log(
        `       ↳ ${s.factTable}#${String(s.factId).slice(0, 8)} · ${s.sourceName} · tier ${s.sourceTier} · ` +
          `${s.freshness} · published ${s.sourceTimestamp.toISOString().slice(0, 10)}`,
      );
    } else {
      const parents = s.derivedFrom.map((id) => byId.get(id)).filter(Boolean);
      const parentLayers = [...new Set(parents.map((p) => p.layer))];
      console.log(`       ↳ derives from ${parents.length} × ${parentLayers.join('/')}`);
      for (const p of parents.slice(0, 2)) {
        console.log(`          · [${p.ordinal}] ${p.body.slice(0, 92)}${p.body.length > 92 ? '…' : ''}`);
      }
      if (parents.length > 2) console.log(`          · … and ${parents.length - 2} more`);
      if (s.aiGenerationId !== null) console.log(`       ↳ ai_generation ${String(s.aiGenerationId).slice(0, 8)}`);
    }
  }
  if (rows.length > (layer === 'FACT' ? 4 : 12)) {
    console.log(`\n  … and ${rows.length - (layer === 'FACT' ? 4 : 12)} more`);
  }
}

const generations = await h.db
  .select()
  .from(aiGenerations)
  .where(eq(aiGenerations.analysisId, persisted.analysisId));

rule('7. AI GENERATION RECORD');
for (const g of generations) {
  console.log(`model     ${g.model}`);
  console.log(`prompt    ${g.promptName} v${g.promptVersion} · guards v${g.guardVersion}`);
  console.log(`outcome   ${g.outcome}`);
  console.log(`tokens    ${g.promptTokens ?? '?'} in / ${g.responseTokens ?? '?'} out · ${g.latencyMs ?? '?'}ms`);
  if (g.validationErrors !== null) {
    console.log(`errors    ${JSON.stringify(g.validationErrors, null, 2).slice(0, 900)}`);
  }
}
if (generations.length === 0) console.log('(none — the AI was not called)');

rule('8. WHAT A USER WOULD SEE');
const aiRows = statements.filter((s) => s.layer === 'AI_ASSESSMENT');
console.log(
  `FACT statements: ${statements.filter((s) => s.layer === 'FACT').length} · ` +
    `INTERPRETATION: ${statements.filter((s) => s.layer === 'INTERPRETATION').length} · ` +
    `AI_ASSESSMENT: ${aiRows.length}`,
);
if (aiRows.length === 0) {
  console.log(
    '\nNo AI layer is rendered. The deterministic layers stand alone, and the run is\n' +
      `stored as ${stored.status} rather than COMPLETE — a rejected generation is visible,\n` +
      'not silently absent.',
  );
} else {
  console.log(`\n  AI ASSESSMENT — ${aiRows[0].body}`);
  console.log(`  ${aiRows[1]?.body ?? ''}`);
}

await h.close();
