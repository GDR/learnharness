import { test, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
	type SourceEvidence,
	type SourceEvidenceLocation,
	sourceEvidenceSchema,
	sourceEvidenceLocationSchema,
	validateSourceEvidence,
	computeEvidenceDedupKey,
} from "../src/core/contracts/evidence.ts";
import { createGraphStore } from "../src/store/graph.ts";
import type { GraphStore } from "../src/core/ports.ts";

describe("Milestone C Slice 4: SourceEvidence Contracts & Validation", () => {
	it("validates full SourceEvidence schema with all fields", () => {
		const fullEvidence: SourceEvidence = {
			id: "ev_full_001",
			propositionId: "prop_gravity_01",
			sourceId: "src_physics",
			documentId: "doc_newton",
			documentPath: "vault/physics/newton.md",
			chunkId: "chk_001",
			heading: "Universal Gravitation",
			headingHierarchy: ["Physics", "Mechanics", "Universal Gravitation"],
			range: {
				startOffset: 150,
				endOffset: 520,
			},
			excerpt: "Every particle attracts every other particle in the universe...",
			recordedAt: "2026-10-27T08:00:00Z",
			confidence: 0.98,
			revisionId: "rev_newton_v1",
			projectId: "proj_science",
			provenance: "explicit-source",
			status: "active",
			extractorVersion: "2.4.0",
			location: {
				heading: "Universal Gravitation",
				blockId: "^law-of-gravitation",
				startOffset: 150,
				endOffset: 520,
			},
		};

		const parsed = sourceEvidenceSchema.parse(fullEvidence);
		assert.equal(parsed.id, "ev_full_001");
		assert.equal(parsed.propositionId, "prop_gravity_01");
		assert.equal(parsed.sourceId, "src_physics");
		assert.equal(parsed.documentId, "doc_newton");
		assert.equal(parsed.documentPath, "vault/physics/newton.md");
		assert.equal(parsed.chunkId, "chk_001");
		assert.equal(parsed.heading, "Universal Gravitation");
		assert.deepEqual(parsed.headingHierarchy, ["Physics", "Mechanics", "Universal Gravitation"]);
		assert.equal(parsed.range?.startOffset, 150);
		assert.equal(parsed.range?.endOffset, 520);
		assert.equal(parsed.confidence, 0.98);
		assert.equal(parsed.provenance, "explicit-source");
		assert.equal(parsed.status, "active");
		assert.equal(parsed.location.blockId, "^law-of-gravitation");
	});

	it("applies default values for optional fields", () => {
		const minimalEvidence = {
			id: "ev_min_001",
			propositionId: "prop_wave_01",
			sourceId: "src_quantum",
			documentId: "doc_schrodinger",
		};

		const parsed = sourceEvidenceSchema.parse(minimalEvidence);
		assert.equal(parsed.provenance, "explicit-source");
		assert.equal(parsed.status, "active");
		assert.deepEqual(parsed.headingHierarchy, []);
		assert.deepEqual(parsed.location, {});
	});

	it("validates validateSourceEvidence helper", () => {
		const valid = {
			id: "ev_helper_01",
			propositionId: "prop_1",
			sourceId: "src_1",
			documentId: "doc_1",
		};
		const parsed = validateSourceEvidence(valid);
		assert.equal(parsed.id, "ev_helper_01");
		assert.throws(() => validateSourceEvidence({ id: "" }));
	});

	it("computes deterministic deduplication keys", () => {
		const ev1: SourceEvidence = {
			id: "ev_dedup_01",
			propositionId: "prop_energy",
			sourceId: "src_thermo",
			documentId: "doc_first_law",
			chunkId: "chk_42",
			revisionId: "rev_1",
			range: { startOffset: 100, endOffset: 300 },
		};
		const ev2: SourceEvidence = {
			id: "ev_dedup_02",
			propositionId: "prop_energy",
			sourceId: "src_thermo",
			documentId: "doc_first_law",
			chunkId: "chk_42",
			revisionId: "rev_1",
			range: { startOffset: 100, endOffset: 300 },
		};
		assert.equal(computeEvidenceDedupKey(ev1), computeEvidenceDedupKey(ev2));
		assert.equal(computeEvidenceDedupKey(ev1), "doc_first_law:prop_energy:chk_42:100_300:rev_1");

		const evFallbackLocation: SourceEvidence = {
			id: "ev_dedup_03",
			propositionId: "prop_energy",
			sourceId: "src_thermo",
			documentId: "doc_first_law",
			location: { startOffset: 50, endOffset: 120 },
		};
		assert.equal(computeEvidenceDedupKey(evFallbackLocation), "doc_first_law:prop_energy::50_120:");
	});

	it("rejects invalid provenance and status", () => {
		const base: SourceEvidence = {
			id: "ev_val_01",
			propositionId: "prop_1",
			sourceId: "src_1",
			documentId: "doc_1",
		};
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, provenance: "hallucinated" }));
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, status: "pending" }));
	});

	it("rejects negative or non-integer offsets in location and range", () => {
		assert.throws(() => sourceEvidenceLocationSchema.parse({ startOffset: -1 }));
		assert.throws(() => sourceEvidenceLocationSchema.parse({ endOffset: -10 }));
		assert.throws(() => sourceEvidenceLocationSchema.parse({ startOffset: 12.34 }));

		const base: SourceEvidence = {
			id: "ev_val_02",
			propositionId: "prop_1",
			sourceId: "src_1",
			documentId: "doc_1",
		};
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, location: { startOffset: -5 } }));
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, range: { startOffset: -1, endOffset: 10 } }));
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, range: { startOffset: 0, endOffset: -1 } }));
	});

	it("rejects out-of-range confidence scores", () => {
		const base: SourceEvidence = {
			id: "ev_val_03",
			propositionId: "prop_1",
			sourceId: "src_1",
			documentId: "doc_1",
		};
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, confidence: -0.1 }));
		assert.throws(() => sourceEvidenceSchema.parse({ ...base, confidence: 1.05 }));
		assert.doesNotThrow(() => sourceEvidenceSchema.parse({ ...base, confidence: 0 }));
		assert.doesNotThrow(() => sourceEvidenceSchema.parse({ ...base, confidence: 1 }));
	});

	it("rejects empty identifiers", () => {
		assert.throws(() => sourceEvidenceSchema.parse({ id: "", propositionId: "p", sourceId: "s", documentId: "d" }));
		assert.throws(() => sourceEvidenceSchema.parse({ id: "e", propositionId: "", sourceId: "s", documentId: "d" }));
		assert.throws(() => sourceEvidenceSchema.parse({ id: "e", propositionId: "p", sourceId: "", documentId: "d" }));
		assert.throws(() => sourceEvidenceSchema.parse({ id: "e", propositionId: "p", sourceId: "s", documentId: "" }));
	});
});

describe("Milestone C Slice 4: GraphStore SourceEvidence Ledger Storage", () => {
	let tempDir: string;
	let store: GraphStore;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-evidence-ledger-test-"));
		store = createGraphStore(tempDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("handles non-existent evidence.jsonl gracefully on initial read", async () => {
		assert.equal(fs.existsSync(path.join(tempDir, "evidence.jsonl")), false);
		const all = await store.readEvidence!();
		assert.deepEqual(all, []);

		const byProp = await store.getEvidenceForProposition!("prop_none");
		assert.deepEqual(byProp, []);

		const byDoc = await store.getEvidenceForDocument!("doc_none");
		assert.deepEqual(byDoc, []);

		const bySrc = await store.getEvidenceForSource!("src_none");
		assert.deepEqual(bySrc, []);
	});

	it("appends single evidence record to evidence.jsonl and in-memory index", async () => {
		const ev: SourceEvidence = {
			id: "ev_test_01",
			propositionId: "prop_dna_structure",
			sourceId: "src_genetics",
			documentId: "doc_watson_crick",
			documentPath: "vault/biology/dna.md",
			chunkId: "chk_double_helix",
			range: { startOffset: 200, endOffset: 450 },
			provenance: "explicit-source",
			status: "active",
		};

		await store.appendEvidence!(ev);

		const evidenceFile = path.join(tempDir, "evidence.jsonl");
		assert.equal(fs.existsSync(evidenceFile), true);

		const lines = fs.readFileSync(evidenceFile, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
		const written = JSON.parse(lines[0]!);
		assert.equal(written.id, "ev_test_01");
		assert.equal(written.propositionId, "prop_dna_structure");

		const read = await store.readEvidence!();
		assert.equal(read.length, 1);
		assert.equal(read[0]?.id, "ev_test_01");

		const byProp = await store.getEvidenceForProposition!("prop_dna_structure");
		assert.equal(byProp.length, 1);
		assert.equal(byProp[0]?.id, "ev_test_01");
	});

	it("appends a batch of evidence records efficiently", async () => {
		const batch: SourceEvidence[] = [
			{
				id: "ev_batch_01",
				propositionId: "prop_relativity_01",
				sourceId: "src_physics",
				documentId: "doc_einstein",
				range: { startOffset: 0, endOffset: 100 },
			},
			{
				id: "ev_batch_02",
				propositionId: "prop_relativity_02",
				sourceId: "src_physics",
				documentId: "doc_einstein",
				range: { startOffset: 105, endOffset: 250 },
			},
			{
				id: "ev_batch_03",
				propositionId: "prop_relativity_01",
				sourceId: "src_physics",
				documentId: "doc_poincare",
				range: { startOffset: 50, endOffset: 180 },
			},
		];

		await store.appendEvidenceBatch!(batch);

		const all = await store.readEvidence!();
		assert.equal(all.length, 3);

		const einsteinEvidence = await store.getEvidenceForDocument!("doc_einstein");
		assert.equal(einsteinEvidence.length, 2);

		const prop1Evidence = await store.getEvidenceForProposition!("prop_relativity_01");
		assert.equal(prop1Evidence.length, 2);

		const physicsEvidence = await store.getEvidenceForSource!("src_physics");
		assert.equal(physicsEvidence.length, 3);
	});

	it("supports calling appendEvidence with an array of records", async () => {
		const list: SourceEvidence[] = [
			{
				id: "ev_arr_01",
				propositionId: "prop_array_01",
				sourceId: "src_1",
				documentId: "doc_1",
			},
			{
				id: "ev_arr_02",
				propositionId: "prop_array_02",
				sourceId: "src_1",
				documentId: "doc_1",
			},
		];
		await store.appendEvidence!(list);
		const all = await store.readEvidence!();
		assert.equal(all.length, 2);
	});

	it("prevents duplicate lines for exact duplicate evidence (Scenario A)", async () => {
		const ev: SourceEvidence = {
			id: "ev_dup_01",
			propositionId: "prop_pythagoras",
			sourceId: "src_geometry",
			documentId: "doc_euclid",
			chunkId: "chk_book1",
			revisionId: "rev_stable_1",
			range: { startOffset: 50, endOffset: 150 },
			status: "active",
		};

		await store.appendEvidence!(ev);
		await store.appendEvidence!(ev); // duplicate call

		const evidenceFile = path.join(tempDir, "evidence.jsonl");
		const lines = fs.readFileSync(evidenceFile, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1, "Duplicate append should NOT write extra line to evidence.jsonl");

		const all = await store.readEvidence!();
		assert.equal(all.length, 1);
	});

	it("transitions status and supports active vs superseded filtering (Scenario B)", async () => {
		const initialEvidence: SourceEvidence = {
			id: "ev_trans_01",
			propositionId: "prop_plogiston",
			sourceId: "src_chem",
			documentId: "doc_history_chem",
			chunkId: "chk_combustion",
			revisionId: "rev_old",
			range: { startOffset: 10, endOffset: 90 },
			status: "active",
		};

		await store.appendEvidence!(initialEvidence);
		assert.equal((await store.readEvidence!({ status: "active" })).length, 1);
		assert.equal((await store.readEvidence!({ status: "superseded" })).length, 0);

		// Append superseding transition
		const supersededEvidence: SourceEvidence = {
			...initialEvidence,
			status: "superseded",
		};
		await store.appendEvidence!(supersededEvidence);

		// Verified filtered queries
		const activeList = await store.readEvidence!({ status: "active" });
		assert.equal(activeList.length, 0, "Initial evidence should no longer be active");

		const supersededList = await store.readEvidence!({ status: "superseded" });
		assert.equal(supersededList.length, 1);
		assert.equal(supersededList[0]?.id, "ev_trans_01");
		assert.equal(supersededList[0]?.status, "superseded");

		const allList = await store.readEvidence!();
		assert.equal(allList.length, 1);
		assert.equal(allList[0]?.status, "superseded");
	});

	it("skips corrupted and malformed lines when loading evidence.jsonl", async () => {
		const evidenceFile = path.join(tempDir, "evidence.jsonl");
		const corruptLines = [
			JSON.stringify({
				id: "ev_good_01",
				propositionId: "prop_valid",
				sourceId: "src_v",
				documentId: "doc_v",
			}),
			"{{{ malformed json line",
			"", // empty line
			JSON.stringify({ not: "a valid source evidence shape" }),
			"   ",
			JSON.stringify({
				id: "ev_good_02",
				propositionId: "prop_valid_2",
				sourceId: "src_v",
				documentId: "doc_v",
			}),
		].join("\n") + "\n";

		fs.writeFileSync(evidenceFile, corruptLines, "utf-8");
		fs.rmSync(path.join(tempDir, "generation.json"), { force: true });

		// Fresh store instance pointing to pre-existing corrupt file
		const newStore = createGraphStore(tempDir);
		const loaded = await newStore.readEvidence!();
		assert.equal(loaded.length, 2, "Should only load the 2 valid evidence records");
		assert.equal(loaded[0]?.id, "ev_good_01");
		assert.equal(loaded[1]?.id, "ev_good_02");
	});

	it("removes all evidence associated with a deleted document", async () => {
		await store.appendEvidenceBatch!([
			{
				id: "ev_del_01",
				propositionId: "prop_shared",
				sourceId: "src_shared",
				documentId: "doc_to_delete",
			},
			{
				id: "ev_del_02",
				propositionId: "prop_other",
				sourceId: "src_shared",
				documentId: "doc_to_delete",
			},
			{
				id: "ev_keep_01",
				propositionId: "prop_shared",
				sourceId: "src_shared",
				documentId: "doc_to_keep",
			},
		]);

		assert.equal((await store.readEvidence!()).length, 3);
		await store.removeEvidenceForDocument!("doc_to_delete");

		const remaining = await store.readEvidence!();
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0]?.id, "ev_keep_01");
		assert.equal(remaining[0]?.documentId, "doc_to_keep");

		const deletedDocEvidence = await store.getEvidenceForDocument!("doc_to_delete");
		assert.equal(deletedDocEvidence.length, 0);

		// Verify on-disk ledger was updated atomically
		const evidenceFile = path.join(tempDir, "evidence.jsonl");
		const lines = fs.readFileSync(evidenceFile, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]!).id, "ev_keep_01");
	});

	it("supports atomic ledger rewriting via rewriteLedgers", async () => {
		await store.appendEvidence!({
			id: "ev_rw_old",
			propositionId: "prop_rw",
			sourceId: "src_rw",
			documentId: "doc_rw",
		});

		const newEvidenceList: SourceEvidence[] = [
			{
				id: "ev_rw_new_1",
				propositionId: "prop_compact",
				sourceId: "src_compact",
				documentId: "doc_compact",
			},
			{
				id: "ev_rw_new_2",
				propositionId: "prop_compact",
				sourceId: "src_compact",
				documentId: "doc_compact",
			},
		];

		store.rewriteLedgers({ evidence: newEvidenceList });

		const read = await store.readEvidence!();
		assert.equal(read.length, 2);
		assert.equal(read[0]?.id, "ev_rw_new_1");
		assert.equal(read[1]?.id, "ev_rw_new_2");

		const propEvidence = await store.getEvidenceForProposition!("prop_compact");
		assert.equal(propEvidence.length, 2);
	});

	it("maintains strict project isolation between two independent graph stores", async () => {
		const dirA = path.join(tempDir, "proj_a", "graph");
		const dirB = path.join(tempDir, "proj_b", "graph");

		const storeA = createGraphStore(dirA);
		const storeB = createGraphStore(dirB);

		await storeA.appendEvidence!({
			id: "ev_proj_a_01",
			propositionId: "prop_a",
			sourceId: "src_a",
			documentId: "doc_a",
			projectId: "proj_a",
		});

		await storeB.appendEvidence!({
			id: "ev_proj_b_01",
			propositionId: "prop_b",
			sourceId: "src_b",
			documentId: "doc_b",
			projectId: "proj_b",
		});

		const listA = await storeA.readEvidence!();
		const listB = await storeB.readEvidence!();

		assert.equal(listA.length, 1);
		assert.equal(listA[0]?.id, "ev_proj_a_01");

		assert.equal(listB.length, 1);
		assert.equal(listB[0]?.id, "ev_proj_b_01");

		assert.equal((await storeA.getEvidenceForProposition!("prop_b")).length, 0);
		assert.equal((await storeB.getEvidenceForProposition!("prop_a")).length, 0);
	});

	it("recovers and parses persisted evidence across store re-instantiations", async () => {
		await store.appendEvidenceBatch!([
			{
				id: "ev_persisted_01",
				propositionId: "prop_reboot",
				sourceId: "src_boot",
				documentId: "doc_boot",
				range: { startOffset: 10, endOffset: 60 },
			},
			{
				id: "ev_persisted_02",
				propositionId: "prop_reboot",
				sourceId: "src_boot",
				documentId: "doc_boot",
				range: { startOffset: 70, endOffset: 150 },
			},
		]);

		// Create a completely separate store pointing to the same folder
		const secondStore = createGraphStore(tempDir);
		const persisted = await secondStore.readEvidence!();
		assert.equal(persisted.length, 2);

		const propRecords = await secondStore.getEvidenceForProposition!("prop_reboot");
		assert.equal(propRecords.length, 2);
		assert.equal(propRecords[0]?.id, "ev_persisted_01");
		assert.equal(propRecords[1]?.id, "ev_persisted_02");
	});

	it("serializes concurrent writes via mutex without corruption or race conditions (Scenario E)", async () => {
		const CONCURRENCY = 20;
		const tasks = Array.from({ length: CONCURRENCY }, (_, i) => {
			const ev: SourceEvidence = {
				id: `ev_concurrent_${String(i).padStart(3, "0")}`,
				propositionId: `prop_stress_${i % 4}`,
				sourceId: "src_stress",
				documentId: `doc_stress_${i % 2}`,
				range: { startOffset: i * 50, endOffset: (i + 1) * 50 },
			};
			return store.appendEvidence!(ev);
		});

		await Promise.all(tasks);

		const evidenceFile = path.join(tempDir, "evidence.jsonl");
		const fileContent = fs.readFileSync(evidenceFile, "utf-8").trim();
		const lines = fileContent.split("\n");

		assert.equal(lines.length, CONCURRENCY, `Must contain exactly ${CONCURRENCY} lines`);

		// Verify every line is valid uncorrupted JSON
		for (const line of lines) {
			assert.doesNotThrow(() => JSON.parse(line));
		}

		const memoryRecords = await store.readEvidence!();
		assert.equal(memoryRecords.length, CONCURRENCY);

		// Verify index lookups
		const doc0Records = await store.getEvidenceForDocument!("doc_stress_0");
		assert.equal(doc0Records.length, 10);
	});
});
