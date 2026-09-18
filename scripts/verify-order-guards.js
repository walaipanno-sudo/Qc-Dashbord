const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const appsScriptCode = fs.readFileSync('apps-script/Code.js', 'utf8');

function extractFunction(name) {
    const start = script.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`Missing function ${name}`);
    let brace = script.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < script.length; i++) {
        if (script[i] === '{') depth++;
        if (script[i] === '}') depth--;
        if (depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`Unclosed function ${name}`);
}

const calls = [];
const context = {
    console,
    ORDER_STAGES: ['planning', 'dyeing', 'weaving', 'finishing'],
    NEXT_STAGE: { planning: 'dyeing', dyeing: 'weaving', weaving: 'finishing' },
    STAGE_LABELS: { planning: 'วางแผน', dyeing: 'ย้อม', weaving: 'ทอ', finishing: 'ตกแต่ง/บรรจุ', ready_to_ship: 'รอส่ง' },
    productionOrders: [],
    normalizeOrder: order => ({ ...order, readyToShip: !!order.readyToShip, shipped: !!order.shipped }),
    normalizeDateString: value => String(value || ''),
    showToast: message => calls.push(['toast', message]),
    rerenderOrderViews: index => calls.push(['render', index]),
    persistOrderChange: order => calls.push(['persist', order.currentStage]),
    incrementTransferCount: () => calls.push(['count']),
    mascotCelebrate: () => calls.push(['mascot']),
    notifyLineStageTransfer: () => calls.push(['line']),
    dyeingFullyCoveredBySurplus: () => false,
    computeOrderTimelineSegments: order => order.testSegments || [],
    parseDateOnly: value => {
        const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    },
    formatDateKeyUTC: date => [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0')
    ].join('-')
};
vm.createContext(context);
[
    'normalizeMoSoKey',
    'deduplicateProductionOrders',
    'getEffectiveStage',
    'transferOrderStage',
    'addDaysUTC',
    'deduplicateCalendarOrdersWithIndex',
    'buildProductionCalendarDayMap',
    'newDyeingColorOrderRow',
    'mergeYarnCalculatorColorsIntoOrder',
    'getSurplusAvailableKg',
    'normalizeBomMemoryText',
    'bomMemoryCandidateScore',
    'getBomMemorySuggestion'
].forEach(name => vm.runInContext(extractFunction(name), context));
vm.runInContext(extractFunction('dyeingFullyCoveredBySurplus'), context);

const duplicateInput = [
    { moSo: 'm/o 100 ', currentStage: 'planning', lastUpdated: '2026-09-16' },
    { moSo: ' M/O   100', currentStage: 'weaving', lastUpdated: '2026-09-17' }
];
const deduped = context.deduplicateProductionOrders(duplicateInput);
if (deduped.length !== 1 || deduped[0].currentStage !== 'weaving') {
    throw new Error('Deduplication did not keep one most-recent order');
}

context.productionOrders = [{
    moSo: 'M/O 200',
    currentStage: 'weaving',
    readyToShip: false,
    shipped: false,
    planning: { percent: 100 },
    dyeing: { percent: 100 },
    weaving: { percent: 100, mode: 'internal', receivedPrintedFabric: true, yarnComplete: true },
    finishing: { percent: 0 }
}];
context.transferOrderStage(0, 'planning', 'dyeing');
if (context.productionOrders[0].currentStage !== 'weaving' || calls.some(call => call[0] === 'persist')) {
    throw new Error('Stale transfer action changed the current stage');
}

calls.length = 0;
context.transferOrderStage(0, 'weaving', 'finishing');
if (context.productionOrders[0].currentStage !== 'finishing' || !calls.some(call => call[0] === 'persist')) {
    throw new Error('Valid transfer did not change and persist the current stage');
}

const calendarDuplicates = [
    {
        orderIndex: 3,
        order: {
            moSo: ' M/O 300 ',
            currentStage: 'planning',
            testSegments: [{ start: '2026-09-17', end: '2026-09-18', stage: 'planning', stageSkipped: false }]
        }
    },
    {
        orderIndex: 8,
        order: {
            moSo: 'm/o   300',
            currentStage: 'planning',
            testSegments: [{ start: '2026-09-17', end: '2026-09-18', stage: 'planning', stageSkipped: false }]
        }
    }
];
const uniqueCalendarOrders = context.deduplicateCalendarOrdersWithIndex(calendarDuplicates);
if (uniqueCalendarOrders.length !== 1) {
    throw new Error('Calendar order list retained duplicate M/O rows');
}
const calendarMap = context.buildProductionCalendarDayMap(
    calendarDuplicates,
    new Date(Date.UTC(2026, 8, 17)),
    new Date(Date.UTC(2026, 8, 18))
);
if ((calendarMap['2026-09-17'] || []).length !== 1 || (calendarMap['2026-09-18'] || []).length !== 1) {
    throw new Error('Calendar rendered duplicate M/O entries in a day cell');
}

const dyePlan = {
    dyeing: {
        colorOrders: [{
            id: 'existing',
            colorCode: 'RED-01',
            kg: 5,
            useSurplus: true,
            surplusKg: 5,
            surplusLedgerId: 'stock-1',
            source: 'manual'
        }]
    }
};
context.mergeYarnCalculatorColorsIntoOrder(dyePlan, [
    { colorCode: ' red-01 ', dyeKg: 6 },
    { colorCode: 'BLUE-02', dyeKg: 4 }
]);
context.mergeYarnCalculatorColorsIntoOrder(dyePlan, [
    { colorCode: 'RED-01', dyeKg: 7 },
    { colorCode: 'BLUE-02', dyeKg: 4 }
]);
if (dyePlan.dyeing.colorOrders.length !== 2) {
    throw new Error('Repeated yarn-calculator import created duplicate color rows');
}
if (dyePlan.dyeing.colorOrders[0].kg !== 7 ||
    dyePlan.dyeing.colorOrders[0].surplusLedgerId !== 'stock-1' ||
    dyePlan.dyeing.colorOrders[0].source !== 'calculator') {
    throw new Error('Yarn-calculator merge did not update kg while preserving the Surplus link');
}

const linkedRow = { surplusLedgerId: 'stock-1', surplusKg: 3 };
const stockEntry = { id: 'stock-1', weightInKg: 10, weightOutKg: 8 };
if (context.getSurplusAvailableKg(stockEntry, linkedRow) !== 5) {
    throw new Error('Surplus availability did not restore the current row deduction');
}

if (context.dyeingFullyCoveredBySurplus({ dyeing: { colorOrders: [{ kg: 5, useSurplus: true, surplusKg: 4.99 }] } })) {
    throw new Error('Planning could skip Dyeing without enough Surplus kg');
}
if (!context.dyeingFullyCoveredBySurplus({ dyeing: { colorOrders: [{ kg: 5, useSurplus: true, surplusKg: 5 }] } })) {
    throw new Error('Fully covered Surplus plan was not recognized');
}

const targetOrder = {
    moSo: 'M/O 900',
    orderType: 'MO',
    market: 'domestic',
    quality: 'WL-01',
    yarnType: 'Wool',
    tuftingSpec: 'Cut pile',
    designRef: 'D-100',
    totalSqm: 100,
    planning: { bom: { yarnSkuCode: '', materialNotes: '', prices: {} } }
};
const closeBomOrder = {
    moSo: 'M/O 800',
    orderType: 'MO',
    market: 'domestic',
    quality: ' wl-01 ',
    yarnType: 'WOOL',
    tuftingSpec: 'Cut pile',
    designRef: 'D-100',
    totalSqm: 110,
    lastUpdated: '2026-09-16',
    planning: {
        bom: {
            yarnSkuCode: 'YN-AP-WL01-103-WHT01',
            materialNotes: 'Supplier A',
            prices: { yarnPerKg: 250 }
        }
    }
};
const distantBomOrder = {
    moSo: 'S/O 700',
    orderType: 'SO',
    market: 'export',
    quality: 'OTHER',
    yarnType: 'Nylon',
    tuftingSpec: 'Loop',
    designRef: 'D-999',
    totalSqm: 500,
    lastUpdated: '2026-09-17',
    planning: { bom: { yarnSkuCode: 'YN-STD', materialNotes: '', prices: { yarnPerKg: 100 } } }
};
context.productionOrders = [targetOrder, distantBomOrder, closeBomOrder];
const memorySuggestion = context.getBomMemorySuggestion(targetOrder);
if (!memorySuggestion || memorySuggestion.candidate.moSo !== 'M/O 800') {
    throw new Error('BOM memory did not select the closest historical M/O');
}
if (context.bomMemoryCandidateScore(targetOrder, { planning: { bom: { yarnSkuCode: '', materialNotes: '', prices: {} } } }) !== -1) {
    throw new Error('BOM memory accepted an order without remembered material or cost data');
}
if (!appsScriptCode.includes('"DepartmentGrades"') ||
    !appsScriptCode.includes("headerNames.indexOf('departmentgrades')") ||
    !appsScriptCode.includes("setHeaderValue_('departmentgrades', jsonValue_(order.departmentGrades, {}))")) {
    throw new Error('Department work grades are not fully wired through the Google Sheets backend');
}
if (!appsScriptCode.includes('"SyncRevision"') ||
    !appsScriptCode.includes("headerNames.indexOf('syncrevision')") ||
    !appsScriptCode.includes("setHeaderValue_('syncrevision', order.syncRevision || '')")) {
    throw new Error('Production-order sync revision is not fully wired through the Google Sheets backend');
}
const orderUpsertMatch = appsScriptCode.match(/function upsertOrderIntoSheets_\(order\) \{([\s\S]*?)\n\}/);
if (!orderUpsertMatch ||
    orderUpsertMatch[1].includes('.setValue(') ||
    !orderUpsertMatch[1].includes('.setValues([fullRow])')) {
    throw new Error('Production-order upsert must use one batched row write instead of per-cell writes');
}

[
    "localStorage.getItem('qc_pending_order_syncs_v1')",
    "localStorage.setItem(\n                'qc_pending_order_syncs_v1'",
    'pendingOrderSyncs.forEach((pendingOrder, key) =>',
    "mode: 'no-cors'",
    'confirmOrderSyncRevision(key, payload.syncRevision)',
    'flushPendingOrderSyncs().finally(() => fetchOrdersFromGoogleSheet(false))'
].forEach(marker => {
    if (!script.includes(marker)) {
        throw new Error(`Production-order pending sync guard is incomplete: ${marker}`);
    }
});

console.log('Order deduplication, calendar deduplication, transfer guards, pending sync, dye-plan guards, and BOM memory passed.');
