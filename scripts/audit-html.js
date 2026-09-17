const fs = require('fs');

const filePath = process.argv[2] || 'index.html';
const html = fs.readFileSync(filePath, 'utf8');
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
const markup = scriptStart >= 0 ? html.slice(0, scriptStart) : html;
const script = scriptStart >= 0 && scriptEnd > scriptStart
    ? html.slice(scriptStart + '<script>'.length, scriptEnd)
    : '';

function collectMatches(text, pattern, group = 1) {
    const values = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        values.push(match[group]);
    }
    return values;
}

const ids = collectMatches(markup, /\bid="([^"]+)"/g);
const idCounts = new Map();
for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);

const functions = new Set(
    collectMatches(script, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)
);
const handlers = collectMatches(
    markup,
    /\bon(?:click|change|submit|input|blur|focus|keydown|keyup)="([^"]+)"/g
);
const handlerCalls = new Set();
for (const handler of handlers) {
    const match = handler.match(/^\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\(/);
    if (match) handlerCalls.add(match[1]);
}

const referencedIds = collectMatches(
    script,
    /getElementById\(['"]([^'"]+)['"]\)/g
);

const report = {
    file: filePath,
    staticIdCount: ids.length,
    duplicateIds: [...idCounts.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1]),
    declaredFunctions: functions.size,
    inlineHandlers: handlers.length,
    missingHandlerFunctions: [...handlerCalls]
        .filter(name => !functions.has(name) && !['alert', 'confirm'].includes(name))
        .sort(),
    missingStaticIds: [...new Set(referencedIds)]
        .filter(id => !idCounts.has(id))
        .sort()
};

console.log(JSON.stringify(report, null, 2));
