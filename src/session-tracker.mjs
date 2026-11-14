// Device-local session state, content comparisons and idempotent recovery.
// File access and application behavior are supplied by the runtime adapter.
import { eligibleNote } from './note-paths.mjs';
import {
    comparableContent,
    hasPendingTemplateFrontmatter,
    metadataOf,
    sha256,
} from './note-content.mjs';
import { propertyNames, revisionEnabled } from './properties.mjs';

export function createSessionTracker({
    api,
    storage,
    storageKey,
    read,
    write,
    exists,
    isActive = () => false,
    now = () => new Date(),
    hash = sha256,
    report = console.error,
    isEligible = eligibleNote,
})
{
    const sessions = new Map();
    const baselines = new Map();
    // References survive a rename even while hashing or reading is suspended.
    const locations = new Map();
    const locationOf = (path) =>
    {
        if (!locations.has(path)) locations.set(path, { path });
        return locations.get(path);
    };
    const current = (location) => locations.get(location.path) === location;
    let queue = Promise.resolve();
    let available = true;
    const save = () =>
    {
        const entries = [...sessions].flatMap(([path, session]) =>
        {
            if (!session.record && !session.renamedAt) return [];
            return [{
                ...(session.record ?? { renameOnly: true }),
                path,
                renamedAt: session.renamedAt,
                renameVersion: session.renameVersion,
            }];
        });
        storage.setItem(storageKey, JSON.stringify({ version: 1, entries }));
    };
    let baselineDirty = false;
    const saveBaselines = () =>
    {
        if (!baselineDirty) return;
        storage.setItem(
            storageKey + ':baselines',
            JSON.stringify({ version: 2, entries: [...baselines] }),
        );
        baselineDirty = false;
    };
    const remember = (path, contentHash, metadata, mtime) =>
    {
        baselines.set(path, {
            hash: contentHash,
            count: metadata.count,
            updated: metadata.updated,
            mtime,
        });
        baselineDirty = true;
    };
    try {
        const raw = storage.getItem(storageKey);
        if (raw) {
            const journal = JSON.parse(raw);
            if (journal.version !== 1 || !Array.isArray(journal.entries))
                throw new Error('Unknown journal format');
            for (const record of journal.entries) {
                if (
                    typeof record.path !== 'string' ||
                    (!record.renameOnly && (
                        !/^[a-f0-9]{64}$/.test(record.baselineHash) ||
                        !/^[a-f0-9]{64}$/.test(record.latestHash) ||
                        !Number.isFinite(Date.parse(record.editedAt)) ||
                        !record.initial ||
                        !Number.isSafeInteger(record.initial.count) ||
                        record.initial.count < 0
                    )) ||
                    (record.renamedAt !== undefined &&
                        (!Number.isFinite(Date.parse(record.renamedAt)) ||
                            !Number.isSafeInteger(record.renameVersion) ||
                            record.renameVersion < 1)) ||
                    (record.renameOnly && !record.renamedAt)
                ) {
                    throw new Error('Invalid session journal entry');
                }
                if (!isEligible(record.path)) continue;
                record.comparisonVersion ??= 1;
                sessions.set(record.path, {
                    record: record.renameOnly ? undefined : record,
                    renamedAt: record.renamedAt,
                    renameVersion: record.renameVersion,
                });
            }
        }
        const rawBaselines = storage.getItem(storageKey + ':baselines');
        if (rawBaselines) {
            const saved = JSON.parse(rawBaselines);
            if (saved.version !== 2 || !Array.isArray(saved.entries))
                throw new Error('Unknown baseline format');
            for (const [path, entry] of saved.entries) {
                if (
                    typeof path !== 'string' ||
                    !/^[a-f0-9]{64}$/.test(entry.hash) ||
                    !Number.isSafeInteger(entry.count) ||
                    entry.count < 0
                )
                    throw new Error('Invalid baseline entry');
                if (isEligible(path)) baselines.set(path, entry);
            }
        }
    } catch (error) {
        available = false; // Never replace an unreadable journal with an empty one.
        report(error);
    }
    const eligible = isEligible;
    const reportNoteError = (error, path) =>
    {
        if (error?.code === 'REVISION_MARKS_INVALID_FRONTMATTER') {
            report(Object.assign(new Error(`${path}: ${error.message}`), { code: error.code }));
        } else report(error);
    };
    const enqueue = (operation, location) =>
    {
        const result = queue.then(operation);
        queue = result.catch((error) => reportNoteError(error, location?.path));
        return queue;
    };
    const snapshot = async (session, path) =>
    {
        if (session.before === undefined || session.savedRevision === session.revision) return;
        const revision = session.revision;
        const editedAt = session.editedAt;
        const comparisonVersion = session.record?.comparisonVersion ?? 2;
        const [baselineHash, latestHash] = await Promise.all([
            session.record ?
                session.record.baselineHash :
                hash(comparableContent(session.before, api, comparisonVersion)),
            hash(comparableContent(session.after, api, comparisonVersion)),
        ]);
        const initial = session.record?.initial ?? metadataOf(session.before, api);
        session.record = {
            ...session.record,
            path,
            baselineHash,
            latestHash,
            initial,
            editedAt,
            comparisonVersion,
        };
        session.savedRevision = revision;
    };
    const change = (path, before, after) =>
    {
        if (!available || !eligible(path)) return;
        if (hasPendingTemplateFrontmatter(before, api) || hasPendingTemplateFrontmatter(after, api))
            return;
        const session = sessions.get(path) ?? {};
        session.before ??= before;
        session.after = after;
        session.editedAt = now().toISOString();
        session.revision = (session.revision ?? 0) + 1;
        sessions.set(path, session);
    };
    const checkpoint = () =>
        enqueue(async () =>
        {
            if (!available) return;
            for (const [path, session] of sessions) {
                try {
                    await snapshot(session, path);
                } catch (error) {
                    reportNoteError(error, path);
                }
            }
            save();
            saveBaselines();
        });
    const observe = (path, text, mtime) =>
    {
        const location = locationOf(path);
        return enqueue(async () =>
        {
            if (!available || !eligible(path)) return;
            const contentHash = await hash(comparableContent(text, api));
            if (!current(location) || !eligible(location.path)) return;
            path = location.path;
            const metadata = metadataOf(text, api);
            const previous = baselines.get(path);
            const session = sessions.get(path);
            if (!previous) {
                if (session) return; // Its first user transaction supplies the missing pre-image.
                remember(path, contentHash, metadata, mtime);
                return;
            }
            if (
                contentHash === previous.hash ||
                metadata.count !== previous.count ||
                metadata.updated !== previous.updated
            ) {
                // Metadata-only changes and already-stamped sync changes do not create another edit.
                remember(path, contentHash, metadata, mtime);
                if (session?.record?.source === 'file' && !session.renamedAt) {
                    sessions.delete(path);
                    save();
                }
                return;
            }
            if (session?.before !== undefined || session?.renamedAt) return; // Preserve the editor's exact before/after documents.
            const editedAt = new Date(mtime).toISOString();
            sessions.set(path, {
                record: {
                    path,
                    baselineHash: previous.hash,
                    latestHash: contentHash,
                    initial: { count: previous.count, updated: previous.updated },
                    editedAt,
                    comparisonVersion: 2,
                    source: 'file',
                },
            });
            save();
        }, location);
    };
    const finish = (path, { force = false, shutdown = false } = {}) =>
    {
        const location = locationOf(path);
        return enqueue(async () =>
        {
            if (!current(location)) return;
            path = location.path;
            if (!available || (!force && isActive(path))) return;
            const session = sessions.get(path);
            if (!session) return;
            await snapshot(session, path);
            const revision = session.revision;
            const canWrite = () =>
                current(location) && location.path === path &&
                sessions.get(path) === session &&
                session.revision === revision &&
                (force || !isActive(path));
            if (!canWrite()) return;
            let record = session.record;
            if ((!record && !session.renamedAt) || !eligible(path) || !exists(path)) {
                sessions.delete(path);
                save();
                return;
            }
            const loaded = await read(path, { saveEditors: record?.source !== 'file', shutdown });
            const text = typeof loaded === 'string' ? loaded : loaded.text;
            const mtime = typeof loaded === 'string' ? undefined : loaded.mtime;
            if (!canWrite()) {
                save();
                return;
            }
            if (!record) {
                const contentHash = await hash(comparableContent(text, api));
                if (!canWrite()) return;
                const previous = baselines.get(path);
                record = session.record = {
                    path,
                    baselineHash: previous?.hash ?? contentHash,
                    latestHash: contentHash,
                    initial: previous ?
                        { count: previous.count, updated: previous.updated } :
                        metadataOf(text, api),
                    editedAt: session.renamedAt,
                    comparisonVersion: 2,
                };
            }
            const contentHash = await hash(comparableContent(text, api, record.comparisonVersion));
            const canonicalHash = record.comparisonVersion === 2 ?
                contentHash :
                await hash(comparableContent(text, api));
            if (!canWrite()) return;
            const metadata = metadataOf(text, api);
            if (
                record.intent &&
                metadata.count === record.intent.count &&
                metadata.updated === record.intent.updated &&
                (!record.intent.addCreated ||
                    (metadata.hasCreated && metadata.created === record.intent.created))
            ) {
                if (
                    canonicalHash === record.intent.postCommitHash ||
                    (!record.intent.postCommitHash && contentHash === record.latestHash)
                ) {
                    if (
                        session.renameVersion !== record.intent.renameVersion &&
                        session.renamedAt
                    ) {
                        record.baselineHash = canonicalHash;
                        record.initial = metadata;
                        delete record.intent;
                    } else {
                        remember(path, canonicalHash, metadata, mtime);
                        sessions.delete(path);
                        save();
                        saveBaselines();
                        return; // Commit succeeded before interruption.
                    }
                }
                // The old commit succeeded, followed by another unstamped content change.
                if (record.intent) {
                    record.baselineHash = record.intent.postCommitHash ?? record.latestHash;
                    record.initial = metadata;
                    if (session.renameVersion === record.intent.renameVersion)
                        delete session.renamedAt;
                    delete record.intent;
                }
            }
            if (contentHash === record.baselineHash && !session.renamedAt) {
                remember(path, canonicalHash, metadata, mtime);
                sessions.delete(path);
                save();
                saveBaselines();
                return; // Includes a complete undo.
            }
            if (
                metadata.count !== record.initial.count ||
                metadata.updated !== record.initial.updated
            ) {
                remember(path, canonicalHash, metadata, mtime);
                sessions.delete(path);
                save();
                saveBaselines();
                return; // Another writer already accounted for the change.
            }
            if (contentHash !== record.latestHash && !Number.isFinite(mtime)) {
                save();
                throw new Error(
                    `Edit sessions: ${path} changed externally without a known mtime; pending session retained.`,
                );
            }
            record.latestHash = contentHash;
            const contentTime = Number.isFinite(mtime) && mtime > 0 ?
                mtime :
                Date.parse(record.editedAt);
            const editedAt = new Date(Math.max(contentTime, Date.parse(session.renamedAt) || 0))
                .toISOString();
            const proposed = record.intent?.updated ?? api.formatDate(editedAt);
            const existingTime = typeof metadata.updated === 'string' ?
                Date.parse(metadata.updated) :
                NaN;
            const proposedTime = Date.parse(proposed);
            const updateTimestamp = !Number.isFinite(existingTime) || existingTime < proposedTime;
            // Compare instants, not timezone spellings; never move a valid stamp backwards.
            // Compare the formatted value so sub-second mtime differences don't cause rewrites.
            record.intent = {
                count: revisionEnabled(api) ? (record.intent?.count ?? metadata.count + 1) : 0,
                updated: updateTimestamp ? proposed : metadata.updated,
                updateTimestamp,
                renameVersion: session.renameVersion,
            };
            record.intent.addCreated = !metadata.hasCreated;
            record.intent.created = metadata.hasCreated ? metadata.created : record.intent.updated;
            record.intent.postCommitHash = record.intent.addCreated ?
                await hash(
                    comparableContent(text, api, 2, {
                        [propertyNames(api).created]: record.intent.created,
                    }),
                ) :
                canonicalHash;
            if (!Number.isSafeInteger(record.intent.count))
                throw new Error('updated_count overflow');
            save(); // Write-ahead record: retry must never increment twice.
            if (!canWrite()) return;
            await write(path, record.intent, metadata, contentHash, {
                canWrite,
                force,
                shutdown,
                comparisonVersion: record.comparisonVersion,
            });
            // A host write can finish after another rename. Keep its canonical location.
            const committedPath = location.path;
            if (!current(location)) return;
            remember(committedPath, record.intent.postCommitHash, record.intent, mtime);
            if (session.renameVersion === record.intent.renameVersion) delete session.renamedAt;
            if (session.revision === revision) sessions.delete(committedPath);
            else {
                // Input after the write belongs to a fresh session, not to the just-committed one.
                session.record = {
                    path: committedPath,
                    baselineHash: record.intent.postCommitHash,
                    latestHash: record.intent.postCommitHash,
                    initial: { count: record.intent.count, updated: record.intent.updated },
                    editedAt: session.editedAt,
                    comparisonVersion: 2,
                };
                session.savedRevision = undefined;
            }
            save();
            saveBaselines();
        }, location);
    };
    const rename = (oldPath, newPath, { countRevision = false } = {}) =>
    {
        if (oldPath === newPath) return queue;
        for (
            const path of new Set([...locations.keys(), ...baselines.keys(), ...sessions.keys()])
        ) {
            if (path !== oldPath && !path.startsWith(oldPath + '/')) continue;
            const target = newPath + path.slice(oldPath.length);
            const location = locationOf(path);
            locations.delete(path);
            if (eligible(target)) {
                location.path = target;
                locations.set(target, location);
                if (baselines.has(path)) baselines.set(target, baselines.get(path));
                if (sessions.has(path)) {
                    const session = sessions.get(path);
                    sessions.set(target, session);
                    if (session.record) session.record.path = target;
                }
            }
            baselines.delete(path);
            sessions.delete(path);
            baselineDirty = true;
        }
        if (
            available && countRevision && revisionEnabled(api) && eligible(oldPath) &&
            eligible(newPath)
        ) {
            const session = sessions.get(newPath) ?? {};
            session.renamedAt = now().toISOString();
            session.renameVersion = (session.renameVersion ?? 0) + 1;
            session.revision = (session.revision ?? 0) + 1;
            sessions.set(newPath, session);
        }
        return enqueue(async () =>
        {
            if (available) {
                save();
                saveBaselines();
            }
        });
    };
    const remove = (path) =>
    {
        for (
            const candidate of new Set([
                ...locations.keys(),
                ...baselines.keys(),
                ...sessions.keys(),
            ])
        ) {
            if (candidate === path || candidate.startsWith(path + '/')) {
                locations.delete(candidate);
                baselines.delete(candidate);
                sessions.delete(candidate);
                baselineDirty = true;
            }
        }
        return enqueue(async () =>
        {
            if (available) {
                save();
                saveBaselines();
            }
        });
    };
    return {
        change,
        observe,
        checkpoint,
        finish,
        rename,
        remove,
        baseline: (path) => baselines.get(path),
        knownPaths: () => [...baselines.keys()],
        hasEditorChanges: (path) => sessions.get(path)?.before !== undefined,
        paths: () => [...sessions.keys()],
        idle: () => queue,
    };
}
