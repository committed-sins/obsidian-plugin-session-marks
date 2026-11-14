import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { comparableContent, metadataOf } from '../src/note-content.mjs';
import { createSessionTracker } from '../src/session-tracker.mjs';
import { eligibleNote } from '../src/note-paths.mjs';

// JSON mappings are valid YAML; isolate session behavior from Obsidian's YAML parser.
const api = {
    properties: { created: 'created', updated: 'updated', revision: 'updated_count' },
    getFrontMatterInfo(text)
    {
        const match = text.match(/^---\n([\s\S]*?)\n---\n/);
        return match ?
            { exists: true, frontmatter: match[1], contentStart: match[0].length } :
            { exists: false };
    },
    parseYaml: JSON.parse,
    formatDate: (iso) => iso,
};
const note = (body, fm = {}) => `---\n${JSON.stringify(fm)}\n---\n${body}`;
const hash = async (text) => createHash('sha256').update(text).digest('hex');
const properties = (text) =>
    api.getFrontMatterInfo(text).exists ?
        api.parseYaml(api.getFrontMatterInfo(text).frontmatter) :
        {};
const bodyOf = (text) =>
    api.getFrontMatterInfo(text).exists ?
        text.slice(api.getFrontMatterInfo(text).contentStart) :
        text;
const initial = {
    created: '2025-01-01T00:00:00Z',
    id: 'stable-id',
    updated: '2026-01-01T00:00:00Z',
    updated_count: 7,
    tags: ['home'],
};
function fixture({ excludedFolders = [] } = {})
{
    const files = new Map([['notes/A.md', note('before', initial)]]);
    const storageData = new Map();
    const errors = [],
        writes = [];
    let active = 'notes/A.md',
        failAfterWrite = false;
    const options = {
        api,
        hash,
        storageKey: 'test',
        now: () => new Date('2026-11-11T12:00:00Z'),
        storage: {
            getItem: (key) => storageData.get(key),
            setItem: (key, value) => storageData.set(key, value),
        },
        exists: (path) => files.has(path),
        read: async (path) => files.get(path),
        isActive: (path) => path === active,
        isEligible: (path) => eligibleNote(path, excludedFolders),
        report: (error) => errors.push(error),
        write: async (path, intent, expected) =>
        {
            const fm = properties(files.get(path));
            assert.equal(fm.updated_count ?? 0, expected.count);
            files.set(
                path,
                note(bodyOf(files.get(path)), {
                    ...fm,
                    ...(intent.addCreated ? { created: intent.created } : {}),
                    updated: intent.updated,
                    updated_count: intent.count,
                }),
            );
            writes.push(path);
            if (failAfterWrite) throw new Error('simulated interruption after commit');
        },
    };
    const tracker = createSessionTracker(options);
    const edit = (text, path = 'notes/A.md') =>
    {
        tracker.change(path, files.get(path) ?? '', text);
        files.set(path, text);
    };
    return {
        tracker,
        files,
        edit,
        writes,
        errors,
        storageData,
        options,
        leave: () =>
        {
            active = 'notes/B.md';
        },
        failAfterWrite: () =>
        {
            failAfterWrite = true;
        },
    };
}

test('comparison ignores owned metadata and property order, but retains meaningful properties and body whitespace', () =>
{
    assert.equal(
        comparableContent(note('text', initial), api),
        comparableContent(
            note('text', {
                created: initial.created,
                tags: ['home'],
                updated_count: 900,
                updated: 'later',
                id: 'stable-id',
            }),
            api,
        ),
    );
    assert.notEqual(
        comparableContent(note('text', initial), api),
        comparableContent(note('text ', initial), api),
    );
    assert.notEqual(
        comparableContent(note('text', initial), api),
        comparableContent(note('text', { ...initial, tags: ['work'] }), api),
    );
    assert.notEqual(
        comparableContent(note('text', initial), api),
        comparableContent(note('text', { ...initial, created: 'today' }), api),
    );
});

test('a disabled revision property becomes meaningful content rather than owned metadata', () =>
{
    const off = { ...api, revisionMode: 'off' };
    assert.notEqual(
        comparableContent(note('body', initial), off),
        comparableContent(note('body', { ...initial, updated_count: 'manual' }), off),
    );
    assert.equal(
        comparableContent(note('body', initial), off),
        comparableContent(note('body', { ...initial, updated: 'later' }), off),
    );
});

test('many edits/checkpoints and manual saves count once only after leaving; last edit time is used', async () =>
{
    const f = fixture();
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    f.edit(note('changed again', initial));
    await f.tracker.checkpoint();
    await f.tracker.finish('notes/A.md');
    assert.equal(f.writes.length, 0);
    f.leave();
    await f.tracker.finish('notes/A.md');
    await f.tracker.finish('notes/A.md');
    assert.equal(f.writes.length, 1);
    assert.deepEqual(properties(f.files.get('notes/A.md')), {
        ...initial,
        updated: '2026-11-11T12:00:00.000Z',
        updated_count: 8,
    });
});

test('complete undo produces no write and no increment', async () =>
{
    const f = fixture();
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    f.edit(note('before', initial));
    f.leave();
    await f.tracker.finish('notes/A.md');
    assert.equal(f.writes.length, 0);
    assert.equal(f.tracker.paths().length, 0);
});

test('excluded folders are not tracked, while the vault root is', async () =>
{
    const f = fixture({
        excludedFolders: ['archives', 'scripts', 'libraries', 'templates', 'inbound'],
    });
    for (const folder of ['archives', 'scripts', 'libraries', 'templates', 'inbound'])
        f.tracker.change(`${folder}/A.md`, 'old', 'new');
    assert.equal(f.tracker.paths().length, 0);
    f.files.set('Root.md', 'new');
    f.tracker.change('Root.md', 'old', 'new');
    f.leave();
    await f.tracker.finish('Root.md');
    assert.equal(properties(f.files.get('Root.md')).updated_count, 1);
});

test('fresh defaults track notes in all formerly prefilled folders', async () =>
{
    const f = fixture();
    f.leave();
    const paths = ['archives', 'scripts', 'libraries', 'templates', 'inbound'].map(folder =>
        `${folder}/A.md`
    );
    for (const path of paths) {
        f.edit(note('changed'), path);
        await f.tracker.finish(path);
        assert.equal(properties(f.files.get(path)).updated_count, 1);
    }
    assert.deepEqual(f.writes, paths);
    assert.deepEqual(f.errors, []);
    assert.equal(eligibleNote('scripts/non-markdown.js'), false);
});

test('restart recovers a checkpointed session, without scanning or counting unchanged notes', async () =>
{
    const f = fixture();
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    f.leave();
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/A.md');
    assert.equal(properties(f.files.get('notes/A.md')).updated_count, 8);
    assert.equal(recovered.paths().length, 0);
});

test('interruption after frontmatter commit does not increment again on recovery', async () =>
{
    const f = fixture();
    f.edit(note('changed', initial));
    f.leave();
    f.failAfterWrite();
    await f.tracker.finish('notes/A.md');
    assert.equal(f.errors.length, 1);
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/A.md');
    assert.equal(f.writes.length, 1);
    assert.equal(recovered.paths().length, 0);
});

test('a missing creation field is filled from the final updated value and recovery does not double count its insertion', async () =>
{
    const f = fixture();
    const withoutCreated = { ...initial };
    delete withoutCreated.created;
    f.files.set('notes/A.md', note('before', withoutCreated));
    f.edit(note('changed', withoutCreated));
    f.leave();
    f.failAfterWrite();
    await f.tracker.finish('notes/A.md');
    const result = properties(f.files.get('notes/A.md'));
    assert.equal(result.created, result.updated);
    assert.equal(result.updated_count, 8);
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/A.md');
    assert.equal(f.writes.length, 1);
    assert.deepEqual(recovered.paths(), []);
});

test('content comparison and metadata extraction follow custom property names', () =>
{
    const customApi = {
        ...api,
        properties: { created: 'born', updated: 'touched', revision: 'updated_revision' },
    };
    assert.equal(
        comparableContent(note('same', { touched: 'a', updated_revision: 1 }), customApi),
        comparableContent(note('same', { touched: 'b', updated_revision: 2 }), customApi),
    );
    assert.notEqual(
        comparableContent(note('same', { updated_count: 1 }), customApi),
        comparableContent(note('same', { updated_count: 2 }), customApi),
        'legacy names are ordinary fields when not configured',
    );
});

test('unknown external content without mtime is retained; already-stamped sync is not counted again', async () =>
{
    const f = fixture();
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    f.files.set('notes/A.md', note('sync changed body', initial));
    f.leave();
    await f.tracker.finish('notes/A.md');
    assert.equal(f.writes.length, 0);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.tracker.paths(), ['notes/A.md']);
    f.files.set('notes/A.md', note('changed', { ...initial, updated_count: 20 }));
    await f.tracker.finish('notes/A.md');
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.tracker.paths(), []);
});

test('explicit save ends an active session; continuing afterwards starts another and repeated saves are no-ops', async () =>
{
    const f = fixture();
    f.edit(note('first', initial));
    await f.tracker.finish('notes/A.md', { force: true });
    await f.tracker.finish('notes/A.md', { force: true });
    assert.equal(f.writes.length, 1);
    f.edit(note('second', properties(f.files.get('notes/A.md'))));
    await f.tracker.finish('notes/A.md', { force: true });
    assert.equal(properties(f.files.get('notes/A.md')).updated_count, 9);
});

test('file baselines detect property/body changes, use mtime, and avoid counting changed sync metadata', async () =>
{
    const f = fixture();
    let mtime = Date.parse('2026-11-11T14:00:00Z');
    f.options.read = async (path) => ({ text: f.files.get(path), mtime });
    const tracker = createSessionTracker(f.options);
    await tracker.observe('notes/A.md', f.files.get('notes/A.md'), mtime - 1000);
    assert.deepEqual(tracker.paths(), [], 'first observation establishes a baseline only');
    f.files.set('notes/A.md', note('before', { ...initial, tags: ['work'] }));
    await tracker.observe('notes/A.md', f.files.get('notes/A.md'), mtime);
    await tracker.finish('notes/A.md', { force: true });
    assert.equal(properties(f.files.get('notes/A.md')).updated_count, 8);
    assert.equal(properties(f.files.get('notes/A.md')).updated, new Date(mtime).toISOString());
    await tracker.observe('notes/A.md', f.files.get('notes/A.md'), ++mtime);
    assert.deepEqual(tracker.paths(), [], 'own metadata write does not feed back');
    f.files.set('notes/A.md', note('remote content', { ...initial, updated_count: 42 }));
    await tracker.observe('notes/A.md', f.files.get('notes/A.md'), ++mtime);
    assert.deepEqual(tracker.paths(), [], 'counter already changed remotely');
    f.files.set(
        'notes/A.md',
        note('other remote content', {
            ...initial,
            updated_count: 42,
            updated: '2026-11-11T16:00:00Z',
        }),
    );
    await tracker.observe('notes/A.md', f.files.get('notes/A.md'), ++mtime);
    assert.deepEqual(tracker.paths(), [], 'timestamp already changed remotely');
});

test('metadata-only writes and complete property undo do not create a session', async () =>
{
    const f = fixture();
    await f.tracker.observe('notes/A.md', note('before', initial), 1000);
    await f.tracker.observe('notes/A.md', note('before', { ...initial, updated_count: 9 }), 2000);
    assert.deepEqual(f.tracker.paths(), []);
    await f.tracker.observe(
        'notes/A.md',
        note('before', { ...initial, updated_count: 9, tags: ['temporary'] }),
        3000,
    );
    assert.deepEqual(f.tracker.paths(), ['notes/A.md']);
    await f.tracker.observe('notes/A.md', note('before', { ...initial, updated_count: 9 }), 4000);
    assert.deepEqual(f.tracker.paths(), []);
});

test('persisted baseline catches unstamped edits made while Obsidian was closed', async () =>
{
    const f = fixture();
    await f.tracker.observe('notes/A.md', f.files.get('notes/A.md'), 1000);
    await f.tracker.checkpoint();
    f.files.set('notes/A.md', note('changed while closed', initial));
    const recovered = createSessionTracker(f.options);
    const changedAt = Date.parse('2026-11-11T15:00:00Z');
    await recovered.observe('notes/A.md', f.files.get('notes/A.md'), changedAt);
    await recovered.finish('notes/A.md', { force: true });
    assert.equal(properties(f.files.get('notes/A.md')).updated_count, 8);
    assert.equal(properties(f.files.get('notes/A.md')).updated, new Date(changedAt).toISOString());
});

test('timestamp advances only when older than mtime; equal/newer timestamps retain their spelling while the session counts', async () =>
{
    const mtime = Date.parse('2026-11-11T12:00:00Z');
    for (
        const [existing, expected] of [
            ['2026-11-11T11:59:59Z', '2026-11-11T12:00:00.000Z'],
            ['2026-11-11T13:00:00+01:00', '2026-11-11T13:00:00+01:00'],
            ['2026-11-12T12:00:00Z', '2026-11-12T12:00:00Z'],
            ['invalid', '2026-11-11T12:00:00.000Z'],
            [undefined, '2026-11-11T12:00:00.000Z'],
        ]
    ) {
        const f = fixture();
        const fm = { ...initial, updated: existing };
        const before = note('before', fm),
            after = note('changed', fm);
        f.files.set('notes/A.md', after);
        f.options.read = async (path) => ({ text: f.files.get(path), mtime });
        const tracker = createSessionTracker(f.options);
        tracker.change('notes/A.md', before, after);
        await tracker.finish('notes/A.md', { force: true });
        assert.equal(properties(f.files.get('notes/A.md')).updated, expected, String(existing));
        assert.equal(properties(f.files.get('notes/A.md')).updated_count, 8);
        assert.equal(f.errors.length, 0);
    }
});

test('moving a folder into an exclusion removes its baselines and sessions without breaking the next load', async () =>
{
    const f = fixture({ excludedFolders: ['archives'] });
    await f.tracker.observe('notes/A.md', f.files.get('notes/A.md'), 1000);
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    await f.tracker.rename('notes', 'archives/moved');
    assert.deepEqual(f.tracker.paths(), []);
    assert.deepEqual(f.tracker.knownPaths(), []);
    const recovered = createSessionTracker(f.options);
    await recovered.checkpoint();
    assert.equal(f.errors.length, 0);
});

test('new input during forced completion defers the write instead of discarding that input', async () =>
{
    const f = fixture();
    let tracker;
    f.options.read = async (path) =>
    {
        const text = f.files.get(path);
        tracker.change(path, text, note('typed while saving', initial));
        f.files.set(path, note('typed while saving', initial));
        return text;
    };
    tracker = createSessionTracker(f.options);
    tracker.change('notes/A.md', note('before', initial), note('changed', initial));
    f.files.set('notes/A.md', note('changed', initial));
    await tracker.finish('notes/A.md', { force: true });
    assert.equal(f.writes.length, 0);
    assert.deepEqual(tracker.paths(), ['notes/A.md']);
});

test('rename keeps the session, delete drops it', async () =>
{
    const f = fixture();
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    f.files.set('notes/Renamed.md', f.files.get('notes/A.md'));
    f.files.delete('notes/A.md');
    await f.tracker.rename('notes/A.md', 'notes/Renamed.md');
    f.leave();
    await f.tracker.finish('notes/Renamed.md');
    assert.deepEqual(f.writes, ['notes/Renamed.md']);
    f.tracker.change('notes/Deleted.md', 'a', 'b');
    await f.tracker.remove('notes/Deleted.md');
    assert.equal(f.tracker.paths().length, 0);
});

test('changing plugin exclusions skips previously stored sessions and baselines without disabling other tracking', async () =>
{
    const f = fixture();
    await f.tracker.observe('notes/A.md', f.files.get('notes/A.md'), 1000);
    f.edit(note('changed', initial));
    await f.tracker.checkpoint();
    const filtered = createSessionTracker({
        ...f.options,
        isEligible: (path) => path.endsWith('.md') && !path.startsWith('notes/'),
    });
    assert.deepEqual(filtered.paths(), []);
    assert.deepEqual(filtered.knownPaths(), []);
    filtered.change('Root.md', 'before', 'after');
    f.files.set('Root.md', 'after');
    await filtered.finish('Root.md');
    assert.equal(properties(f.files.get('Root.md')).updated_count, 1);
    assert.equal(f.errors.length, 0);
});

test('invalid YAML/count and an unreadable journal never cause destructive replacement', async () =>
{
    const f = fixture();
    f.edit(note('changed', { ...initial, updated_count: 'seven' }));
    // Baseline is valid, but the current invalid counter prevents the write.
    f.leave();
    await f.tracker.finish('notes/A.md');
    assert.equal(f.writes.length, 0);
    f.storageData.set('test', 'broken-json');
    const recovered = createSessionTracker(f.options);
    await recovered.checkpoint();
    assert.equal(f.storageData.get('test'), 'broken-json');
});

function moveFile(f, oldPath = 'notes/A.md', newPath = 'notes/Renamed.md')
{
    f.files.set(newPath, f.files.get(oldPath));
    f.files.delete(oldPath);
}

function gate()
{
    let release, entered;
    const blocked = new Promise((resolve) =>
    {
        release = resolve;
    });
    const started = new Promise((resolve) =>
    {
        entered = resolve;
    });
    return { blocked, started, release: () => release(), entered: () => entered() };
}

test('rename during checkpoint hashing persists the new path and recovers the edit exactly once', async () =>
{
    const f = fixture(), pause = gate();
    const tracker = createSessionTracker({
        ...f.options,
        hash: async (text) =>
        {
            pause.entered();
            await pause.blocked;
            return hash(text);
        },
    });
    const after = note('edited then renamed', initial);
    tracker.change('notes/A.md', f.files.get('notes/A.md'), after);
    f.files.set('notes/A.md', after);
    const checkpoint = tracker.checkpoint();
    await pause.started;
    moveFile(f);
    const renamed = tracker.rename('notes/A.md', 'notes/Renamed.md');
    pause.release();
    await Promise.all([checkpoint, renamed]);
    assert.deepEqual(JSON.parse(f.storageData.get('test')).entries.map((e) => e.path), [
        'notes/Renamed.md',
    ]);
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/Renamed.md', { force: true });
    await recovered.finish('notes/Renamed.md', { force: true });
    assert.equal(properties(f.files.get('notes/Renamed.md')).updated_count, 8);
    assert.equal(bodyOf(f.files.get('notes/Renamed.md')), 'edited then renamed');
    assert.deepEqual(f.writes, ['notes/Renamed.md']);
    assert.deepEqual(f.errors, []);
});

test('rename during observation hashing follows the location without resurrecting the old path', async () =>
{
    const f = fixture(), pause = gate();
    await f.tracker.observe('notes/A.md', f.files.get('notes/A.md'), 1);
    await f.tracker.checkpoint();
    const tracker = createSessionTracker({
        ...f.options,
        hash: async (text) =>
        {
            pause.entered();
            await pause.blocked;
            return hash(text);
        },
    });
    const after = note('external edit', initial);
    f.files.set('notes/A.md', after);
    const observing = tracker.observe('notes/A.md', after, 1794398400000);
    await pause.started;
    moveFile(f);
    const renamed = tracker.rename('notes/A.md', 'notes/Renamed.md');
    pause.release();
    await Promise.all([observing, renamed]);
    assert.deepEqual(tracker.knownPaths(), ['notes/Renamed.md']);
    await tracker.finish('notes/Renamed.md', { force: true });
    assert.equal(properties(f.files.get('notes/Renamed.md')).updated_count, 8);
    assert.deepEqual(f.errors, []);
});

test('rename while completion reads defers the old path and preserves recovery', async () =>
{
    const f = fixture(), pause = gate();
    const tracker = createSessionTracker({
        ...f.options,
        read: async (path) =>
        {
            const text = f.files.get(path);
            pause.entered();
            await pause.blocked;
            return text;
        },
    });
    const after = note('keep body', initial);
    tracker.change('notes/A.md', f.files.get('notes/A.md'), after);
    f.files.set('notes/A.md', after);
    const finishing = tracker.finish('notes/A.md', { force: true });
    await pause.started;
    moveFile(f);
    const renamed = tracker.rename('notes/A.md', 'notes/Renamed.md');
    pause.release();
    await Promise.all([finishing, renamed]);
    assert.deepEqual(f.writes, []);
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/Renamed.md', { force: true });
    assert.equal(properties(f.files.get('notes/Renamed.md')).updated_count, 8);
});

test('pure rename is opt-in; enabled rename survives restart without a baseline or duplicate increment', async () =>
{
    for (const countRevision of [false, true]) {
        const f = fixture();
        moveFile(f);
        await f.tracker.rename('notes/A.md', 'notes/Renamed.md', { countRevision });
        const recovered = createSessionTracker(f.options);
        await recovered.finish('notes/Renamed.md', { force: true });
        const again = createSessionTracker(f.options);
        await again.finish('notes/Renamed.md', { force: true });
        assert.equal(
            properties(f.files.get('notes/Renamed.md')).updated_count,
            countRevision ? 8 : 7,
        );
        assert.equal(f.writes.length, countRevision ? 1 : 0);
        assert.equal(bodyOf(f.files.get('notes/Renamed.md')), 'before');
        assert.deepEqual(f.errors, []);
    }
});

test('content edit and counted rename share one session, including interrupted-commit recovery', async () =>
{
    const f = fixture();
    f.edit(note('edited and renamed', initial));
    moveFile(f);
    await f.tracker.rename('notes/A.md', 'notes/Renamed.md', { countRevision: true });
    f.failAfterWrite();
    await f.tracker.finish('notes/Renamed.md', { force: true });
    assert.equal(f.errors.length, 1);
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/Renamed.md', { force: true });
    assert.equal(properties(f.files.get('notes/Renamed.md')).updated_count, 8);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(recovered.paths(), []);
});

test('counted rename retains its marker across unchanged file observations and repeated renames', async () =>
{
    const f = fixture();
    await f.tracker.observe('notes/A.md', f.files.get('notes/A.md'), 1);
    moveFile(f);
    await f.tracker.rename('notes/A.md', 'notes/Renamed.md', { countRevision: true });
    await f.tracker.observe('notes/Renamed.md', f.files.get('notes/Renamed.md'), 1);
    moveFile(f, 'notes/Renamed.md', 'notes/Again.md');
    await f.tracker.rename('notes/Renamed.md', 'notes/Again.md', { countRevision: true });
    await f.tracker.finish('notes/Again.md', { force: true });
    assert.equal(properties(f.files.get('notes/Again.md')).updated_count, 8);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.errors, []);
});

test('rename during a completed host write keeps the committed baseline at the new location', async () =>
{
    const f = fixture(), pause = gate();
    const tracker = createSessionTracker({
        ...f.options,
        write: async (...args) =>
        {
            await f.options.write(...args);
            pause.entered();
            await pause.blocked;
        },
    });
    const after = note('body survives write race', initial);
    tracker.change('notes/A.md', f.files.get('notes/A.md'), after);
    f.files.set('notes/A.md', after);
    const finishing = tracker.finish('notes/A.md', { force: true });
    await pause.started;
    moveFile(f);
    const renamed = tracker.rename('notes/A.md', 'notes/Renamed.md');
    pause.release();
    await Promise.all([finishing, renamed]);
    assert.deepEqual(tracker.knownPaths(), ['notes/Renamed.md']);
    assert.deepEqual(tracker.paths(), []);
    const recovered = createSessionTracker(f.options);
    await recovered.observe('notes/Renamed.md', f.files.get('notes/Renamed.md'), 1);
    await recovered.finish('notes/Renamed.md', { force: true });
    assert.equal(f.writes.length, 1);
    assert.equal(properties(f.files.get('notes/Renamed.md')).updated_count, 8);
});

test('a new rename after an interrupted committed rename is counted once separately', async () =>
{
    const f = fixture();
    moveFile(f);
    await f.tracker.rename('notes/A.md', 'notes/Renamed.md', { countRevision: true });
    f.failAfterWrite();
    await f.tracker.finish('notes/Renamed.md', { force: true });
    moveFile(f, 'notes/Renamed.md', 'notes/Again.md');
    await f.tracker.rename('notes/Renamed.md', 'notes/Again.md', { countRevision: true });
    const recovered = createSessionTracker({
        ...f.options,
        write: async (path, intent, expected) =>
        {
            try {
                await f.options.write(path, intent, expected);
            } catch (error) {
                if (!error.message.includes('simulated interruption')) throw error;
            }
        },
    });
    await recovered.finish('notes/Again.md', { force: true });
    const again = createSessionTracker(f.options);
    await again.finish('notes/Again.md', { force: true });
    assert.equal(properties(f.files.get('notes/Again.md')).updated_count, 9);
    assert.equal(f.writes.length, 2);
    assert.deepEqual(again.paths(), []);
});

test('counted renames respect exclusions and disabled revision mode', async () =>
{
    const f = fixture({ excludedFolders: ['archives'] });
    moveFile(f, 'notes/A.md', 'archives/A.md');
    await f.tracker.rename('notes/A.md', 'archives/A.md', { countRevision: true });
    assert.deepEqual(f.tracker.paths(), []);
    const off = createSessionTracker({ ...f.options, api: { ...api, revisionMode: 'off' } });
    moveFile(f, 'archives/A.md', 'notes/A.md');
    moveFile(f);
    await off.rename('notes/A.md', 'notes/Renamed.md', { countRevision: true });
    await off.finish('notes/Renamed.md', { force: true });
    assert.equal(f.writes.length, 0);
});

test('unrendered Templater headers are deferred before YAML parsing, while body examples remain ordinary content', async () =>
{
    const f = fixture();
    const template =
        "---\n<% 'created: ' %><% tp.date.now('YYYY-MM-DD[T]HH:mm:ssZ') %>\n---\nTemplate body";
    for (const text of [template, note('body', { created: '<% tp.date.now() %>' })]) {
        assert.throws(() => comparableContent(text, api), { code: 'SESSION_MARKS_DEFERRED' });
        assert.throws(() => metadataOf(text, api), { code: 'SESSION_MARKS_DEFERRED' });
        f.files.set('templates/Example.md', text);
        await f.tracker.observe('templates/Example.md', text, 1);
        f.tracker.change('templates/Example.md', text, text + ' edit');
        await f.tracker.checkpoint();
        assert.equal(f.files.get('templates/Example.md'), text);
    }
    assert.deepEqual(f.tracker.paths(), []);
    assert.equal(f.writes.length, 0);
    assert.ok(f.errors.every((error) => error.code === 'SESSION_MARKS_DEFERRED'));
    const before = note('Example: <% tp.date.now() %>', initial);
    const after = note('Updated example: <% tp.date.now() %>', initial);
    f.files.set('notes/A.md', before);
    f.edit(after);
    await f.tracker.finish('notes/A.md', { force: true });
    assert.equal(properties(f.files.get('notes/A.md')).updated_count, 8);
});

test('YAML errors do not leak parser excerpts or block checkpoints and recovery for other notes', async () =>
{
    const f = fixture();
    const malformed = '---\nprivate-secret: [unterminated\n---\nkeep this body';
    f.edit(malformed);
    const goodBefore = note('before', initial), goodAfter = note('good changed', initial);
    f.files.set('notes/Good.md', goodBefore);
    f.edit(goodAfter, 'notes/Good.md');
    await f.tracker.checkpoint();
    const entries = JSON.parse(f.storageData.get('test')).entries;
    assert.deepEqual(entries.map((entry) => entry.path), ['notes/Good.md']);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0].message, /notes\/A.md: Invalid YAML/);
    assert.ok(!f.errors[0].stack.includes('private-secret'));
    const recovered = createSessionTracker(f.options);
    await recovered.finish('notes/Good.md', { force: true });
    assert.equal(properties(f.files.get('notes/Good.md')).updated_count, 8);
    assert.equal(f.files.get('notes/A.md'), malformed);
    // The live session can still finish after the user repairs its frontmatter.
    f.edit(note('repaired body', initial));
    await f.tracker.finish('notes/A.md', { force: true });
    assert.equal(properties(f.files.get('notes/A.md')).updated_count, 8);
});
