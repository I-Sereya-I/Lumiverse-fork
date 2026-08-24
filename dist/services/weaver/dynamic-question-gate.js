export function buildDynamicQuestionVerdict(raw, applicable) {
    const applicableKeys = new Set(applicable.map((c) => c.key));
    const labelFor = (key) => applicable.find((c) => c.key === key)?.label ?? key;
    const rawCriteria = Array.isArray(raw.criteria) ? raw.criteria : [];
    const seen = new Map();
    for (const item of rawCriteria) {
        if (!item || typeof item !== "object")
            continue;
        const key = item.key;
        if (typeof key !== "string" || !applicableKeys.has(key) || seen.has(key))
            continue;
        const passed = item.passed === true;
        const noteRaw = item.note;
        seen.set(key, {
            key,
            label: labelFor(key),
            passed,
            note: typeof noteRaw === "string" ? noteRaw.trim() : "",
        });
    }
    const criteria = applicable
        .map((c) => seen.get(c.key))
        .filter((c) => Boolean(c));
    const passed = criteria.length === applicable.length && criteria.every((c) => c.passed);
    const summaryRaw = raw.summary;
    return {
        passed,
        criteria,
        summary: typeof summaryRaw === "string" ? summaryRaw.trim() : "",
    };
}
