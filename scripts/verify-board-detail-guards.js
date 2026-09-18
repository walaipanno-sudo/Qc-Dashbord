const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function extractFunction(name) {
    const start = script.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`Missing function ${name}`);
    const brace = script.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < script.length; i++) {
        if (script[i] === '{') depth++;
        if (script[i] === '}') depth--;
        if (depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`Unclosed function ${name}`);
}

function assertInOrder(source, first, second, message) {
    assert(source.includes(first), `${message}: missing "${first}"`);
    assert(source.includes(second), `${message}: missing "${second}"`);
    assert(source.indexOf(first) < source.indexOf(second), `${message}: controls are not inside the detail section`);
}

const buildOrderCard = extractFunction('buildOrderCard');
const dyeingCard = extractFunction('renderDyeingOrderCardHtml');
const weavingBoard = extractFunction('renderWeavingLoomBoard');
const overviewRow = extractFunction('buildOverviewRowHtml');

assertInOrder(
    buildOrderCard,
    '<details class="border-t border-slate-100 pt-1.5 group">',
    '${renderPlanningWeavingSpecTableHtml(order, orderIndex, true)}',
    'Planning board details'
);
assertInOrder(
    buildOrderCard,
    '<details class="border-t border-slate-100 pt-1.5 group">',
    '${renderDyeingColorOrdersHtml(order, orderIndex, true)}',
    'Planning dyeing controls'
);
assertInOrder(
    dyeingCard,
    '<details class="border-t border-violet-100 pt-1.5 group">',
    '${renderDyeingColorOrdersHtml(order, orderIndex, true)}',
    'Dyeing board details'
);

assert(
    weavingBoard.includes('Array.from(occupanciesByLoom.keys())'),
    'Weaving board must derive visible loom labels from real occupancy data'
);
assert(
    !weavingBoard.includes('const configuredLooms = []'),
    'Weaving board must not pre-render all configured empty looms'
);
assert(
    !weavingBoard.includes('renderIdleLoomCardHtml(loomLabel)'),
    'Weaving board must not render idle loom cards'
);
assert(
    weavingBoard.includes('occupanciesByLoom.get(loomLabel) || []'),
    'Weaving board must preserve all assignments sharing one loom label'
);
assert(
    overviewRow.includes('renderStageStepper(effectiveStage, getOverviewStageLabel(order, effectiveStage))'),
    'Overview rows must render the derived weaving status'
);

const context = {
    productionOrders: [],
    STAGE_LABELS: { planning: 'วางแผน', weaving: 'ทอ' }
};
vm.createContext(context);
vm.runInContext(extractFunction('getCurrentLoomOccupancies'), context);
vm.runInContext(extractFunction('getOverviewStageLabel'), context);

const first = {
    moSo: 'M/O 100',
    weaving: { dailyLog: [{ date: '2026-09-18', loom: '2', sqm: 1 }] }
};
const second = {
    moSo: 'M/O 101',
    weaving: { dailyLog: [{ date: '2026-09-17', loom: '2', sqm: 2 }] }
};
const waiting = {
    moSo: 'M/O 102',
    weaving: { dailyLog: [{ date: '2026-09-18', loom: '', sqm: 3 }] }
};
context.productionOrders = [first, second, waiting];
const occupancies = context.getCurrentLoomOccupancies(context.productionOrders);

assert.strictEqual(occupancies.length, 2, 'Only orders with a logged loom should occupy the weaving board');
assert.strictEqual(
    Array.from(occupancies, item => item.loom).join(','),
    '2,2',
    'Two orders using the same loom label must remain separate assignments'
);
assert.strictEqual(
    occupancies.filter(item => item.order.moSo === 'M/O 102').length,
    0,
    'An order without a loom number must remain in the waiting list'
);

assert.strictEqual(context.getOverviewStageLabel(waiting, 'weaving'), 'รอคิวทอ');
assert.strictEqual(context.getOverviewStageLabel(first, 'weaving'), 'กำลังทอจอ 2');
assert.strictEqual(
    context.getOverviewStageLabel({
        weaving: { dailyLog: [{ date: '2026-09-17', loom: '2' }, { date: '2026-09-18', loom: '5' }] }
    }, 'weaving'),
    'กำลังทอจอ 5',
    'Overview must use the latest logged loom, not a previous assignment'
);
assert.strictEqual(
    context.getOverviewStageLabel({
        weaving: { dailyLog: [{ date: '2026-09-17', loom: '2' }, { date: '2026-09-18', loom: '' }] }
    }, 'weaving'),
    'รอคิวทอ',
    'A latest log without a loom must return the order to the waiting queue'
);
assert.strictEqual(
    context.getOverviewStageLabel({ weaving: { mode: 'external', dailyLog: [] } }, 'weaving'),
    'ทอ',
    'Outsourced weaving must retain its normal stage label'
);
assert.strictEqual(context.getOverviewStageLabel(first, 'planning'), 'วางแผน');

console.log('Board detail collapse and active-loom rendering guards passed.');
