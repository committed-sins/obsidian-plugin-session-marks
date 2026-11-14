import { registerSaveCommand } from './save-command.mjs';
import { DEFAULT_EXCLUDED_FOLDERS, eligibleNote } from './note-paths.mjs';
import { comparableContent } from './note-content.mjs';
import { createNoteAccess } from './note-access.mjs';
import { createSessionTracker } from './session-tracker.mjs';
import { propertyNames } from './properties.mjs';
import { prepareSessionStorage } from './storage.mjs';

/**
 * @typedef {Object} TrackingRuntime
 * @property {() => Promise<void>} stop Detach listeners synchronously and checkpoint pending work.
 * @property {(path?: string) => Promise<void>} complete Complete saved, changed sessions.
 * @property {() => string[]} pendingPaths Paths still waiting for a safe completion.
 */

/** Connect the session tracker to Obsidian. Never force-save editor views.
 * @returns {TrackingRuntime}
 */
export function startEditSessions(app, api)
{
    const owner = api.owner;
    if (!owner?.registerEditorExtension)
        throw new Error('Revision Marks requires its plugin lifecycle owner');
    const eligible = (path) => eligibleNote(path, api.excludedFolders ?? DEFAULT_EXCLUDED_FOLDERS);
    const slotKey = Symbol.for('revision-marks.editorListener');
    // Keep one extension per plugin instance, including settings restarts.
    if (!owner[slotKey]) {
        const slot = (owner[slotKey] = { listener: null });
        owner.registerEditorExtension(
            api.EditorView.updateListener.of((update) => slot.listener?.(update)),
        );
    }
    const slot = owner[slotKey];
    let stopped = false,
        closing = false,
        suspended = globalThis.document?.visibilityState === 'hidden';
    let shutdownCompletion = false,
        quitPromise;
    let checkpointTimer, leavingTimer, initializationTimer;
    const completionRequests = new Set();
    const deferred = (message) =>
        Object.assign(new Error(message), { code: 'SESSION_MARKS_DEFERRED' });
    const assertRunning = (shutdown = false) =>
    {
        if (stopped || ((closing || suspended) && !(shutdown && shutdownCompletion))) {
            throw deferred('Session completion deferred until the app is active');
        }
    };
    let diskQueue = Promise.resolve();
    let flushQueue = Promise.resolve();
    const refs = [];
    const reported = new Set();
    const report = (error) =>
    {
        if (error?.code === 'SESSION_MARKS_DEFERRED') return;
        console.error('Revision Marks', error);
        const message = `Edit sessions: ${error.message ?? error}`;
        if (!reported.has(message)) {
            reported.add(message);
            new api.Notice(message, 10000);
        }
    };
    const fileAt = (path) => app.vault.getAbstractFileByPath(path);
    const writing = new Set();
    const isActive = (path) => app.workspace.getActiveFile()?.path === path;
    const recoveringPaths = new Set();
    const isSessionActive = (path) => isActive(path) && !recoveringPaths.has(path);
    const viewsFor = (path) =>
    {
        const views = [];
        app.workspace.iterateAllLeaves((leaf) =>
        {
            if (leaf.view.file?.path === path && leaf.view.editor) views.push(leaf.view);
        });
        return views;
    };
    const names = propertyNames(api);
    const storageKey = prepareSessionStorage(
        globalThis.localStorage,
        app.vault.adapter.getBasePath?.() ?? app.vault.getName(),
        names,
        api.revisionMode,
    );
    const noteAccess = createNoteAccess({
        app,
        api,
        fileAt,
        viewsFor,
        writing,
        assertRunning,
        deferred,
    });
    const { waitForNativeSave, checkViews } = noteAccess;
    const tracker = createSessionTracker({
        api,
        storage: globalThis.localStorage,
        storageKey,
        isActive: isSessionActive,
        report,
        isEligible: eligible,
        exists: (path) => Boolean(fileAt(path)),
        read: noteAccess.read,
        write: noteAccess.write,
    });
    const scheduleCheckpoint = () =>
    {
        clearTimeout(checkpointTimer);
        checkpointTimer = setTimeout(() =>
        {
            void tracker.checkpoint();
        }, 300);
    };
    slot.listener = (update) =>
    {
        if (
            stopped ||
            !update.docChanged ||
            !update.transactions.some((tr) =>
                ['input', 'delete', 'move', 'undo', 'redo'].some((event) => tr.isUserEvent(event))
            )
        )
            return;
        const info = update.state.field(api.editorInfoField, false);
        const file = info?.file;
        if (!file || !eligible(file.path) || !isActive(file.path)) return;
        // Embedded/table-cell editors must not be mistaken for a whole note.
        if (info.editor?.getValue() !== update.state.doc.toString()) return;
        if (
            writing.has(file.path) &&
            comparableContent(update.startState.doc.toString(), api) ===
                comparableContent(update.state.doc.toString(), api)
        )
            return;
        recoveringPaths.delete(file.path); // Never recover into a note the user has started editing.
        tracker.change(file.path, update.startState.doc.toString(), update.state.doc.toString());
        scheduleCheckpoint();
    };
    const scheduleInactiveCompletion = () =>
    {
        clearTimeout(leavingTimer);
        leavingTimer = setTimeout(() =>
        {
            if (stopped || closing || suspended) return;
            for (const path of tracker.paths()) if (!isActive(path)) void tracker.finish(path);
        }, 150);
    };
    const observeFile = (file) =>
    {
        if (stopped || !file || !eligible(file.path) || writing.has(file.path)) return diskQueue;
        const path = file.path;
        diskQueue = diskQueue
            .then(async () =>
            {
                if (stopped || !fileAt(path)) return;
                const text = await app.vault.read(fileAt(path));
                if (!fileAt(path)) return;
                const mtime = fileAt(path)?.stat?.mtime;
                await tracker.observe(path, text, Number.isFinite(mtime) ? mtime : Date.now());
                scheduleCheckpoint();
                if (!closing && !suspended && (!isActive(path) || completionRequests.has(path))) {
                    await tracker.finish(path, { force: completionRequests.has(path) });
                    if (!tracker.paths().includes(path)) completionRequests.delete(path);
                }
            })
            .catch(report);
        return diskQueue;
    };
    async function completeSavedSessions(onlyPath)
    {
        if (stopped || closing || suspended) {
            await tracker.checkpoint();
            return;
        }
        // Native Obsidian owns body persistence. Await an existing save only;
        // unsaved sessions stay journaled and retry on a later native modify event.
        const paths = new Set();
        app.workspace.iterateAllLeaves(({ view }) =>
        {
            const eligibleView = view.editor && eligible(view.file?.path ?? '');
            const requestedPath = !onlyPath || view.file?.path === onlyPath;
            if (eligibleView && requestedPath) paths.add(view.file.path);
        });
        for (const path of paths) {
            completionRequests.add(path);
            await waitForNativeSave(path);
        }
        if (onlyPath) completionRequests.add(onlyPath);

        // Include final disk changes even if their modify event has not run yet.
        for (const path of paths) await observeFile(fileAt(path));
        if (onlyPath && !paths.has(onlyPath)) await observeFile(fileAt(onlyPath));
        await diskQueue;
        await tracker.checkpoint();

        for (const path of tracker.paths()) {
            if (onlyPath && path !== onlyPath) continue;
            completionRequests.add(path);
            await tracker.finish(path, { force: true });
            if (!tracker.paths().includes(path)) completionRequests.delete(path);
        }
        await tracker.checkpoint();
    }

    function complete(onlyPath)
    {
        flushQueue = flushQueue.then(() => completeSavedSessions(onlyPath)).catch(report);
        return flushQueue;
    }
    refs.push([app.vault, app.vault.on('modify', observeFile)]);
    refs.push([app.vault, app.vault.on('create', observeFile)]);
    refs.push([app.workspace, app.workspace.on('active-leaf-change', scheduleInactiveCompletion)]);
    refs.push([app.workspace, app.workspace.on('file-open', scheduleInactiveCompletion)]);
    refs.push([app.workspace, app.workspace.on('layout-change', scheduleInactiveCompletion)]);
    refs.push([
        app.vault,
        app.vault.on('rename', (file, oldPath) =>
        {
            for (const paths of [completionRequests, recoveringPaths]) {
                for (const path of [...paths]) {
                    if (path === oldPath || path.startsWith(oldPath + '/')) {
                        paths.delete(path);
                        paths.add(file.path + path.slice(oldPath.length));
                    }
                }
            }
            void tracker.rename(oldPath, file.path, {
                countRevision: api.countRenames === true && file.extension === 'md',
            });
            if (file.extension === 'md') void observeFile(file);
            scheduleInactiveCompletion();
        }),
    ]);
    refs.push([
        app.vault,
        app.vault.on('delete', (file) =>
        {
            void tracker.remove(file.path);
        }),
    ]);
    async function completeOnDesktopQuit(nativeWork)
    {
        // Attach the rejection handler immediately, even while journaling.
        const settledNativeWork = Promise.resolve(nativeWork).then(
            () => null,
            (error) => ({ error }),
        );
        await tracker.checkpoint();
        try {
            const failure = await settledNativeWork;
            if (failure) throw failure.error;
            await flushQueue;
            await diskQueue;
            await tracker.idle();
            if (stopped) return;
            shutdownCompletion = true;
            const paths = new Set(tracker.paths());
            app.workspace.iterateAllLeaves(({ view }) =>
            {
                if (view.editor && eligible(view.file?.path ?? '')) paths.add(view.file.path);
            });
            for (const path of paths) {
                try {
                    await waitForNativeSave(path, true);
                    const file = fileAt(path);
                    if (!file) continue;
                    const text = await app.vault.read(file);
                    checkViews(path, text, undefined, true);
                    await tracker.observe(path, text, file.stat?.mtime);
                } catch (error) {
                    report(error);
                }
            }
            for (const path of tracker.paths())
                await tracker.finish(path, { force: true, shutdown: true });
        } catch (error) {
            report(error);
        } finally {
            shutdownCompletion = false;
            await tracker.checkpoint();
        }
    }

    function onQuit(tasks)
    {
        closing = true; // Synchronous: invalidate already queued completions too.
        // Obsidian 1.15 registers native saves before plugin quit listeners.
        // Tasks.promise() snapshots currently registered tasks. Capture it BEFORE
        // adding ours; awaiting the aggregate afterwards would await ourselves.
        if (!quitPromise) {
            if (
                api.Platform?.isMobile ||
                typeof tasks?.promise !== 'function' ||
                typeof tasks?.add !== 'function'
            ) {
                quitPromise = tracker.checkpoint();
            } else {
                const nativeWork = tasks.promise();
                quitPromise = completeOnDesktopQuit(nativeWork);
            }
        }
        if (tasks?.add) tasks.add(() => quitPromise);
        else return quitPromise;
    }
    refs.push([app.workspace, app.workspace.on('quit', onQuit)]);
    const onMobileBlur = () =>
    {
        suspended = true;
        void tracker.checkpoint();
    };
    const onResume = () =>
    {
        if (stopped || closing || globalThis.document?.visibilityState === 'hidden') return;
        suspended = false;
        void complete();
    };
    const onHide = () =>
    {
        if (globalThis.document?.visibilityState === 'hidden') onMobileBlur();
        else onResume();
    };
    globalThis.document?.addEventListener('visibilitychange', onHide);
    globalThis.window?.addEventListener('pagehide', onMobileBlur);
    globalThis.window?.addEventListener('pageshow', onResume);
    if (api.Platform?.isMobile) globalThis.window?.addEventListener('focus', onResume);
    if (api.Platform?.isMobile) globalThis.window?.addEventListener('blur', onMobileBlur);
    const restoreSaveCommand = registerSaveCommand({
        app,
        complete,
        isStopped: () => stopped,
        report,
    });
    const interval = setInterval(() =>
    {
        void tracker.checkpoint();
    }, 5000);
    // Recover the previous app run before treating new input as a new session.
    // Typing into the note cancels its active-file recovery permission immediately.
    for (const path of tracker.paths()) {
        recoveringPaths.add(path);
        void tracker.finish(path).finally(() => recoveringPaths.delete(path));
    }
    // First run establishes fingerprints without backdating the vault. Later starts
    // read only changed file stats. Work is paced so mobile startup remains usable.
    const initialize = async () =>
    {
        let batch = 0;
        const files = app.vault.getMarkdownFiles?.() ?? [];
        const paths = new Set(files.map((file) => file.path));
        for (const path of tracker.knownPaths()) if (!paths.has(path)) await tracker.remove(path);
        for (const path of paths) {
            if (stopped) return;
            if (!eligible(path)) continue;
            const file = fileAt(path);
            const baseline = tracker.baseline(path);
            if (!baseline || baseline.mtime !== file?.stat?.mtime) await observeFile(file);
            if (++batch % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 20));
            if (batch % 128 === 0) await tracker.checkpoint();
        }
        await tracker.checkpoint();
    };
    initializationTimer = setTimeout(() =>
    {
        void initialize().catch(report);
    }, 1000);
    scheduleInactiveCompletion();
    const stop = () =>
    {
        stopped = true;
        slot.listener = null;
        clearTimeout(checkpointTimer);
        clearTimeout(leavingTimer);
        clearTimeout(initializationTimer);
        clearInterval(interval);
        for (const [emitter, ref] of refs) emitter.offref(ref);
        globalThis.document?.removeEventListener('visibilitychange', onHide);
        globalThis.window?.removeEventListener('pagehide', onMobileBlur);
        globalThis.window?.removeEventListener('pageshow', onResume);
        globalThis.window?.removeEventListener('focus', onResume);
        globalThis.window?.removeEventListener('blur', onMobileBlur);
        restoreSaveCommand();
        // Unload may not await our return value. Never touch note files here.
        return tracker.checkpoint();
    };
    return { stop, complete, pendingPaths: () => tracker.paths() };
}
