// Run the analytics ingest and print a short report.
// Usage: node scripts/ingest.mjs [dbPath]
import { defaultDbPath, ingestAll, openDatabase, summary } from '../lib/index.js'

const db = openDatabase(process.argv[2] ?? defaultDbPath())
const started = Date.now()
const result = await ingestAll(db)
const all = summary(db, 0, Date.now())
console.log(`ingested ${result.filesParsed}/${result.files} changed files, ${result.requests} requests in ${Date.now() - started}ms`)
console.log(`total ${all.totals.requests} requests | in ${all.totals.input} | cacheRead ${all.totals.cacheRead} | out ${all.totals.output}`)
console.log(`cost ¥${all.totals.cost.toFixed(2)} | cache hit ${(all.totals.cacheHitRate * 100).toFixed(2)}% | avg ¥${all.totals.avgCost.toFixed(4)}`)
for (const model of all.byModel) console.log(`  ${model.model}: ${model.requests} req ¥${(model.cost ?? 0).toFixed(2)}`)
db.close()
