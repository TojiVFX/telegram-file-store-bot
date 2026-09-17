# In-Memory MongoDB Fallback Specification & Developer Guide

> [!CAUTION]
> **DEVELOPMENT & DEMO ONLY — NEVER USE IN PRODUCTION**
> 
> The in-memory fallback engine (`InMemoryCollection` and `inMemoryDb` in `src/bot-common.js`) is an **ephemeral mock store** activated only when the `MONGODB_URI` environment variable is not defined.
> 
> - **Zero Persistence**: All stored files, batch mappings, user profiles, ban lists, tokens, and settings are held strictly in process memory and are **permanently wiped** whenever the container or Node.js process terminates or restarts.
> - **Zero Cross-Instance Sharing**: If the bot is horizontally scaled across multiple instances without MongoDB, instances will have completely partitioned states.
> - **Incomplete MongoDB Semantics**: This mock implements only the narrow subset of MongoDB operations required by the bot's core flows. It does NOT provide full MongoDB engine fidelity.

---

## Supported vs. Unsupported Capabilities Matrix

Before introducing new MongoDB queries or update operators to the codebase, review this matrix. If a required operator is unsupported, you must either extend `InMemoryCollection` in `src/bot-common.js` to support it or be aware that tests and mock-mode runs will fail.

### 1. Filter & Query Operators (`_matches`)

| Operator | Status | Notes & Limitations |
|---|---|---|
| Direct Key-Value Equality | **Supported** | `doc[key] === val` (scalar comparison). |
| `$or` | **Supported** | Array of sub-filter objects: `{ $or: [{ a: 1 }, { b: 2 }] }`. |
| `$exists` | **Supported** | `{ field: { $exists: true/false } }`. |
| `$in` | **Supported** | `{ field: { $in: [val1, val2] } }`. |
| `$ne` | **Supported** | `{ field: { $ne: val } }`. |
| `$gt`, `$gte`, `$lt`, `$lte` | **Supported** | Numbers and `Date` objects (handles `expiresAt`, `createdAt`). |
| `$regex` | **Supported** | `{ field: { $regex: 'pattern' } }` evaluated via `new RegExp(...)`. |
| `$expr` | **Partial** | Strictly supports `$expr: { $lt: ['$fieldRef', '$targetRef'] }` (e.g. `accessCount < maxUses`). |
| `$and` | *Implicit Only* | Top-level object keys act as implicit AND. Explicit `{ $and: [...] }` is **NOT** supported. |
| `$nor`, `$not` | **NOT Supported** | Logical NOR and NOT are not implemented. |
| `$nin` | **NOT Supported** | Not-in-array operator is not implemented. |
| `$elemMatch`, `$all`, `$size` | **NOT Supported** | Array element query expressions are not implemented. |
| Dot-Notation Paths | **NOT Supported** | Nested subdocument path traversal (e.g. `'qualities.fileId': 'xyz'`) is not supported. |
| `$text`, `$where`, `$mod`, `$type` | **NOT Supported** | Full-text, JavaScript evaluation, and schema type operators are not implemented. |
| Geospatial / Bitwise | **NOT Supported** | All `$geo*` and `$bits*` operators are unsupported. |

---

### 2. Cursor Methods (`find()`)

| Cursor Method | Status | Notes & Limitations |
|---|---|---|
| `.sort({ field: 1 \| -1 })` | **Partial** | Supports sorting by a **single field only**. Multi-field sorting is **NOT** supported. Supports Date & scalar comparison. |
| `.skip(n)` | **Supported** | Slices the in-memory array from index `n`. |
| `.limit(n)` | **Supported** | Slices the in-memory array up to `n` elements. |
| `.toArray()` | **Supported** | Returns cloned array of matching documents asynchronously. |
| `.project()` / Projection | **NOT Supported** | Returns full cloned documents; field projection is not applied. |
| `.count()` | **NOT Supported** | Use `collection.countDocuments(filter)` instead. |
| `.map()`, `.forEach()` | **NOT Supported** | Chained iteration methods are not supported. |
| `.next()`, `.hasNext()` | **NOT Supported** | Streaming cursor pagination is not supported. |
| `.batchSize()`, `.collation()` | **NOT Supported** | Cursor performance tuning modifiers are unsupported. |

---

### 3. Update Operators (`updateOne`, `updateMany`, `findOneAndUpdate`)

| Operator | Status | Notes & Limitations |
|---|---|---|
| `$set` | **Supported** | Shallow `Object.assign` onto the target document. Nested path notation (`'a.b': 1`) is **NOT** supported. |
| `$inc` | **Supported** | Increments numeric fields: `{ $inc: { accessCount: 1 } }`. |
| `$push` | **Supported** | Pushes value into array field. Initializes array if undefined. |
| `$addToSet` | **Supported** | Pushes value into array only if not already present (`includes(v)` check). |
| `$unset` | **Partial** | Deletes keys from document (`updateMany` only). |
| `$setOnInsert` | **Supported** | Applied only when an `upsert: true` operation creates a new document. |
| `$pull`, `$pullAll`, `$pop` | **NOT Supported** | Array removal operators are not implemented. |
| `$rename` | **NOT Supported** | Field renaming is not implemented. |
| `$min`, `$max`, `$mul` | **NOT Supported** | Math update operators are not implemented. |
| Positional Operator `$` | **NOT Supported** | Updating specific array elements by index or match query is not supported. |

---

### 4. Aggregation Pipeline Stages (`aggregate()`)

| Pipeline Stage | Status | Notes & Limitations |
|---|---|---|
| `$match` | **Supported** | Filters input documents using `_matches()`. |
| `$group` | **Partial** | Strictly supports sum aggregation: `{ $group: { _id: null, total: { $sum: '$field' } } }` or counting. |
| `$facet` | **Supported** | Executes independent sub-pipelines per facet key. |
| `$count` | **Supported** | Returns document count in `{ [countField]: n }` format. |
| `$project`, `$addFields` | **NOT Supported** | Document transformation stages are not implemented. |
| `$unwind` | **NOT Supported** | Array unwinding is not implemented. |
| `$lookup` | **NOT Supported** | Cross-collection joins are not implemented. |
| `$sort`, `$skip`, `$limit` in pipeline | **NOT Supported** | Cursor stages inside pipeline are not implemented (use cursor methods on `find()` instead). |

---

### 5. Indexes & Database Commands

| Feature | Status | Notes & Limitations |
|---|---|---|
| `createIndex()` | **No-op Stub** | Returns `'ok'`. Does NOT enforce uniqueness (except for primary `_id`), does NOT build index trees, and does NOT auto-expire documents for TTL indexes (`expireAfterSeconds`). |
| `command({ dbStats: 1 })` | **Mock Stub** | Returns static `{ storageSize: 1048576, dataSize: 524288 }` for health checks. |

---

## Safe Development Guidelines

1. **Always test with real MongoDB before production release**:
   While the unit test suite runs against the in-memory fallback for speed and zero dependencies, staging and production deployments MUST be tested against a real MongoDB cluster (e.g. MongoDB Atlas or a local Docker `mongo:7` container).
2. **Never rely on background TTL indexes in mock mode**:
   In production MongoDB, `{ expireAfterSeconds: 0 }` automatically purges expired sessions. In mock mode, TTL cleanup relies entirely on application-level background workers (`startAutoDeleteSweepWorker`).
3. **Keep update payloads shallow**:
   Avoid updating nested keys via dot notation (e.g. `{ $set: { 'meta.updatedAt': new Date() } }`). Instead, set top-level objects or flatten document schemas.
4. **Log warning vigilance**:
   If you observe the critical in-memory warning banner in production logs:
   ```
   *******************************************************************************
   * [CRITICAL] RUNNING WITH IN-MEMORY MOCK DATABASE (MONGODB_URI NOT CONFIGURED) *
   *******************************************************************************
   ```
   Immediately configure `MONGODB_URI` in the production environment variables and restart the container.
