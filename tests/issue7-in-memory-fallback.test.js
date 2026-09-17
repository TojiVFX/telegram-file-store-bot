import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getCollection,
  isMockDatabaseActive,
  emitMockDbWarning,
  startMockDbWarningWorker,
  stopMockDbWarningWorker
} from '../src/bot-common.js';

describe('Issue 7: In-Memory Mongo Fallback Containment & Guardrails', () => {
  it('isMockDatabaseActive correctly reports true when MONGODB_URI is not configured', () => {
    assert.equal(isMockDatabaseActive(), true);
  });

  it('emitMockDbWarning outputs the loud critical warning banner', () => {
    let captured = '';
    const originalWarn = console.warn;
    console.warn = (...args) => {
      captured += args.join(' ') + '\n';
    };

    try {
      emitMockDbWarning();
      assert.ok(captured.includes('[CRITICAL] RUNNING WITH IN-MEMORY MOCK DATABASE'));
      assert.ok(captured.includes('ALL DATA'));
      assert.ok(captured.includes('NEVER use this mode in production'));
    } finally {
      console.warn = originalWarn;
    }
  });

  it('warning worker can be started and cleanly stopped', () => {
    startMockDbWarningWorker(5000);
    // Calling start again is idempotent
    startMockDbWarningWorker(5000);
    stopMockDbWarningWorker();
    // Stop again is idempotent
    stopMockDbWarningWorker();
  });

  it('in-memory collection supports documented filter and query operators', async () => {
    const col = await getCollection('test_issue7_queries');

    await col.insertOne({ _id: 'doc1', category: 'A', score: 10, tags: ['news'], active: true });
    await col.insertOne({ _id: 'doc2', category: 'B', score: 25, tags: ['tech'], active: false });
    await col.insertOne({ _id: 'doc3', category: 'A', score: 50, tags: ['news', 'tech'], active: true });

    // $or
    const orDocs = await col.find({ $or: [{ category: 'B' }, { score: 50 }] }).toArray();
    assert.equal(orDocs.length, 2);

    // $gt, $lte
    const rangeDocs = await col.find({ score: { $gt: 10, $lte: 50 } }).toArray();
    assert.equal(rangeDocs.length, 2);

    // $in
    const inDocs = await col.find({ category: { $in: ['B', 'C'] } }).toArray();
    assert.equal(inDocs.length, 1);
    assert.equal(inDocs[0]._id, 'doc2');

    // $exists
    const existsDocs = await col.find({ tags: { $exists: true } }).toArray();
    assert.equal(existsDocs.length, 3);

    // $regex
    const regexDocs = await col.find({ category: { $regex: '^A$' } }).toArray();
    assert.equal(regexDocs.length, 2);

    // Sorting and pagination
    const sorted = await col.find({}).sort({ score: -1 }).skip(1).limit(1).toArray();
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].score, 25);
  });

  it('in-memory collection supports documented update operators', async () => {
    const col = await getCollection('test_issue7_updates');

    await col.updateOne(
      { _id: 'item1' },
      {
        $setOnInsert: { created: true },
        $set: { title: 'Initial' },
        $inc: { views: 5 },
        $push: { history: 'v1' },
        $addToSet: { labels: 'featured' }
      },
      { upsert: true }
    );

    let doc = await col.findOne({ _id: 'item1' });
    assert.equal(doc.title, 'Initial');
    assert.equal(doc.views, 5);
    assert.deepEqual(doc.history, ['v1']);
    assert.deepEqual(doc.labels, ['featured']);

    // Duplicate $addToSet should not add duplicate
    await col.updateOne(
      { _id: 'item1' },
      {
        $inc: { views: 3 },
        $addToSet: { labels: 'featured' },
        $push: { history: 'v2' }
      }
    );

    doc = await col.findOne({ _id: 'item1' });
    assert.equal(doc.views, 8);
    assert.deepEqual(doc.labels, ['featured']);
    assert.deepEqual(doc.history, ['v1', 'v2']);
  });

  it('docs/in-memory-fallback.md documentation exists and covers all operator categories', () => {
    const docPath = path.resolve('docs/in-memory-fallback.md');
    assert.ok(fs.existsSync(docPath), 'docs/in-memory-fallback.md must exist');

    const content = fs.readFileSync(docPath, 'utf8');
    assert.ok(content.includes('Supported vs. Unsupported Capabilities Matrix'));
    assert.ok(content.includes('Filter & Query Operators'));
    assert.ok(content.includes('Cursor Methods'));
    assert.ok(content.includes('Update Operators'));
    assert.ok(content.includes('Aggregation Pipeline Stages'));
    assert.ok(content.includes('Safe Development Guidelines'));
  });
});
