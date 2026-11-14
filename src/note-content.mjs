import { propertyNames, revisionEnabled } from './properties.mjs';

/** A template header is source code, not note metadata ready for stamping. */
export function hasPendingTemplateFrontmatter(text, api)
{
    const info = api.getFrontMatterInfo(text);
    return info.exists && /<%[\s\S]*?%>/.test(info.frontmatter);
}

function readFrontmatter(text, api)
{
    const info = api.getFrontMatterInfo(text);
    if (hasPendingTemplateFrontmatter(text, api)) {
        throw Object.assign(new Error('Unrendered Templater frontmatter; completion deferred.'), {
            code: 'SESSION_MARKS_DEFERRED',
        });
    }
    let properties;
    try {
        properties = info.exists ? (api.parseYaml(info.frontmatter) ?? {}) : {};
    } catch {
        // Parser errors can contain entire lines of private note text.
        throw Object.assign(
            new Error(
                'Invalid YAML frontmatter; note left unchanged. Check its YAML or exclude its folder.',
            ),
            {
                code: 'REVISION_MARKS_INVALID_FRONTMATTER',
            },
        );
    }
    if (typeof properties !== 'object' || Array.isArray(properties)) {
        throw Object.assign(new Error('Frontmatter must be a mapping; note left unchanged.'), {
            code: 'REVISION_MARKS_INVALID_FRONTMATTER',
        });
    }
    return { info, properties };
}

export function comparableContent(text, api, comparisonVersion = 2, overrides = {})
{
    text = text.replace(/\r\n?/g, '\n');
    const { info, properties } = readFrontmatter(text, api);
    const stable = (value) =>
    {
        if (value instanceof Date) return value.toISOString();
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === 'object')
            return Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, stable(value[key])]),
            );
        return value;
    };
    const names = propertyNames(api);
    const relevant = Object.fromEntries(
        Object.entries({ ...properties, ...overrides }).filter(
            ([key]) =>
                key !== names.updated &&
                !(revisionEnabled(api) && key === names.revision) &&
                !(comparisonVersion === 1 && key === names.created),
        ),
    );
    return (
        JSON.stringify(stable(relevant)) +
        '\n' +
        (info.exists ? text.slice(info.contentStart) : text)
    );
}

export function metadataOf(text, api)
{
    const { properties: fm } = readFrontmatter(text, api);
    const names = propertyNames(api);
    const count = revisionEnabled(api) ? (fm[names.revision] ?? 0) : 0;
    if (!Number.isSafeInteger(count) || count < 0)
        throw new Error(`${names.revision} must be a non-negative integer`);
    return {
        count,
        updated: fm[names.updated] instanceof Date ?
            fm[names.updated].toISOString() :
            (fm[names.updated] ?? null),
        hasCreated: Object.hasOwn(fm, names.created),
        created: fm[names.created] instanceof Date ?
            fm[names.created].toISOString() :
            (fm[names.created] ?? null),
    };
}

export async function sha256(text)
{
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
