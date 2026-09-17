const SHEET_NAME = "Sheet1";

// NEW (2026-09-09): every M/O, S/O used to live in one shared "ProductionOrders" sheet (tagged with
// OrderType/Market columns so the dashboard could filter M/O vs S/O and ต่างประเทศ vs ในประเทศ on the
// client side). Per explicit request, orders are now split into 4 PHYSICAL sheet tabs — one per
// OrderType x Market combination — so someone can open Google Sheets directly and see each category
// on its own tab, not just filter one big list. LEGACY_ORDERS_SHEET_NAME is only read once, by
// ensureOrdersMigratedOnce_() below, to move any pre-existing rows into the 4 new sheets; every other
// function here works against ORDERS_SHEET_NAMES.
const LEGACY_ORDERS_SHEET_NAME = "ProductionOrders";
const ORDERS_SHEET_NAMES = {
  MO_export:   "M-O ต่างประเทศ",
  MO_domestic: "M-O ในประเทศ",
  SO_export:   "S-O ต่างประเทศ",
  SO_domestic: "S-O ในประเทศ"
};

// LINE credentials are stored in Apps Script Properties, never in source control.
// Required property: LINE_CHANNEL_ACCESS_TOKEN
// Optional property: LINE_GROUP_ID
function getLineConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    accessToken: String(props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '').trim(),
    groupId: String(props.getProperty('LINE_GROUP_ID') || '').trim()
  };
}

// Safe diagnostic for the Apps Script editor or clasp run. It never returns secret values.
function getRuntimeConfigStatus() {
  var line = getLineConfig_();
  var props = PropertiesService.getScriptProperties();
  return {
    lineAccessTokenConfigured: !!line.accessToken,
    lineGroupConfigured: !!line.groupId,
    supabaseConfigured: !!(
      props.getProperty('SUPABASE_URL') &&
      props.getProperty('SUPABASE_SERVICE_ROLE_KEY')
    ),
    dashboardWriteKeyConfigured: !!props.getProperty('DASHBOARD_WRITE_KEY')
  };
}

// Optional phased protection for every write endpoint. Existing users continue to work while the
// property is blank. Once DASHBOARD_WRITE_KEY is configured, browsers must send the same key as the
// writeKey query parameter; read-only dashboard endpoints remain public.
function hasDashboardWriteAccess_(e) {
  var expected = String(
    PropertiesService.getScriptProperties().getProperty('DASHBOARD_WRITE_KEY') || ''
  ).trim();
  if (!expected) return true;
  var provided = e && e.parameter ? String(e.parameter.writeKey || '').trim() : '';
  return provided === expected;
}

function dashboardWriteDeniedResponse_() {
  return ContentService
    .createTextOutput(JSON.stringify({ result: 'forbidden', error: 'Invalid dashboard write key.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// FIX (2026-09-14): "ติด limit LINE ขอแบบส่งฟรี" — the original sendLineBroadcast() sent every
// notification to EVERY follower of the OA via LINE's Broadcast API, which LINE bills as
// (จำนวนผู้ติดตาม × จำนวนครั้งที่ส่ง) against the free monthly message quota — 20 followers × 50 sends
// = 1,000 messages, blowing through the free tier almost immediately. Pushing the same message to a
// single LINE GROUP instead costs only 1 message per send (LINE bills push/multicast by number of
// TARGETS, and a group is one target no matter how many people are in it), so a whole staff group can
// get every notification for a tiny fraction of the quota.
//
// SETUP (one-time, do this once to switch over):
//   1. Deploy this .gs as a new Web App version first (Deploy → Manage deployments → Edit → New
//      version) so the webhook-detection code below is actually live.
//   2. LINE Developers Console → your Messaging API channel → "Messaging API" tab → Webhook settings
//      → paste this Web App's /exec URL into "Webhook URL" → turn "Use webhook" ON.
//   3. LINE Official Account Manager (manager.line.biz) → Settings → Response settings → turn ON
//      "Allow to be added on group chats" (may be labeled "Group chat" depending on the current UI) —
//      without this, the OA can't be invited into a group at all.
//   4. Create (or reuse) a LINE group with the staff who should see notifications, then invite this
//      Official Account into that group like inviting any friend.
//   5. That invite fires a "join" webhook event straight to this script, which auto-logs the group's
//      ID into a new "LineGroupLog" tab in this spreadsheet (see handleLineWebhookEvents_() below) —
//      open that tab, copy the GroupOrRoomId from the newest row.
//   6. Paste that ID into LINE_GROUP_ID right below, save, then Deploy → Manage deployments → Edit →
//      New version again.
//   7. Run testLineNotify() once (Apps Script editor → select it from the Run dropdown → Run) to
//      confirm the group gets the test message. From then on every notification goes to that one
//      group instead of broadcasting to all followers.
// Leave this blank ("") to keep the old broadcast-to-everyone behavior (sendLineNotification() below
// automatically falls back to it when no group is set yet, so nothing breaks mid-setup).
// Sends a plain-text push message to a single LINE group/room (see LINE_GROUP_ID's setup steps
// above). Costs 1 message from the monthly quota per call, regardless of how many people are in the
// group — this is what makes group notification so much cheaper than Broadcast.
function sendLineGroupPush(message, targetId) {
  var accessToken = getLineConfig_().accessToken;
  if (!accessToken || !targetId) return;
  var url = 'https://api.line.me/v2/bot/message/push';
  var payload = {
    to: targetId,
    messages: [{ type: 'text', text: String(message || '').substring(0, 5000) }]
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  Logger.log('LINE group push response: ' + response.getResponseCode() + ' ' + response.getContentText());
  return response;
}

// Broadcasts a plain-text message to every follower of the LINE Official Account tied to
// LINE_CHANNEL_ACCESS_TOKEN. Kept as the pre-group-setup fallback — see sendLineNotification() below,
// which is what every call site in this file actually calls now. Costs 1 message PER FOLLOWER per
// send, which is the expensive behavior LINE_GROUP_ID above exists to avoid.
function sendLineBroadcast(message) {
  var accessToken = getLineConfig_().accessToken;
  if (!accessToken) return;
  var url = 'https://api.line.me/v2/bot/message/broadcast';
  var payload = {
    messages: [{ type: 'text', text: String(message || '').substring(0, 5000) }]
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, options);
  Logger.log('LINE broadcast response: ' + response.getResponseCode() + ' ' + response.getContentText());
  return response;
}

// Single entry point every notifyLineXxx() call in QCDashboard.html routes through (via the
// ?type=lineNotify branch in doPost() below) — picks group-push when LINE_GROUP_ID is configured,
// otherwise falls back to the old broadcast-to-everyone behavior so nothing breaks before setup is done.
function sendLineNotification(message) {
  var groupId = getLineConfig_().groupId;
  if (groupId) return sendLineGroupPush(message, groupId);
  return sendLineBroadcast(message);
}

// Handles an incoming LINE Messaging API webhook call (see LINE_GROUP_ID's setup steps above, step 2
// onward) — only job right now is discovering + logging the groupId/roomId of whatever group/room
// this OA gets invited into, since that's the one manual value (LINE_GROUP_ID) this whole switch-to-
// group-push feature needs a human to copy in once. Every event still gets logged (not just "join"),
// since even a plain message sent by a member inside the group also carries the same source.groupId —
// handy as a second way to find it if the "join" event ever gets missed.
// MUST return quickly and MUST always return 200 — LINE disables/flags a webhook that errors or is slow.
function handleLineWebhookEvents_(events) {
  try {
    var sheet = getOrCreateLineGroupLogSheet_();
    events.forEach(function(event) {
      var source = (event && event.source) || {};
      if (source.type === 'group' || source.type === 'room') {
        var id = source.groupId || source.roomId || '';
        sheet.appendRow([new Date(), event.type || '', source.type, id]);
      }
    });
  } catch (err) {
    Logger.log('LINE webhook log error: ' + err.toString());
  }
  return ContentService.createTextOutput(JSON.stringify({ result: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateLineGroupLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('LineGroupLog');
  if (!sheet) {
    sheet = ss.insertSheet('LineGroupLog');
    sheet.appendRow(['Timestamp', 'EventType', 'SourceType', 'GroupOrRoomId']);
  }
  return sheet;
}

// DIAGNOSTIC (2026-09): run this manually from the Apps Script editor — select "testLineNotify" in
// the function dropdown next to Run, click Run — whenever someone reports "no LINE notification
// arrived". The dashboard's own calls to this are fire-and-forget from the browser (mode: 'no-cors'
// means the browser can never see the response, success or failure), so this is the only way to see
// what LINE's API actually said. Check the Execution log after running:
//   - 200 with a response body like {} : the request succeeded. If LINE_GROUP_ID is blank, this went
//     out as a broadcast — LINE only delivers a broadcast to people who have already added this
//     Official Account as a friend, so if nobody has, the call still reports success but nothing shows
//     up in anyone's LINE app.
//   - 401 : LINE_CHANNEL_ACCESS_TOKEN is invalid, expired, or was revoked — regenerate it from the
//     LINE Developers Console (Messaging API channel settings) and paste the new value in at the top
//     of this file.
//   - 400 with LINE_GROUP_ID set : usually means the OA is no longer in that group (removed/left) or
//     the ID was copied wrong — re-check the "LineGroupLog" sheet tab for the latest ID.
//   - 400 with LINE_GROUP_ID blank : malformed broadcast request — Logger's response body says exactly
//     what LINE rejected.
function testLineNotify() {
  var response = sendLineNotification('🔔 ทดสอบการแจ้งเตือนจากระบบ QC Dashboard (' + new Date().toLocaleString('th-TH') + ')');
  Logger.log('testLineNotify done. Response code: ' + (response ? response.getResponseCode() : '(no response — check LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID is set)'));
}

// FIX (2026-09): the QC sheet had no "Remark" column at all — a typed remark saved fine to
// localStorage, but the moment the dashboard synced from the Sheet again (on load, or a manual
// sync), the record that came back had no remark on it, so it looked like the text "disappeared".
// Separately, doPost() used to write each field to a hardcoded column NUMBER (1..9) while doGet()
// read fields back by looking up the column NAME — if this sheet's real header row ever drifted
// from that assumed order (columns added/reordered by hand in Google Sheets, or an older sheet
// from before a column existed), a value like Inspector could get written into the wrong physical
// column and then read back as blank. ensureQcHeaders() below is now the single source of truth
// for this sheet's header row, and both doGet() and doPost() look up every column by name through
// it, so reads and writes always agree on where each field lives — and it auto-adds a "Remark"
// column to an existing sheet that predates this fix, without disturbing any other column.
var QC_DEFAULT_HEADERS = ["ID", "Date", "Department", "MO/SO", "Details", "Status", "Inspector", "Stamp Pass", "Remark", "ExtraData"];

function ensureQcHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); }) : [];

  if (headers.length === 0 || headers.every(function(h) { return h === ''; })) {
    sheet.getRange(1, 1, 1, QC_DEFAULT_HEADERS.length).setValues([QC_DEFAULT_HEADERS]);
    return QC_DEFAULT_HEADERS.slice();
  }

  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  if (lowerHeaders.indexOf('remark') === -1 && lowerHeaders.indexOf('หมายเหตุ') === -1) {
    var newCol = headers.length + 1;
    sheet.getRange(1, newCol).setValue('Remark');
    headers.push('Remark');
  }

  headers = fixLegacyQcHeaderLabels_(sheet, headers);
  return headers;
}

// CRITICAL FIX (2026-09-10): the live QC sheet's row-1 header text turned out to be a pre-existing
// legacy layout that was silently destroying data on every single QC save. Confirmed by downloading
// and inspecting the actual sheet: its header row read literally as
// ["id","date","department","details","status","inspector","stamp","","","remark"] (lowercased) — note
// there is NO column literally named "mo/so" or "extradata" anywhere, and "details" sits at the exact
// position that has always actually held the M/O, S/O value, not detail text. Because doPost() (further
// below) looks up every column by NAME via qcColIndex(), this meant:
//   - qcColIndex(lowerHeaders, 'mo/so') found nothing -> the M/O, S/O the user actually typed was NEVER
//     written to the sheet on save (silently skipped every time).
//   - qcColIndex(lowerHeaders, 'details') found "details" sitting at the position that held the real
//     M/O, S/O value -> the Details text got written OVER that position instead, destroying it.
//   - qcColIndex(lowerHeaders, 'extradata') found nothing -> ExtraData was never written either — two
//     columns at the end of the header row were sitting blank/orphaned, unused for a long time.
// This function detects EXACTLY that known-broken signature by POSITION (not just "some header is
// missing"), so it can never misfire on a sheet that genuinely uses a different column layout on
// purpose. It repairs ONLY the header LABELS in place — it never touches, moves, or reorders any data
// row — so it is safe to run on every single request (called from ensureQcHeaders() above). Once the
// labels are corrected to match where the data already physically lives, every qcColIndex() lookup
// elsewhere in this file starts resolving to the right column and the corruption stops immediately.
// The rows that were ALREADY corrupted before this fix still need the one-time data repair in
// cleanupQcMosoCorruption() below (?action=cleanupQcMoso&confirm=yes) — this function alone only stops
// the bleeding for future saves, it does not recover past damage.
function fixLegacyQcHeaderLabels_(sheet, headers) {
  var lower = headers.map(function(h) { return String(h).trim().toLowerCase(); });
  var hasMoSo = lower.indexOf('mo/so') !== -1 || lower.indexOf('mo/s/o') !== -1;
  var hasExtraData = lower.indexOf('extradata') !== -1 || lower.indexOf('ข้อมูลเพิ่มเติม') !== -1;
  if (hasMoSo || hasExtraData) return headers; // already fine (or a different, non-legacy layout) — leave alone

  // Known-broken signature, checked by exact position so this can never misfire on an unrelated sheet:
  // index 3 literally says "details" (the position that actually holds the true M/O, S/O value), and
  // indexes 7 and 8 are blank (the orphaned columns meant for Details text and raw ExtraData JSON).
  if (lower.length < 9 || lower[3] !== 'details' || lower[7] !== '' || lower[8] !== '') return headers;

  var fixed = headers.slice();
  fixed[3] = 'MO/SO';
  fixed[6] = 'Stamp Pass';
  fixed[7] = 'Details';
  fixed[8] = 'ExtraData';
  sheet.getRange(1, 1, 1, fixed.length).setValues([fixed]);
  Logger.log('fixLegacyQcHeaderLabels_: corrected legacy QC sheet header labels (no data moved): ' + JSON.stringify(fixed));
  return fixed;
}

// Best-effort typo normalization for the very common hand-typed mix-up of the digit "0" for the letter
// "O" right after the M/ or S/ prefix (e.g. "M/0 TH152/26" meant "M/O TH152/26") — seen throughout the
// live sheet's dyeing records. Used only when reconstructing an M/O, S/O value for cleanupQcMosoCorruption()
// below, never when writing a fresh value a user just typed themselves.
function normalizeMoSoTypo_(v) {
  return String(v || '').replace(/M\/0/gi, 'M/O').replace(/S\/0/gi, 'S/O').trim();
}

// ONE-TIME data fix (2026-09-10): repairs QC rows whose M/O, S/O cell got destroyed by the legacy
// header-label bug fixed by fixLegacyQcHeaderLabels_() above — every row where that cell still holds
// the raw ExtraData JSON blob instead of a real M/O, S/O value. For every such row:
//   - แผนกย้อม (dyeing) records embed each color-batch's own M/O, S/O inside ExtraData.items[].moSo, so
//     the true value(s) can be reconstructed from data still sitting on the row. This is done
//     automatically, but the result is prefixed with a "[ตรวจสอบ]" marker — the exact original text
//     (spacing, separators, which typo variant was used) can't be perfectly reproduced, only its
//     content, so a human should double-check it once.
//   - Every other department's ExtraData schema never included the M/O, S/O inside it, so for those
//     the original value is genuinely gone. This leaves a clear
//     "⚠️ M/O, S/O ถูกเขียนทับ - กรุณากรอกใหม่" placeholder instead of guessing, and lists the row in
//     the response's needsManualFix array so it can be found and hand-corrected (from the Sheet
//     directly, or by editing that record from the dashboard).
// Also rebuilds that row's Details (human-readable text) and ExtraData (raw JSON backup) columns from
// the same recovered JSON, since those had never been written for these rows either. Safe to run more
// than once: a row already repaired no longer has JSON sitting in its M/O, S/O cell, so a second run
// simply skips it (see the `currentMoso.indexOf('{') !== 0` guard below).
function cleanupQcMosoCorruption(sheet) {
  sheet = sheet || (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME) || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]);
  var headers = ensureQcHeaders(sheet); // also self-heals the header labels first, if that hasn't run yet
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });

  var idIdx = qcColIndex(lowerHeaders, 'id');
  var dateIdx = qcColIndex(lowerHeaders, 'date', 'วันที่');
  var deptIdx = qcColIndex(lowerHeaders, 'department', 'แผนก');
  var mosoIdx = qcColIndex(lowerHeaders, 'mo/so') !== -1 ? qcColIndex(lowerHeaders, 'mo/so') : qcColIndex(lowerHeaders, 'mo/s/o');
  var detailsIdx = qcColIndex(lowerHeaders, 'details');
  var extraIdx = qcColIndex(lowerHeaders, 'extradata', 'ข้อมูลเพิ่มเติม');

  if (mosoIdx === -1 || extraIdx === -1) {
    return { fixed: 0, error: 'ไม่พบคอลัมน์ MO/SO หรือ ExtraData ในชีตนี้ — ตรวจสอบว่า deploy โค้ดเวอร์ชันล่าสุดแล้ว' };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { fixed: 0, recovered: [], needsManualFix: [], skippedUnparseable: 0 };

  var numRows = lastRow - 1;
  var idVals = idIdx !== -1 ? sheet.getRange(2, idIdx + 1, numRows, 1).getValues() : null;
  var dateVals = dateIdx !== -1 ? sheet.getRange(2, dateIdx + 1, numRows, 1).getValues() : null;
  var deptVals = deptIdx !== -1 ? sheet.getRange(2, deptIdx + 1, numRows, 1).getValues() : null;
  var mosoRange = sheet.getRange(2, mosoIdx + 1, numRows, 1);
  var mosoVals = mosoRange.getValues();
  var detailsRange = detailsIdx !== -1 ? sheet.getRange(2, detailsIdx + 1, numRows, 1) : null;
  var detailsVals = detailsRange ? detailsRange.getValues() : null;
  var extraRange = sheet.getRange(2, extraIdx + 1, numRows, 1);
  var extraVals = extraRange.getValues();

  var recovered = [];
  var needsManualFix = [];
  var skippedUnparseable = 0;
  var fixedCount = 0;

  for (var i = 0; i < numRows; i++) {
    var id = idVals ? String(idVals[i][0] || '') : '';
    if (!id) continue; // blank/junk row — nothing to repair

    var currentMoso = String(mosoVals[i][0] || '').trim();
    if (currentMoso.indexOf('{') !== 0) continue; // doesn't look corrupted — leave untouched

    var dept = deptVals ? String(deptVals[i][0] || '') : '';
    var date = dateVals ? String(dateVals[i][0] || '') : '';

    var parsed;
    try {
      parsed = JSON.parse(currentMoso);
    } catch (parseErr) {
      skippedUnparseable++;
      continue; // not valid JSON either — leave this row alone rather than guess
    }

    var newMoso;
    if (dept === 'แผนกย้อม') {
      var items = parsed.items || (parsed.moSo ? [parsed] : []);
      var seen = {};
      var list = [];
      items.forEach(function(it) {
        var v = normalizeMoSoTypo_(it.moSo);
        if (v && !seen[v]) { seen[v] = true; list.push(v); }
      });
      if (list.length > 0) {
        newMoso = '[ตรวจสอบ] ' + list.join(', ');
        recovered.push({ row: i + 2, id: id, department: dept, date: date, recoveredMoSo: newMoso });
      } else {
        newMoso = '⚠️ M/O, S/O ถูกเขียนทับ - กรุณากรอกใหม่';
        needsManualFix.push({ row: i + 2, id: id, department: dept, date: date });
      }
    } else {
      newMoso = '⚠️ M/O, S/O ถูกเขียนทับ - กรุณากรอกใหม่';
      needsManualFix.push({ row: i + 2, id: id, department: dept, date: date });
    }

    mosoVals[i][0] = newMoso;
    if (detailsVals) detailsVals[i][0] = buildQcDetailsTextFromExtraData_(dept, newMoso, parsed);
    extraVals[i][0] = JSON.stringify(parsed);
    fixedCount++;
  }

  mosoRange.setValues(mosoVals);
  if (detailsRange) detailsRange.setValues(detailsVals);
  extraRange.setValues(extraVals);

  Logger.log('cleanupQcMosoCorruption: fixed ' + fixedCount + ' row(s). Recovered: ' + JSON.stringify(recovered) + '. Needs manual fix: ' + JSON.stringify(needsManualFix) + '. Skipped unparseable: ' + skippedUnparseable);
  return { fixed: fixedCount, recovered: recovered, needsManualFix: needsManualFix, skippedUnparseable: skippedUnparseable };
}

// 0-based column index for a header name, checking an optional Thai alternative too. -1 if the
// sheet genuinely has no such column (older/customized sheets) — callers must skip writing/reading
// that field rather than guess a position, which is exactly the bug this replaces.
function qcColIndex(lowerHeaders, name, altThai) {
  var idx = lowerHeaders.indexOf(name);
  if (idx === -1 && altThai) idx = lowerHeaders.indexOf(altThai);
  return idx;
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    ensureQcHeaders(sheet);

    var action = e && e.parameter ? e.parameter.action : '';
    var protectedGetActions = {
      delete: true,
      deleteOrder: true,
      deleteIssue: true,
      deleteSpecTemplate: true,
      deleteWeavingStaff: true,
      cleanupInspectorStamp: true,
      cleanupQcDetails: true,
      cleanupQcMoso: true
    };
    if (protectedGetActions[action] && !hasDashboardWriteAccess_(e)) {
      return dashboardWriteDeniedResponse_();
    }

    if (action === 'get') {
      return getJsonDataResponse(sheet);
    } else if (action === 'delete') {
      var idToDelete = e.parameter.id;
      return deleteRowById(sheet, idToDelete);
    } else if (action === 'getOrders') {
      // NEW: production pipeline data for the "ภาพรวมการผลิต" / "แผนผังการผลิต" tabs
      return getOrdersJsonResponse();
    } else if (action === 'deleteOrder') {
      // NEW: deletes a whole M/O, S/O production-pipeline row (not a single QC record — see
      // deleteRowById above for that). Keyed by MoSo since this sheet has no separate ID column.
      var moSoToDelete = e.parameter.moSo;
      return deleteOrderRowByMoSo(moSoToDelete);
    } else if (action === 'getIssues') {
      // NEW (2026-09e): issue reports ("แจ้งปัญหา") for the "ปัญหาที่ต้องติดตาม" tab — see
      // getIssuesJsonResponse() above.
      return getIssuesJsonResponse();
    } else if (action === 'deleteIssue') {
      var issueIdToDelete = e.parameter.id;
      return deleteIssueById(issueIdToDelete);
    } else if (action === 'getProductionSettings') {
      // NEW (2026-09-10): shared staff/OT/regular-hours assumptions for the production calculation
      // engine — see getProductionSettingsJsonResponse() above.
      return getProductionSettingsJsonResponse();
    } else if (action === 'getSpecTemplates') {
      // NEW (2026-09-12): SPECIFICATIONS checklist templates ("แม่แบบลูกค้า/สินค้า") — see
      // getSpecTemplatesJsonResponse() above.
      return getSpecTemplatesJsonResponse();
    } else if (action === 'deleteSpecTemplate') {
      var specTemplateIdToDelete = e.parameter.id;
      return deleteSpecTemplateById(specTemplateIdToDelete);
    } else if (action === 'getWeavingStaff') {
      // NEW (2026-09-12): รายชื่อพนักงานทอมือ ("บันทึกการทอรายวัน") — see getWeavingStaffJsonResponse() above.
      return getWeavingStaffJsonResponse();
    } else if (action === 'getSharedRecords') {
      return getSharedRecordsJsonResponse(e.parameter.collection);
    } else if (action === 'deleteWeavingStaff') {
      var weavingStaffIdToDelete = e.parameter.id;
      return deleteWeavingStaffMemberById(weavingStaffIdToDelete);
    } else if (action === 'cleanupInspectorStamp') {
      // ONE-TIME data fix (2026-09): older QC records (from before the Inspector/Remark column-
      // mapping fix above) have "Inspector" hardcoded to "PASS" on every row, with the real
      // inspector's name sitting in "Stamp Pass" instead. Requires ?confirm=yes so this never runs
      // by accident from a stray link click. Safe to run more than once — see
      // cleanupSwappedInspectorStamp() below for why.
      if (!e.parameter.confirm || e.parameter.confirm !== 'yes') {
        return ContentService.createTextOutput(JSON.stringify({ result: 'confirm_required', message: 'Add &confirm=yes to run this cleanup.' })).setMimeType(ContentService.MimeType.JSON);
      }
      var cleanupResult = cleanupSwappedInspectorStamp(sheet);
      return ContentService.createTextOutput(JSON.stringify(cleanupResult)).setMimeType(ContentService.MimeType.JSON);
    } else if (action === 'cleanupQcDetails') {
      // ONE-TIME data fix (2026-09-09): rewrites "Details" on every EXISTING QC row from its old raw-
      // JSON value into the same human-readable Thai text new records get going forward (see
      // buildQcDetailsTextFromExtraData_() below). Requires ?confirm=yes, same guard as
      // cleanupInspectorStamp above. Safe to run more than once — see cleanupQcDetailsColumn() below.
      if (!e.parameter.confirm || e.parameter.confirm !== 'yes') {
        return ContentService.createTextOutput(JSON.stringify({ result: 'confirm_required', message: 'Add &confirm=yes to run this cleanup.' })).setMimeType(ContentService.MimeType.JSON);
      }
      var qcDetailsCleanupResult = cleanupQcDetailsColumn(sheet);
      return ContentService.createTextOutput(JSON.stringify(qcDetailsCleanupResult)).setMimeType(ContentService.MimeType.JSON);
    } else if (action === 'cleanupQcMoso') {
      // ONE-TIME data fix (2026-09-10): repairs M/O, S/O values destroyed by the legacy header-label
      // bug — see fixLegacyQcHeaderLabels_() and cleanupQcMosoCorruption() above for the full
      // explanation of what happened and how each row is repaired (or flagged for manual fix when the
      // original value can't be recovered). Requires ?confirm=yes, same guard as the other one-time
      // cleanups above. Safe to run more than once.
      if (!e.parameter.confirm || e.parameter.confirm !== 'yes') {
        return ContentService.createTextOutput(JSON.stringify({ result: 'confirm_required', message: 'Add &confirm=yes to run this cleanup.' })).setMimeType(ContentService.MimeType.JSON);
      }
      var qcMosoCleanupResult = cleanupQcMosoCorruption(sheet);
      return ContentService.createTextOutput(JSON.stringify(qcMosoCleanupResult)).setMimeType(ContentService.MimeType.JSON);
    }

    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('QC Check Sheet - Comprehensive Textile Workflow')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ONE-TIME CLEANUP (2026-09): before the Inspector/Remark column-mapping fix, the QC submission
// flow left "Inspector" as the literal placeholder "PASS" on every row and put the real inspector's
// typed name into "Stamp Pass" instead (a leftover from an older form layout, back when "Stamp Pass"
// was apparently used as a free-text signature box rather than today's PASS/-/FAIL dropdown).
//
// This swaps Inspector <-> Stamp Pass, but ONLY for rows where Inspector currently holds a
// "placeholder" value (blank, PASS, FAIL, PENDING, or "-") AND Stamp Pass holds something that is
// NOT one of those placeholders (i.e. looks like an actual typed name). Rows where both columns are
// already placeholders (no name was ever captured) are left untouched — there is nothing to recover.
// Rows that already have a real name in Inspector are left untouched too, which is what makes this
// safe to run again: once a row is fixed, Inspector no longer holds a placeholder, so a second run
// skips it.
function isPlaceholderInspectorValue_(v) {
  var s = String(v || '').trim().toLowerCase();
  return s === '' || s === 'pass' || s === 'fail' || s === 'pending' || s === '-';
}

function cleanupSwappedInspectorStamp(sheet) {
  sheet = sheet || (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME) || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]);
  var headers = ensureQcHeaders(sheet);
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var inspIdx = qcColIndex(lowerHeaders, 'inspector', 'ผู้ตรวจสอบ');
  var stampIdx = qcColIndex(lowerHeaders, 'stamp pass') !== -1 ? qcColIndex(lowerHeaders, 'stamp pass') : qcColIndex(lowerHeaders, 'stamp');
  var idIdx = qcColIndex(lowerHeaders, 'id');

  if (inspIdx === -1 || stampIdx === -1) {
    return { fixed: 0, error: 'ไม่พบคอลัมน์ Inspector หรือ Stamp Pass ในชีตนี้' };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { fixed: 0, rows: [] };

  var numRows = lastRow - 1;
  var inspRange = sheet.getRange(2, inspIdx + 1, numRows, 1);
  var stampRange = sheet.getRange(2, stampIdx + 1, numRows, 1);
  var idRange = idIdx !== -1 ? sheet.getRange(2, idIdx + 1, numRows, 1) : null;

  var inspVals = inspRange.getValues();
  var stampVals = stampRange.getValues();
  var idVals = idRange ? idRange.getValues() : null;

  var fixedRows = [];
  for (var i = 0; i < numRows; i++) {
    var insp = inspVals[i][0];
    var stamp = stampVals[i][0];
    if (isPlaceholderInspectorValue_(insp) && !isPlaceholderInspectorValue_(stamp)) {
      fixedRows.push({ row: i + 2, id: idVals ? String(idVals[i][0] || '') : '', oldInspector: String(insp || ''), newInspector: String(stamp) });
      inspVals[i][0] = stamp;
      stampVals[i][0] = insp || 'PASS';
    }
  }

  if (fixedRows.length > 0) {
    inspRange.setValues(inspVals);
    stampRange.setValues(stampVals);
  }

  Logger.log('cleanupSwappedInspectorStamp: fixed ' + fixedRows.length + ' row(s): ' + JSON.stringify(fixedRows));
  return { fixed: fixedRows.length, rows: fixedRows };
}

// Server-side mirror of buildQcDetailsText() in QCDashboard.html — same per-department field
// breakdown, same plain-text "n) field: value | field: value" line format, same "\n"-joined multi-
// item layout. Kept as a near-literal copy (rather than trying to share code across a .gs file and an
// .html file, which Apps Script can't do directly) so cleanupQcDetailsColumn() below can rebuild the
// exact same readable text for EXISTING rows that the client already writes for new ones. If the two
// ever need to change, update both — this one and buildQcDetailsText() in QCDashboard.html.
function buildQcDetailsTextFromExtraData_(department, moSo, extraData) {
  var ex = extraData || {};
  var lines = [];
  function safe(v, dash) { return (v === undefined || v === null || v === '') ? (dash || '-') : v; }

  if (department === 'ดีไซน์/ขยายลาย') {
    (ex.items || []).forEach(function(it, i) {
      lines.push((i + 1) + ') Design ID ตรงกับ M/O: ' + safe(it.designIdMatch) + ' | ขนาดตรงตาม PO: ' + safe(it.sizeMatch) + ' | ตรวจสี/ลาย: ' + safe(it.colorCheck) + ' | จำนวนแก้ไข: ' + safe(it.fixQty, '0') + ' ชิ้น | สาเหตุ/หมายเหตุ: ' + safe(it.reason));
    });
  } else if (department === 'แผนกวางแผน') {
    (ex.items || []).forEach(function(it, i) {
      lines.push((i + 1) + ') เกรดการทอ: ' + safe(it.weavingGrade) + ' | กำหนดเสร็จ: ' + safe(it.dueDate) + ' | ภาระงานพนักงาน: ' + safe(it.weaverWorkload));
    });
  } else if (department === 'แผนกย้อม') {
    var dyeItems = ex.items || ((ex.codeAndQty || ex.colorCode) ? [ex] : []);
    dyeItems.forEach(function(it, i) {
      lines.push((i + 1) + ') M/O, S/O: ' + safe(it.moSo || moSo) + ' | Code สี: ' + safe(it.colorCode || it.codeAndQty) + ' | จำนวน: ' + safe(it.quantity) + ' | ผลเทียบสี: ' + safe(it.colorMatch) + ' | ผู้อนุมัติ/รายละเอียดแก้ไข: ' + safe(it.approverInfo));
    });
  } else if (department === 'แผนกทอมือ') {
    lines.push('จอ/เครื่องทอ: ' + safe(ex.loomNo));
    (ex.loomRounds || []).forEach(function(r, i) {
      lines.push('รอบ ' + (i + 1) + ': เริ่ม ' + safe(r.start) + ' | เสร็จ ' + safe(r.end) + ' | ปัญหา: ' + safe(r.problem) + ' | วิธีแก้ไข: ' + safe(r.solution));
    });
  } else if (department === 'แผนกตกแต่ง/ทากาว/บรรจุภัณฑ์') {
    (ex.items || []).forEach(function(it, i) {
      lines.push((i + 1) + ') ขนาดพรม/Spec: ' + safe(it.specMatch) + ' | บรรจุภัณฑ์ & ความสะอาด: ' + safe(it.packagingInfo));
    });
  }

  if (lines.length === 0) lines.push('ไม่มีข้อมูลรายละเอียดเพิ่มเติม');
  return lines.join('\n');
}

// ONE-TIME data fix (2026-09-09): rebuilds "Details" for every EXISTING QC row from that row's own
// Department + MO/SO + ExtraData columns — the same 3 inputs buildQcDetailsTextFromExtraData_() (and
// its client-side twin) always use, so this is a pure recompute, not a guess. That makes it safe to
// run more than once: re-running on a row whose "Details" is ALREADY readable text just recomputes
// the identical text, so there is no risk of double-converting or corrupting already-fixed rows. A
// row whose "ExtraData" isn't valid JSON (extremely old/malformed data) is left untouched rather than
// guessed at, and counted separately in the result so it can be checked by hand.
function cleanupQcDetailsColumn(sheet) {
  sheet = sheet || (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME) || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]);
  var headers = ensureQcHeaders(sheet);
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var deptIdx = qcColIndex(lowerHeaders, 'department', 'แผนก');
  var mosoIdx = qcColIndex(lowerHeaders, 'mo/so') !== -1 ? qcColIndex(lowerHeaders, 'mo/so') : qcColIndex(lowerHeaders, 'mo/s/o');
  var detailsIdx = qcColIndex(lowerHeaders, 'details');
  var extraIdx = qcColIndex(lowerHeaders, 'extradata', 'ข้อมูลเพิ่มเติม');

  if (detailsIdx === -1 || extraIdx === -1) {
    return { fixed: 0, error: 'ไม่พบคอลัมน์ Details หรือ ExtraData ในชีตนี้' };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { fixed: 0, skippedInvalidJson: 0, skippedBlank: 0 };

  var numRows = lastRow - 1;
  var deptVals = deptIdx !== -1 ? sheet.getRange(2, deptIdx + 1, numRows, 1).getValues() : null;
  var mosoVals = mosoIdx !== -1 ? sheet.getRange(2, mosoIdx + 1, numRows, 1).getValues() : null;
  var extraRange = sheet.getRange(2, extraIdx + 1, numRows, 1);
  var detailsRange = sheet.getRange(2, detailsIdx + 1, numRows, 1);
  var extraVals = extraRange.getValues();
  var detailsVals = detailsRange.getValues();

  var fixedCount = 0;
  var invalidJsonCount = 0;
  var blankCount = 0;
  for (var i = 0; i < numRows; i++) {
    var dept = deptVals ? String(deptVals[i][0] || '') : '';
    var moSo = mosoVals ? String(mosoVals[i][0] || '') : '';
    var rawExtra = extraVals[i][0];

    if (!dept && !rawExtra) { blankCount++; continue; } // fully blank row — nothing to rebuild

    var extraObj = {};
    try {
      extraObj = rawExtra ? (typeof rawExtra === 'string' ? JSON.parse(rawExtra) : rawExtra) : {};
    } catch (parseErr) {
      invalidJsonCount++;
      continue; // leave this row's Details cell as-is — its ExtraData isn't valid JSON to rebuild from
    }

    detailsVals[i][0] = buildQcDetailsTextFromExtraData_(dept, moSo, extraObj);
    fixedCount++;
  }

  detailsRange.setValues(detailsVals);
  Logger.log('cleanupQcDetailsColumn: rebuilt ' + fixedCount + ' row(s), skipped ' + invalidJsonCount + ' with unparsable ExtraData, ' + blankCount + ' blank row(s).');
  return { fixed: fixedCount, skippedInvalidJson: invalidJsonCount, skippedBlank: blankCount };
}

function getJsonDataResponse(sheet) {
  var rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) {
    return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
  }

  var headers = rows[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idIdx = headers.indexOf('id');
  var dateIdx = headers.indexOf('date') !== -1 ? headers.indexOf('date') : headers.indexOf('วันที่');
  var deptIdx = headers.indexOf('department') !== -1 ? headers.indexOf('department') : headers.indexOf('แผนก');
  var mosoIdx = headers.indexOf('mo/so') !== -1 ? headers.indexOf('mo/so') : (headers.indexOf('mo/s/o') !== -1 ? headers.indexOf('mo/s/o') : 3);
  var statusIdx = headers.indexOf('status') !== -1 ? headers.indexOf('status') : headers.indexOf('สถานะ');
  var inspIdx = headers.indexOf('inspector') !== -1 ? headers.indexOf('inspector') : headers.indexOf('ผู้ตรวจสอบ');
  var stampIdx = headers.indexOf('stamp pass') !== -1 ? headers.indexOf('stamp pass') : headers.indexOf('stamp');
  // FIX (2026-09): this sheet never had a "Remark" column, so a typed remark was silently dropped
  // on the next sync — see ensureQcHeaders() above, which now guarantees this column exists.
  var remarkIdx = headers.indexOf('remark') !== -1 ? headers.indexOf('remark') : headers.indexOf('หมายเหตุ');
  var extraIdx = headers.indexOf('extradata') !== -1 ? headers.indexOf('extradata') : headers.indexOf('ข้อมูลเพิ่มเติม');

  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var id = idIdx !== -1 ? row[idIdx] : row[0];
    if (!id) continue;

    var date = dateIdx !== -1 ? row[dateIdx] : row[1];
    var department = deptIdx !== -1 ? row[deptIdx] : row[2];
    var moSo = mosoIdx !== -1 ? row[mosoIdx] : row[3];
    var status = statusIdx !== -1 ? row[statusIdx] : row[5];
    var inspector = inspIdx !== -1 ? row[inspIdx] : row[6];
    var stamp = stampIdx !== -1 ? row[stampIdx] : row[7];
    var remark = remarkIdx !== -1 ? row[remarkIdx] : '';
    var extraData = extraIdx !== -1 ? row[extraIdx] : row[8];

    // ป้องกันกรณี status ติดค่า JSON string ให้บังคับเป็น PASS
    if (typeof status === 'string' && status.trim().startsWith('{')) {
      status = 'PASS';
    }

    data.push({
      id: String(id),
      date: date ? String(date).split('T')[0] : '',
      department: String(department || ''),
      moSo: String(moSo || ''),
      status: String(status || 'PASS'),
      inspector: String(inspector || ''),
      stamp: String(stamp || '-'),
      remark: String(remark || ''),
      extraData: extraData || '{}'
    });
  }

  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function deleteRowById(sheet, id) {
  var rows = sheet.getDataRange().getValues();
  var headers = rows[0].map(function(h) { return String(h).trim().toLowerCase(); });
  var idIdx = headers.indexOf('id') !== -1 ? headers.indexOf('id') : 0;

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idIdx]) === String(id)) {
      sheet.deleteRow(i + 1);
      return ContentService.createTextOutput(JSON.stringify({ result: "success", deletedId: id })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ result: "not_found" })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// NEW: Production Pipeline (ภาพรวมการผลิต / แผนผังการผลิต) — 4 separate sheet tabs (one per
// OrderType x Market combination — see ORDERS_SHEET_NAMES above), completely independent of the QC
// sheet above. Auto-created on first use.
// ============================================================================

var ORDERS_BASE_HEADER = ["MoSo", "DueDate", "CurrentStage", "Planning", "Dyeing", "Weaving", "Finishing", "LastUpdated", "CustomerName", "CustomerPO", "TotalSqm", "TotalPieces", "ReadyToShip", "Shipped", "ShippedDate", "DesignImageUrl", "OrderType", "SizeItems"];

// Which of the 4 physical sheets a given order belongs on. New orders always have both orderType and
// market set (the "เพิ่ม M/O, S/O ใหม่" form on the dashboard requires a market before it will submit),
// so the fallbacks here only matter for legacy rows that predate the market field — those default to
// "domestic" during the one-time migration (see ensureOrdersMigratedOnce_ below) and can be
// re-tagged afterward from the order detail modal like any other order.
function resolveOrdersSheetKey_(orderType, market) {
  var type = (orderType === 'SO') ? 'SO' : 'MO';
  var mkt = (market === 'export') ? 'export' : 'domestic';
  return type + '_' + mkt;
}

function getOrCreateOrdersSheetByKey_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = ORDERS_SHEET_NAMES[key];
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // Every new field (CustomerName/CustomerPO, then TotalSqm/TotalPieces/ReadyToShip/Shipped/
    // ShippedDate, then DesignImageUrl) is appended at the END of the header row on purpose — if
    // this sheet already existed before, its existing rows keep working unchanged; only a brand-new
    // sheet gets the full header automatically.
    sheet.appendRow(ORDERS_BASE_HEADER.slice());
  }
  ensureOrdersHeaders(sheet);
  return sheet;
}

// Returns [{key, sheet}, ...] for all 4 order sheets, creating any that don't exist yet.
function getAllOrderSheetInfos_() {
  return Object.keys(ORDERS_SHEET_NAMES).map(function(key) {
    return { key: key, sheet: getOrCreateOrdersSheetByKey_(key) };
  });
}

// ONE-TIME MIGRATION (2026-09-09): moves every row out of the old single "ProductionOrders" sheet
// into the correct one of the 4 new sheets above, based on each row's OrderType/Market columns (or
// "MO"/"domestic" as the fallback for a row saved before those columns existed). Guarded by a script
// property so it runs at most once no matter how many times doGet/doPost fire; wrapped in the script
// lock so two near-simultaneous requests right after this update is deployed can't both migrate at
// once and duplicate rows. The old sheet is never deleted — only renamed and hidden as a backup — so
// nothing is destroyed if anything here needs to be double-checked by hand afterward.
function ensureOrdersMigratedOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ordersMigratedV2') === 'done') return;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props.getProperty('ordersMigratedV2') === 'done') return; // another request finished it while we waited

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var legacySheet = ss.getSheetByName(LEGACY_ORDERS_SHEET_NAME);
    var migratedCount = 0;
    if (legacySheet) {
      var headerNames = ensureOrdersHeaders(legacySheet).map(function(h) { return h.toLowerCase(); });
      var rows = legacySheet.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row[0]) continue; // skip blank rows
        var order = extractOrderFromRow_(row, headerNames);
        upsertOrderIntoSheets_(order);
        migratedCount++;
      }
      var backupName = "ProductionOrders (ก่อนแยกแท็บ - สำรอง)";
      if (ss.getSheetByName(backupName)) backupName = backupName + ' ' + new Date().getTime();
      legacySheet.setName(backupName);
      legacySheet.hideSheet();
    }
    props.setProperty('ordersMigratedV2', 'done');
    Logger.log('ensureOrdersMigratedOnce_: migrated ' + migratedCount + ' order(s) from "' + LEGACY_ORDERS_SHEET_NAME + '" into the 4 M/O-S/O x market sheets.');
  } finally {
    lock.releaseLock();
  }
}

// Searches all 4 order sheets for a row whose MoSo (column A) matches — used by delete/design-image
// paths that only have the moSo string on hand, not which of the 4 sheets it lives on.
function findOrderRowAcrossSheets_(moSo) {
  var key = normalizeOrderKey_(moSo);
  var infos = getAllOrderSheetInfos_();
  for (var s = 0; s < infos.length; s++) {
    var rows = infos[s].sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (normalizeOrderKey_(rows[i][0]) === key) {
        return { sheet: infos[s].sheet, rowIndex: i + 1, key: infos[s].key };
      }
    }
  }
  return null;
}

function normalizeOrderKey_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

var ORDERS_NEW_HEADERS = ["CreatedAt", "IsInserted", "ShippingMark",
  // NEW (2026-09b): Excel-worksheet-style fields captured when the M/O, S/O is opened (see the
  // "เพิ่ม M/O, S/O ใหม่" form in QCDashboard.html) — modeled on the user's uploaded workbook,
  // deliberately excluding all price/amount/billing columns (Unit Price, Amount, Grand Total,
  // PI NO., INV. NO., payment terms) per the user's request. Same header-name pattern as the three
  // above: ensureOrdersHeaders() appends whichever are missing, wherever this sheet's columns
  // happened to end, so older sheets keep working unchanged.
  "OpenDate", "LocationName", "Quality", "Packaging", "ColorsCount", "CarpetSizeNote",
  "Incoterms", "PostponeDispatchDate", "DesignRef", "RefNote", "OrderRemark",
  // NEW (2026-09c): market (ตลาด — "export"/"domestic") and the salesperson's name, so M/O, S/O can
  // be split into ต่างประเทศ/ในประเทศ views on the dashboard (see marketFilter/matchesMarketFilter in
  // QCDashboard.html) and each order shows who's the responsible sale.
  "Market", "SalesName",
  // NEW (2026-09d): per-department target/plan finish dates ("กำหนดงานเสร็จของแต่ละแผนก"), set once by
  // Planning (see the newOrderModal / order detail modal's "กำหนดวันเสร็จแต่ละแผนก" fields) and used by
  // QCDashboard.html's getDeadlineWarning() to warn the specific department that's behind schedule.
  "PlanDateDyeing", "PlanDateWeaving", "PlanDateFinishing",
  // NEW (2026-09-09): same pattern, for the 2 departments that didn't have a target date yet
  // (ดีไซน์/ขยายลาย, แผนกวางแผน) — added so the Production Timeline can show a colored segment for
  // every QC department, not just dyeing/weaving/finishing.
  "PlanDateDesign", "PlanDatePlanning",
  // NEW (2026-09-10): full history of every time the whole-order delivery due date ("กำหนดส่ง") was
  // postponed — a manager asked to see "เลื่อนครั้งที่ N" with a red highlight wherever the due date is
  // shown (ภาพรวมการผลิต + ไทม์ไลน์การผลิต). Stored as a JSON array (same pattern as SizeItems above):
  // [{from, to, changedAt}, ...], one entry per postponement, built client-side in updateOrderField().
  "DueDateHistory",
  // NEW (2026-09-11): "กำหนดงานที่รับผิดชอบแต่ละแผนก" — Planning now enters how many DAYS each department
  // needs (design/dyeing/weaving/finishing) instead of picking an exact calendar date; the client
  // (recomputePlanDatesFromDurations() in QCDashboard.html) chains these from OpenDate into the
  // PlanDate* columns above, which stay the source the Timeline/warnings actually read. Stored as a
  // JSON object, same pattern as DueDateHistory/SizeItems.
  "PlanDurations",
  // NEW (2026-09-16): "แผนกดีไซน์/ขยายลาย" checklist (done/doneBy/note) — see
  // renderDesignSectionHtml()/normalizeOrder() in QCDashboard.html. Stored as a small JSON object,
  // same pattern as PlanDurations above. Deliberately separate from PlanDateDesign (the computed
  // target-finish date) above — that one is set by Planning, this one is filled in by whoever
  // actually works the design/ขยายลาย task.
  "Design",
  // NEW (2026-09-10): Carpet Production Planning calc engine (เอกสารอ้างอิง TH098/26-แก้แบบ) — the
  // per-M/O design inputs (total_area, pattern%, colors, stitching density, ...) that drive the
  // auto-grade/hours/production-days suggestions for แผนกทอ/ดีไซน์/แผนกตกแต่ง (see
  // computeTuftingGrade()/computeDesignGrade()/computeFinishingGrade() in QCDashboard.html). Stored
  // as a JSON object, same pass-through pattern as PlanDurations/Design above.
  "ProductionCalc",
  // NEW (2026-09-10): whether "แผนกวางแผน ต้องเสร็จวันที่" is currently following the auto-computed
  // final department finish date (true/blank = auto, "false" = the user picked a date directly via
  // the calendar and it should stop auto-following — see recomputePlanDatesFromDurations() in
  // QCDashboard.html). Stored as a plain TRUE/FALSE cell, not JSON, since it's a single boolean.
  "PlanningDeadlineAuto",
  // NEW (2026-09-12): วันที่ส่งแบบที่ลูกค้าให้ไปแผนกดีไซน์ / วันที่ได้รับแบบกลับจากแผนกดีไซน์ — plain date
  // cells, editable from both the "ข้อมูลเพิ่มเติม" block and the แผนกดีไซน์ section in
  // QCDashboard.html (same order fields, see normalizeOrder()/renderDesignSectionHtml() there).
  "DesignSentDate", "DesignReceivedDate",
  // NEW (2026-09-12): "ข้อกำหนดสำหรับฝ่ายผลิต" — captured on the "เพิ่ม M/O, S/O ใหม่" form (these
  // inputs existed on the form already but were never read/saved before this update — see
  // submitNewOrder()/normalizeOrder() in QCDashboard.html). Printed on the new ใบสั่งเปิดงานผลิต sheet
  // (buildProductionWorkOrderPrintHTML()) alongside the M/O's design image.
  "YarnType", "TuftingSpec", "Surface", "Texture", "ColorPlacement", "YarnPlan",
  "Latexing", "TuftBind", "SproutingLabel", "ProductionInstruction",
  // NEW (2026-09-12): "SPECIFICATIONS" checklist (วิธีทอ/เส้นด้าย/ลักษณะขน/ลวดลาย/วัสดุรองหลัง/ขอบพรม/
  // เจ้าของแบบ) — see SPEC_FIELD_GROUPS/defaultSpecsState() in QCDashboard.html. Stored as a JSON object,
  // same pass-through pattern as ProductionCalc/Design above.
  "Specs"];
function ensureOrdersHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); }) : [];
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var appended = false;
  ORDERS_NEW_HEADERS.forEach(function(h) {
    if (lowerHeaders.indexOf(h.toLowerCase()) === -1) {
      headers.push(h);
      lowerHeaders.push(h.toLowerCase());
      appended = true;
    }
  });
  if (appended) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

// Builds the client-facing order object from one raw sheet row + that sheet's (lowercased) header
// name list. Pulled out of getOrdersJsonResponse() so the same row->object mapping can be reused by
// ensureOrdersMigratedOnce_() when it reads rows out of the old single "ProductionOrders" sheet.
function extractOrderFromRow_(row, headerNames) {
  var createdAtIdx = headerNames.indexOf('createdat');
  var isInsertedIdx = headerNames.indexOf('isinserted');
  var shippingMarkIdx = headerNames.indexOf('shippingmark');
  var openDateIdx = headerNames.indexOf('opendate');
  var locationNameIdx = headerNames.indexOf('locationname');
  var qualityIdx = headerNames.indexOf('quality');
  var packagingIdx = headerNames.indexOf('packaging');
  var colorsCountIdx = headerNames.indexOf('colorscount');
  var carpetSizeNoteIdx = headerNames.indexOf('carpetsizenote');
  var incotermsIdx = headerNames.indexOf('incoterms');
  var postponeDispatchDateIdx = headerNames.indexOf('postponedispatchdate');
  var designRefIdx = headerNames.indexOf('designref');
  var refNoteIdx = headerNames.indexOf('refnote');
  var orderRemarkIdx = headerNames.indexOf('orderremark');
  var marketIdx = headerNames.indexOf('market');
  var salesNameIdx = headerNames.indexOf('salesname');
  var planDateDyeingIdx = headerNames.indexOf('plandatedyeing');
  var planDateWeavingIdx = headerNames.indexOf('plandateweaving');
  var planDateFinishingIdx = headerNames.indexOf('plandatefinishing');
  // NEW (2026-09-09): ดีไซน์/ขยายลาย + แผนกวางแผน target dates — see ORDERS_NEW_HEADERS.
  var planDateDesignIdx = headerNames.indexOf('plandatedesign');
  var planDatePlanningIdx = headerNames.indexOf('plandateplanning');
  // NEW (2026-09-10): due-date postponement history — see ORDERS_NEW_HEADERS.
  var dueDateHistoryIdx = headerNames.indexOf('duedatehistory');
  // NEW (2026-09-11): per-department planned durations (days) — see ORDERS_NEW_HEADERS.
  var planDurationsIdx = headerNames.indexOf('plandurations');
  // NEW (2026-09-16): แผนกดีไซน์/ขยายลาย checklist — see ORDERS_NEW_HEADERS.
  var designIdx = headerNames.indexOf('design');
  // NEW (2026-09-10): production calc engine inputs + deadline auto-follow flag — see ORDERS_NEW_HEADERS.
  var productionCalcIdx = headerNames.indexOf('productioncalc');
  var planningDeadlineAutoIdx = headerNames.indexOf('planningdeadlineauto');
  // NEW (2026-09-12): วันที่ส่งแบบ/ได้รับแบบ (แผนกดีไซน์) + "ข้อกำหนดสำหรับฝ่ายผลิต" — see ORDERS_NEW_HEADERS.
  var designSentDateIdx = headerNames.indexOf('designsentdate');
  var designReceivedDateIdx = headerNames.indexOf('designreceiveddate');
  var yarnTypeIdx = headerNames.indexOf('yarntype');
  var tuftingSpecIdx = headerNames.indexOf('tuftingspec');
  var surfaceIdx = headerNames.indexOf('surface');
  var textureIdx = headerNames.indexOf('texture');
  var colorPlacementIdx = headerNames.indexOf('colorplacement');
  var yarnPlanIdx = headerNames.indexOf('yarnplan');
  var latexingIdx = headerNames.indexOf('latexing');
  var tuftBindIdx = headerNames.indexOf('tuftbind');
  var sproutingLabelIdx = headerNames.indexOf('sproutinglabel');
  var productionInstructionIdx = headerNames.indexOf('productioninstruction');
  // NEW (2026-09-12): "SPECIFICATIONS" checklist — see ORDERS_NEW_HEADERS.
  var specsIdx = headerNames.indexOf('specs');

  return {
    moSo: String(row[0] || ''),
    // Pass the raw value through as-is (no .split('T') truncation here) — the dashboard's own
    // date parser already handles ISO strings, "MM/DD/YYYY", and Google Sheets' full JS Date
    // toString() format safely, whichever this cell happens to contain.
    dueDate: row[1] ? String(row[1]) : '',
    currentStage: String(row[2] || 'planning'),
    planning: row[3] || '{}',
    dyeing: row[4] || '{}',
    weaving: row[5] || '{}',
    finishing: row[6] || '{}',
    lastUpdated: row[7] ? String(row[7]) : '',
    customerName: row[8] ? String(row[8]) : '',
    customerPO: row[9] ? String(row[9]) : '',
    totalSqm: row[10] ? Number(row[10]) : 0,       // NEW: จำนวนตารางเมตรรวมของ M/O
    totalPieces: row[11] ? Number(row[11]) : 0,    // NEW: จำนวนชิ้นรวมของ M/O
    readyToShip: row[12] === true || String(row[12]).toUpperCase() === 'TRUE',
    shipped: row[13] === true || String(row[13]).toUpperCase() === 'TRUE',
    shippedDate: row[14] ? String(row[14]) : '',
    designImageUrl: row[15] ? String(row[15]) : '',  // NEW: รูปดีไซน์ของ M/O (ลิงก์ Google Drive)
    orderType: (row[16] === 'SO' || row[16] === 'MO') ? String(row[16]) : '',  // NEW: M/O หรือ S/O (สีแยกกันบนหน้าเว็บ) — ว่างได้สำหรับข้อมูลเก่า เว็บจะเดาจากเลขที่ MoSo แทน
    sizeItems: row[17] ? String(row[17]) : '[]',  // NEW: รายการขนาด (กว้าง x ยาว x จำนวนชิ้น) เก็บเป็น JSON — เว็บฝั่ง client เป็นคนแปลง
    // NEW (2026-09): "New" badge / "แทรกงาน" flag / Mark & Nos label — see ensureOrdersHeaders().
    createdAt: createdAtIdx !== -1 && row[createdAtIdx] ? String(row[createdAtIdx]) : '',
    isInserted: isInsertedIdx !== -1 && (row[isInsertedIdx] === true || String(row[isInsertedIdx]).toUpperCase() === 'TRUE'),
    shippingMark: shippingMarkIdx !== -1 && row[shippingMarkIdx] ? String(row[shippingMarkIdx]) : '',
    // NEW (2026-09b): Excel-worksheet-style fields — see ORDERS_NEW_HEADERS.
    openDate: openDateIdx !== -1 && row[openDateIdx] ? String(row[openDateIdx]) : '',
    locationName: locationNameIdx !== -1 && row[locationNameIdx] ? String(row[locationNameIdx]) : '',
    quality: qualityIdx !== -1 && row[qualityIdx] ? String(row[qualityIdx]) : '',
    packaging: packagingIdx !== -1 && row[packagingIdx] ? String(row[packagingIdx]) : '',
    colorsCount: colorsCountIdx !== -1 && row[colorsCountIdx] ? Number(row[colorsCountIdx]) : 0,
    carpetSizeNote: carpetSizeNoteIdx !== -1 && row[carpetSizeNoteIdx] ? String(row[carpetSizeNoteIdx]) : '',
    incoterms: incotermsIdx !== -1 && row[incotermsIdx] ? String(row[incotermsIdx]) : '',
    postponeDispatchDate: postponeDispatchDateIdx !== -1 && row[postponeDispatchDateIdx] ? String(row[postponeDispatchDateIdx]) : '',
    designRef: designRefIdx !== -1 && row[designRefIdx] ? String(row[designRefIdx]) : '',
    refNote: refNoteIdx !== -1 && row[refNoteIdx] ? String(row[refNoteIdx]) : '',
    orderRemark: orderRemarkIdx !== -1 && row[orderRemarkIdx] ? String(row[orderRemarkIdx]) : '',
    // NEW (2026-09c): market/salesName — see ORDERS_NEW_HEADERS.
    market: marketIdx !== -1 && (row[marketIdx] === 'export' || row[marketIdx] === 'domestic') ? String(row[marketIdx]) : '',
    salesName: salesNameIdx !== -1 && row[salesNameIdx] ? String(row[salesNameIdx]) : '',
    // NEW (2026-09d/2026-09-09): per-department plan/target finish dates, returned as a nested object
    // matching the shape QCDashboard.html's normalizeOrder() reads (raw.planDates.design / .planning /
    // .dyeing / .weaving / .finishing).
    planDates: {
      design: planDateDesignIdx !== -1 && row[planDateDesignIdx] ? String(row[planDateDesignIdx]) : '',
      planning: planDatePlanningIdx !== -1 && row[planDatePlanningIdx] ? String(row[planDatePlanningIdx]) : '',
      dyeing: planDateDyeingIdx !== -1 && row[planDateDyeingIdx] ? String(row[planDateDyeingIdx]) : '',
      weaving: planDateWeavingIdx !== -1 && row[planDateWeavingIdx] ? String(row[planDateWeavingIdx]) : '',
      finishing: planDateFinishingIdx !== -1 && row[planDateFinishingIdx] ? String(row[planDateFinishingIdx]) : ''
    },
    // NEW (2026-09-10): passed through as the raw JSON string — QCDashboard.html's normalizeOrder()
    // already parses either a string or a real array (same pattern as sizeItems above).
    dueDateHistory: dueDateHistoryIdx !== -1 && row[dueDateHistoryIdx] ? String(row[dueDateHistoryIdx]) : '[]',
    // NEW (2026-09-11): passed through as the raw JSON string — normalizeOrder() parses either a
    // string or a real object (same pattern as dueDateHistory above).
    planDurations: planDurationsIdx !== -1 && row[planDurationsIdx] ? String(row[planDurationsIdx]) : '{}',
    // NEW (2026-09-16): same pass-through pattern, for the แผนกดีไซน์/ขยายลาย checklist.
    design: designIdx !== -1 && row[designIdx] ? String(row[designIdx]) : '{}',
    // NEW (2026-09-10): same pass-through pattern, for the production calc engine's per-M/O inputs.
    productionCalc: productionCalcIdx !== -1 && row[productionCalcIdx] ? String(row[productionCalcIdx]) : '{}',
    // NEW (2026-09-10): defaults to true (auto-follow) when the cell is blank — i.e. every order saved
    // before this feature existed keeps the same auto-follow behavior a brand-new order gets, rather
    // than silently starting "frozen" on whatever planDates.planning happened to already be set to.
    planningDeadlineAuto: planningDeadlineAutoIdx === -1 || row[planningDeadlineAutoIdx] === '' || row[planningDeadlineAutoIdx] === undefined
      ? true
      : (row[planningDeadlineAutoIdx] === true || String(row[planningDeadlineAutoIdx]).toUpperCase() === 'TRUE'),
    // NEW (2026-09-12): วันที่ส่งแบบ/ได้รับแบบ (แผนกดีไซน์) + "ข้อกำหนดสำหรับฝ่ายผลิต" — see ORDERS_NEW_HEADERS.
    designSentDate: designSentDateIdx !== -1 && row[designSentDateIdx] ? String(row[designSentDateIdx]) : '',
    designReceivedDate: designReceivedDateIdx !== -1 && row[designReceivedDateIdx] ? String(row[designReceivedDateIdx]) : '',
    yarnType: yarnTypeIdx !== -1 && row[yarnTypeIdx] ? String(row[yarnTypeIdx]) : '',
    tuftingSpec: tuftingSpecIdx !== -1 && row[tuftingSpecIdx] ? String(row[tuftingSpecIdx]) : '',
    surface: surfaceIdx !== -1 && row[surfaceIdx] ? String(row[surfaceIdx]) : '',
    texture: textureIdx !== -1 && row[textureIdx] ? String(row[textureIdx]) : '',
    colorPlacement: colorPlacementIdx !== -1 && row[colorPlacementIdx] ? String(row[colorPlacementIdx]) : '',
    yarnPlan: yarnPlanIdx !== -1 && row[yarnPlanIdx] ? String(row[yarnPlanIdx]) : '',
    latexing: latexingIdx !== -1 && row[latexingIdx] ? String(row[latexingIdx]) : '',
    tuftBind: tuftBindIdx !== -1 && row[tuftBindIdx] ? String(row[tuftBindIdx]) : '',
    sproutingLabel: sproutingLabelIdx !== -1 && row[sproutingLabelIdx] ? String(row[sproutingLabelIdx]) : '',
    productionInstruction: productionInstructionIdx !== -1 && row[productionInstructionIdx] ? String(row[productionInstructionIdx]) : '',
    // NEW (2026-09-12): passed through as the raw JSON string — QCDashboard.html's normalizeOrder()
    // already parses either a string or a real object (same pattern as productionCalc/design above).
    specs: specsIdx !== -1 && row[specsIdx] ? String(row[specsIdx]) : '{}'
  };
}

function getOrdersJsonResponse() {
  ensureOrdersMigratedOnce_();
  var byMoSo = {};
  var duplicateCount = 0;
  getAllOrderSheetInfos_().forEach(function(info) {
    // CreatedAt/IsInserted/ShippingMark (and every other appended field) are read by header name
    // (not a fixed column number) since ensureOrdersHeaders() appends them wherever this sheet's
    // existing columns happened to end — see extractOrderFromRow_().
    var headerNames = ensureOrdersHeaders(info.sheet).map(function(h) { return h.toLowerCase(); });
    var rows = info.sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue; // skip blank rows
      var order = extractOrderFromRow_(row, headerNames);
      var key = normalizeOrderKey_(order.moSo);
      if (!key) continue;
      var expectedSheetKey = resolveOrdersSheetKey_(order.orderType, order.market);
      var candidate = {
        order: order,
        matchesOwnSheet: expectedSheetKey === info.key,
        rowIndex: i + 1
      };
      var existing = byMoSo[key];
      if (!existing) {
        byMoSo[key] = candidate;
        continue;
      }
      duplicateCount++;
      // The current upsert path always writes the first matching row in the correct category sheet.
      // Prefer that authoritative row over stale copies in another sheet or later duplicate rows.
      if ((!existing.matchesOwnSheet && candidate.matchesOwnSheet) ||
          (existing.matchesOwnSheet === candidate.matchesOwnSheet && candidate.rowIndex < existing.rowIndex)) {
        byMoSo[key] = candidate;
      }
    }
  });
  var data = Object.keys(byMoSo).map(function(key) { return byMoSo[key].order; });
  if (duplicateCount > 0) Logger.log('getOrdersJsonResponse: suppressed ' + duplicateCount + ' duplicate order row(s).');
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function deleteOrderRowByMoSo(moSo) {
  ensureOrdersMigratedOnce_();
  var key = normalizeOrderKey_(moSo);
  var deletedCount = 0;
  getAllOrderSheetInfos_().forEach(function(info) {
    var rows = info.sheet.getDataRange().getValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (normalizeOrderKey_(rows[i][0]) === key) {
        info.sheet.deleteRow(i + 1);
        deletedCount++;
      }
    }
  });
  if (deletedCount === 0) {
    return ContentService.createTextOutput(JSON.stringify({ result: "not_found" })).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ result: "success", deletedMoSo: moSo, deletedRows: deletedCount })).setMimeType(ContentService.MimeType.JSON);
}

// FIX (2026-09b): wrapped in the same script-lock pattern as the QC upsert in doPost() — see the
// comment there for the full race-condition explanation. Here it matters most when two different
// M/O, S/O are BOTH being created for the first time at nearly the same moment (two staff adding new
// orders within the same second): both would otherwise read the same "last row" before either had
// appended, and could clash. Updates to an *existing* M/O, S/O were already safer (keyed by MoSo, one
// setValues() call for the whole row) but are included here too for consistency and defense in depth.
function upsertOrder(order) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureOrdersMigratedOnce_();
    upsertOrderIntoSheets_(order);
  } finally {
    lock.releaseLock();
  }
}

// The actual write logic, split out from upsertOrder() so ensureOrdersMigratedOnce_() can reuse it
// while migrating legacy rows (that function holds its OWN lock around the whole migration loop, so
// this inner function deliberately does NOT lock itself — nesting LockService locks within a single
// script execution is unnecessary here and this keeps the call graph simple).
function upsertOrderIntoSheets_(order) {
  var moSoKey = normalizeOrderKey_(order.moSo);
  var targetKey = resolveOrdersSheetKey_(order.orderType, order.market);
  var infos = getAllOrderSheetInfos_();

  // NEW (2026-09-09): ประเภท (M/O, S/O) and ตลาด (ต่างประเทศ, ในประเทศ) can both be edited after
  // creation from the order detail modal — if either changed, this MoSo now belongs on a different
  // one of the 4 sheets than where it was last saved. Remove any stale copy from the OTHER 3 sheets
  // first so it's never duplicated across two of them.
  infos.forEach(function(info) {
    if (info.key === targetKey) return;
    var otherRows = info.sheet.getDataRange().getValues();
    for (var r = otherRows.length - 1; r >= 1; r--) {
      if (normalizeOrderKey_(otherRows[r][0]) === moSoKey) {
        info.sheet.deleteRow(r + 1);
      }
    }
  });

  var sheet = infos.filter(function(info) { return info.key === targetKey; })[0].sheet;
  var headerNames = ensureOrdersHeaders(sheet).map(function(h) { return h.toLowerCase(); });
  var rows = sheet.getDataRange().getValues();
  var matchingRowIndexes = [];
  for (var i = 1; i < rows.length; i++) {
    if (normalizeOrderKey_(rows[i][0]) === moSoKey) {
      matchingRowIndexes.push(i + 1);
    }
  }
  var existingRowIndex = matchingRowIndexes.length ? matchingRowIndexes[0] : -1;
  // Keep the first row as the canonical row and remove every later duplicate before saving.
  for (var d = matchingRowIndexes.length - 1; d >= 1; d--) {
    sheet.deleteRow(matchingRowIndexes[d]);
  }

  var rowValues = [
      order.moSo || '',
      order.dueDate || '',
      order.currentStage || 'planning',
      typeof order.planning === 'object' ? JSON.stringify(order.planning) : (order.planning || '{}'),
      typeof order.dyeing === 'object' ? JSON.stringify(order.dyeing) : (order.dyeing || '{}'),
      typeof order.weaving === 'object' ? JSON.stringify(order.weaving) : (order.weaving || '{}'),
      typeof order.finishing === 'object' ? JSON.stringify(order.finishing) : (order.finishing || '{}'),
      order.lastUpdated || '',
      order.customerName || '',
      order.customerPO || '',
      order.totalSqm || 0,
      order.totalPieces || 0,
      order.readyToShip ? true : false,
      order.shipped ? true : false,
      order.shippedDate || '',
      order.designImageUrl || '',          // NEW
      (order.orderType === 'SO' || order.orderType === 'MO') ? order.orderType : '',  // NEW
      typeof order.sizeItems === 'object' ? JSON.stringify(order.sizeItems || []) : (order.sizeItems || '[]')  // NEW
    ];

    var targetRow;
    if (existingRowIndex !== -1) {
      sheet.getRange(existingRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
      targetRow = existingRowIndex;
    } else {
      sheet.appendRow(rowValues);
      targetRow = sheet.getLastRow();
    }

    // NEW (2026-09): CreatedAt/IsInserted/ShippingMark are written by header name, not appended onto
    // rowValues above — ensureOrdersHeaders() may have placed them at a different column than
    // rowValues.length+1 if this sheet already had extra columns before this update shipped.
    var createdAtIdx = headerNames.indexOf('createdat');
    var isInsertedIdx = headerNames.indexOf('isinserted');
    var shippingMarkIdx = headerNames.indexOf('shippingmark');
    if (createdAtIdx !== -1) sheet.getRange(targetRow, createdAtIdx + 1).setValue(order.createdAt || '');
    if (isInsertedIdx !== -1) sheet.getRange(targetRow, isInsertedIdx + 1).setValue(order.isInserted ? true : false);
    if (shippingMarkIdx !== -1) sheet.getRange(targetRow, shippingMarkIdx + 1).setValue(order.shippingMark || '');

    // NEW (2026-09b): Excel-worksheet-style fields, written by header name for the same reason as
    // CreatedAt/IsInserted/ShippingMark above — see ORDERS_NEW_HEADERS.
    var openDateIdx = headerNames.indexOf('opendate');
    var locationNameIdx = headerNames.indexOf('locationname');
    var qualityIdx = headerNames.indexOf('quality');
    var packagingIdx = headerNames.indexOf('packaging');
    var colorsCountIdx = headerNames.indexOf('colorscount');
    var carpetSizeNoteIdx = headerNames.indexOf('carpetsizenote');
    var incotermsIdx = headerNames.indexOf('incoterms');
    var postponeDispatchDateIdx = headerNames.indexOf('postponedispatchdate');
    var designRefIdx = headerNames.indexOf('designref');
    var refNoteIdx = headerNames.indexOf('refnote');
    var orderRemarkIdx = headerNames.indexOf('orderremark');
    if (openDateIdx !== -1) sheet.getRange(targetRow, openDateIdx + 1).setValue(order.openDate || '');
    if (locationNameIdx !== -1) sheet.getRange(targetRow, locationNameIdx + 1).setValue(order.locationName || '');
    if (qualityIdx !== -1) sheet.getRange(targetRow, qualityIdx + 1).setValue(order.quality || '');
    if (packagingIdx !== -1) sheet.getRange(targetRow, packagingIdx + 1).setValue(order.packaging || '');
    if (colorsCountIdx !== -1) sheet.getRange(targetRow, colorsCountIdx + 1).setValue(order.colorsCount || 0);
    if (carpetSizeNoteIdx !== -1) sheet.getRange(targetRow, carpetSizeNoteIdx + 1).setValue(order.carpetSizeNote || '');
    if (incotermsIdx !== -1) sheet.getRange(targetRow, incotermsIdx + 1).setValue(order.incoterms || '');
    if (postponeDispatchDateIdx !== -1) sheet.getRange(targetRow, postponeDispatchDateIdx + 1).setValue(order.postponeDispatchDate || '');
    if (designRefIdx !== -1) sheet.getRange(targetRow, designRefIdx + 1).setValue(order.designRef || '');
    if (refNoteIdx !== -1) sheet.getRange(targetRow, refNoteIdx + 1).setValue(order.refNote || '');
    if (orderRemarkIdx !== -1) sheet.getRange(targetRow, orderRemarkIdx + 1).setValue(order.orderRemark || '');

    // NEW (2026-09c): market/salesName — see ORDERS_NEW_HEADERS.
    var marketIdx = headerNames.indexOf('market');
    var salesNameIdx = headerNames.indexOf('salesname');
    if (marketIdx !== -1) sheet.getRange(targetRow, marketIdx + 1).setValue((order.market === 'export' || order.market === 'domestic') ? order.market : '');
    if (salesNameIdx !== -1) sheet.getRange(targetRow, salesNameIdx + 1).setValue(order.salesName || '');

    // NEW (2026-09d/2026-09-09): per-department plan/target finish dates — see ORDERS_NEW_HEADERS.
    // order.planDates is a nested object client-side ({design, planning, dyeing, weaving, finishing});
    // guard against it being missing entirely (an order object built before this feature existed)
    // rather than assuming it's there.
    var planDates = order.planDates || {};
    var planDateDesignIdx = headerNames.indexOf('plandatedesign');
    var planDatePlanningIdx = headerNames.indexOf('plandateplanning');
    var planDateDyeingIdx = headerNames.indexOf('plandatedyeing');
    var planDateWeavingIdx = headerNames.indexOf('plandateweaving');
    var planDateFinishingIdx = headerNames.indexOf('plandatefinishing');
    if (planDateDesignIdx !== -1) sheet.getRange(targetRow, planDateDesignIdx + 1).setValue(planDates.design || '');
    if (planDatePlanningIdx !== -1) sheet.getRange(targetRow, planDatePlanningIdx + 1).setValue(planDates.planning || '');
    if (planDateDyeingIdx !== -1) sheet.getRange(targetRow, planDateDyeingIdx + 1).setValue(planDates.dyeing || '');
    if (planDateWeavingIdx !== -1) sheet.getRange(targetRow, planDateWeavingIdx + 1).setValue(planDates.weaving || '');
    if (planDateFinishingIdx !== -1) sheet.getRange(targetRow, planDateFinishingIdx + 1).setValue(planDates.finishing || '');

    // NEW (2026-09-10): due-date postponement history ("เลื่อนครั้งที่ N") — see ORDERS_NEW_HEADERS.
    // order.dueDateHistory is a client-side array; stored as its JSON string, same pattern as
    // planning/dyeing/weaving/finishing/sizeItems above.
    var dueDateHistoryIdx = headerNames.indexOf('duedatehistory');
    if (dueDateHistoryIdx !== -1) {
      sheet.getRange(targetRow, dueDateHistoryIdx + 1).setValue(
        typeof order.dueDateHistory === 'object' ? JSON.stringify(order.dueDateHistory || []) : (order.dueDateHistory || '[]')
      );
    }

    // NEW (2026-09-11): per-department planned durations (days) — see ORDERS_NEW_HEADERS.
    var planDurationsIdx = headerNames.indexOf('plandurations');
    if (planDurationsIdx !== -1) {
      sheet.getRange(targetRow, planDurationsIdx + 1).setValue(
        typeof order.planDurations === 'object' ? JSON.stringify(order.planDurations || {}) : (order.planDurations || '{}')
      );
    }

    // NEW (2026-09-16): แผนกดีไซน์/ขยายลาย checklist (done/doneBy/note) — see ORDERS_NEW_HEADERS.
    var designIdx = headerNames.indexOf('design');
    if (designIdx !== -1) {
      sheet.getRange(targetRow, designIdx + 1).setValue(
        typeof order.design === 'object' ? JSON.stringify(order.design || {}) : (order.design || '{}')
      );
    }

    // NEW (2026-09-10): production calc engine inputs + deadline auto-follow flag — see ORDERS_NEW_HEADERS.
    var productionCalcIdx = headerNames.indexOf('productioncalc');
    if (productionCalcIdx !== -1) {
      sheet.getRange(targetRow, productionCalcIdx + 1).setValue(
        typeof order.productionCalc === 'object' ? JSON.stringify(order.productionCalc || {}) : (order.productionCalc || '{}')
      );
    }
    var planningDeadlineAutoIdx = headerNames.indexOf('planningdeadlineauto');
    if (planningDeadlineAutoIdx !== -1) {
      sheet.getRange(targetRow, planningDeadlineAutoIdx + 1).setValue(order.planningDeadlineAuto === false ? false : true);
    }

    // NEW (2026-09-12): วันที่ส่งแบบ/ได้รับแบบ (แผนกดีไซน์) + "ข้อกำหนดสำหรับฝ่ายผลิต" — plain string/date
    // cells, written by header name for the same reason as everything else in this function (a sheet
    // may have these columns at a different position than a fresh one would) — see ORDERS_NEW_HEADERS.
    var designSentDateIdx = headerNames.indexOf('designsentdate');
    var designReceivedDateIdx = headerNames.indexOf('designreceiveddate');
    var yarnTypeIdx = headerNames.indexOf('yarntype');
    var tuftingSpecIdx = headerNames.indexOf('tuftingspec');
    var surfaceIdx = headerNames.indexOf('surface');
    var textureIdx = headerNames.indexOf('texture');
    var colorPlacementIdx = headerNames.indexOf('colorplacement');
    var yarnPlanIdx = headerNames.indexOf('yarnplan');
    var latexingIdx = headerNames.indexOf('latexing');
    var tuftBindIdx = headerNames.indexOf('tuftbind');
    var sproutingLabelIdx = headerNames.indexOf('sproutinglabel');
    var productionInstructionIdx = headerNames.indexOf('productioninstruction');
    if (designSentDateIdx !== -1) sheet.getRange(targetRow, designSentDateIdx + 1).setValue(order.designSentDate || '');
    if (designReceivedDateIdx !== -1) sheet.getRange(targetRow, designReceivedDateIdx + 1).setValue(order.designReceivedDate || '');
    if (yarnTypeIdx !== -1) sheet.getRange(targetRow, yarnTypeIdx + 1).setValue(order.yarnType || '');
    if (tuftingSpecIdx !== -1) sheet.getRange(targetRow, tuftingSpecIdx + 1).setValue(order.tuftingSpec || '');
    if (surfaceIdx !== -1) sheet.getRange(targetRow, surfaceIdx + 1).setValue(order.surface || '');
    if (textureIdx !== -1) sheet.getRange(targetRow, textureIdx + 1).setValue(order.texture || '');
    if (colorPlacementIdx !== -1) sheet.getRange(targetRow, colorPlacementIdx + 1).setValue(order.colorPlacement || '');
    if (yarnPlanIdx !== -1) sheet.getRange(targetRow, yarnPlanIdx + 1).setValue(order.yarnPlan || '');
    if (latexingIdx !== -1) sheet.getRange(targetRow, latexingIdx + 1).setValue(order.latexing || '');
    if (tuftBindIdx !== -1) sheet.getRange(targetRow, tuftBindIdx + 1).setValue(order.tuftBind || '');
    if (sproutingLabelIdx !== -1) sheet.getRange(targetRow, sproutingLabelIdx + 1).setValue(order.sproutingLabel || '');
    if (productionInstructionIdx !== -1) sheet.getRange(targetRow, productionInstructionIdx + 1).setValue(order.productionInstruction || '');

    // NEW (2026-09-12): "SPECIFICATIONS" checklist — stored as a JSON string, same pass-through
    // pattern as ProductionCalc/Design above (order.specs may already arrive as a string from a
    // client that just re-sends what it read, or as a real object from a freshly-built order).
    var specsIdx = headerNames.indexOf('specs');
    if (specsIdx !== -1) {
      sheet.getRange(targetRow, specsIdx + 1).setValue(
        typeof order.specs === 'object' ? JSON.stringify(order.specs || {}) : (order.specs || '{}')
      );
    }

    // NEW (2026-09-11): dual-write to Supabase alongside the Google Sheet above, while the system is
    // being migrated over — see the "Supabase dual-write" block below for syncOrderToSupabase_(). This
    // is a no-op (does nothing) until SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set in Script
    // Properties, so it's always safe to leave in place even before Supabase is set up.
    syncOrderToSupabase_(order);
}

// ============================================================================
// NEW (2026-09e): Issue reports ("แจ้งปัญหา") — e.g. "ไหมด่าง" (streaky/uneven dyed yarn) or any other
// quality/production problem staff need to flag against a specific M/O, S/O so (a) everyone finds out
// immediately via a LINE broadcast (reuses the existing sendLineBroadcast()/?type=lineNotify path —
// see notifyLineIssueReported() in QCDashboard.html, no new LINE code needed here) and (b) it stays
// visible on a dedicated "ปัญหาที่ต้องติดตาม" tab until someone marks it resolved, instead of living
// only in a chat message that scrolls away. Stored in its own sheet (brand new, so — unlike
// ProductionOrders — there's no pre-existing column layout to preserve; every column is defined here
// from the start) with the same self-healing header-by-name pattern used everywhere else in this file.
// ============================================================================

const ISSUES_SHEET_NAME = "Issues";
var ISSUES_HEADERS = ["ID", "MoSo", "IssueType", "Description", "Department", "Severity",
  "ReportedBy", "ReportedDate", "Status", "ResolvedBy", "ResolvedDate", "ResolutionNote",
  // NEW (2026-09-11): when closing an issue that involved hiring/outsourcing someone to fix it
  // (ถ้ามีรายการจ้าง) — where it was outsourced to, and who approved that decision.
  "Outsourced", "VendorLocation", "ApprovedBy",
  // NEW (2026-09-09): a single one-time quick reply typed from the "น้องไหม" mascot's problem-alert
  // popup — separate from ResolutionNote/ResolvedBy, since replying here does NOT resolve the issue.
  "MascotReply", "MascotRepliedBy", "MascotRepliedAt"];

function getOrCreateIssuesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ISSUES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ISSUES_SHEET_NAME);
    sheet.appendRow(ISSUES_HEADERS);
  }
  ensureIssuesHeaders(sheet);
  return sheet;
}

// Same "append whichever headers are missing, wherever the sheet's columns happen to end" pattern as
// ensureOrdersHeaders() — kept even though this sheet is brand-new (so today every column is already
// present) as a safety net against someone manually renaming/reordering columns in Google Sheets later.
function ensureIssuesHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); }) : [];
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var appended = false;
  ISSUES_HEADERS.forEach(function(h) {
    if (lowerHeaders.indexOf(h.toLowerCase()) === -1) {
      headers.push(h);
      lowerHeaders.push(h.toLowerCase());
      appended = true;
    }
  });
  if (appended) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

function getIssuesJsonResponse() {
  var sheet = getOrCreateIssuesSheet();
  var headerNames = ensureIssuesHeaders(sheet).map(function(h) { return h.toLowerCase(); });
  var idx = {};
  ISSUES_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

  var rows = sheet.getDataRange().getValues();
  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[idx.ID]) continue; // skip blank rows
    data.push({
      id: String(row[idx.ID] || ''),
      moSo: String(row[idx.MoSo] || ''),
      issueType: String(row[idx.IssueType] || ''),
      description: String(row[idx.Description] || ''),
      department: String(row[idx.Department] || ''),
      severity: String(row[idx.Severity] || ''),
      reportedBy: String(row[idx.ReportedBy] || ''),
      reportedDate: row[idx.ReportedDate] ? String(row[idx.ReportedDate]) : '',
      status: String(row[idx.Status] || 'open'),
      resolvedBy: String(row[idx.ResolvedBy] || ''),
      resolvedDate: row[idx.ResolvedDate] ? String(row[idx.ResolvedDate]) : '',
      resolutionNote: String(row[idx.ResolutionNote] || ''),
      // NEW (2026-09-11): outsourcing details captured when the issue was closed — see ISSUES_HEADERS.
      outsourced: idx.Outsourced !== -1 && (row[idx.Outsourced] === true || String(row[idx.Outsourced]).toUpperCase() === 'TRUE'),
      vendorLocation: idx.VendorLocation !== -1 ? String(row[idx.VendorLocation] || '') : '',
      approvedBy: idx.ApprovedBy !== -1 ? String(row[idx.ApprovedBy] || '') : '',
      // NEW (2026-09-09): น้องไหม mascot quick-reply — see ISSUES_HEADERS.
      mascotReply: idx.MascotReply !== -1 ? String(row[idx.MascotReply] || '') : '',
      mascotRepliedBy: idx.MascotRepliedBy !== -1 ? String(row[idx.MascotRepliedBy] || '') : '',
      mascotRepliedAt: idx.MascotRepliedAt !== -1 ? String(row[idx.MascotRepliedAt] || '') : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// Wrapped in the same script-lock pattern as upsertOrder()/the QC upsert in doPost() — two staff
// reporting or resolving issues within the same second or two should never be able to clash on the
// same target row.
function upsertIssue(issue) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateIssuesSheet();
    var headerNames = ensureIssuesHeaders(sheet).map(function(h) { return h.toLowerCase(); });
    var idx = {};
    ISSUES_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

    var rows = sheet.getDataRange().getValues();
    var existingRowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][idx.ID]).trim() === String(issue.id).trim()) {
        existingRowIndex = i + 1;
        break;
      }
    }

    var rowValues = [];
    rowValues[idx.ID] = issue.id || '';
    rowValues[idx.MoSo] = issue.moSo || '';
    rowValues[idx.IssueType] = issue.issueType || '';
    rowValues[idx.Description] = issue.description || '';
    rowValues[idx.Department] = issue.department || '';
    rowValues[idx.Severity] = issue.severity || '';
    rowValues[idx.ReportedBy] = issue.reportedBy || '';
    rowValues[idx.ReportedDate] = issue.reportedDate || '';
    rowValues[idx.Status] = issue.status || 'open';
    rowValues[idx.ResolvedBy] = issue.resolvedBy || '';
    rowValues[idx.ResolvedDate] = issue.resolvedDate || '';
    rowValues[idx.ResolutionNote] = issue.resolutionNote || '';
    // NEW (2026-09-11): outsourcing details — see ISSUES_HEADERS.
    rowValues[idx.Outsourced] = !!issue.outsourced;
    rowValues[idx.VendorLocation] = issue.vendorLocation || '';
    rowValues[idx.ApprovedBy] = issue.approvedBy || '';
    // NEW (2026-09-09): น้องไหม mascot quick-reply — see ISSUES_HEADERS.
    rowValues[idx.MascotReply] = issue.mascotReply || '';
    rowValues[idx.MascotRepliedBy] = issue.mascotRepliedBy || '';
    rowValues[idx.MascotRepliedAt] = issue.mascotRepliedAt || '';
    // Fill any gap (a header this sheet doesn't have, so its idx is -1) with '' rather than leaving
    // an actual JS "empty slot" — appendRow/setValues both handle a plain '' safely either way.
    for (var c = 0; c < rowValues.length; c++) { if (rowValues[c] === undefined) rowValues[c] = ''; }

    if (existingRowIndex !== -1) {
      sheet.getRange(existingRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  } finally {
    lock.releaseLock();
  }
}

function deleteIssueById(id) {
  var sheet = getOrCreateIssuesSheet();
  var rows = sheet.getDataRange().getValues();
  var key = String(id || '').trim();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.deleteRow(i + 1);
      return ContentService.createTextOutput(JSON.stringify({ result: "success", deletedId: id })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ result: "not_found" })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// NEW: Design images ("รูปดีไซน์") — uploaded to a Drive folder so every department, on any
// device, sees the same picture (a Google Sheet cell can't reliably hold a full image). Only the
// resulting Drive link is ever written back into the matching M/O, S/O order sheet.
// ============================================================================

var DESIGN_IMAGE_FOLDER_NAME = "QC_Dashboard_DesignImages";

function getOrCreateDesignImageFolder() {
  var folders = DriveApp.getFoldersByName(DESIGN_IMAGE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DESIGN_IMAGE_FOLDER_NAME);
}

// DIAGNOSTIC / ONE-TIME AUTHORIZATION (2026-09): run this manually from the Apps Script editor —
// select "authorizeDriveAccess" in the function dropdown, click Run — whenever design-image uploads
// report "ไม่สามารถอัปโหลดรูปได้" / never show up after syncing. Root cause seen in practice: DriveApp
// was added to this project's code AFTER it was first deployed/authorized, so the deployed web app
// was still running under the OLD authorization, which never covered Drive — every upload attempt
// therefore failed inside the web app with "You do not have permission to call
// DriveApp.getFoldersByName", even though the QC/orders sheet parts of the script worked fine.
// Running ANY function that touches DriveApp directly from the editor (this one) makes Google show a
// fresh consent screen listing Drive access — click Allow — and that grant then covers the deployed
// web app too (no redeploy needed; the grant is per script project + your account, not per
// deployment). Check the Execution log after running: it will show the folder's name and URL on
// success, or the exact permission error again if something is still wrong.
function authorizeDriveAccess() {
  var folder = getOrCreateDesignImageFolder();
  Logger.log('Drive access OK. Design-image folder: "' + folder.getName() + '" — ' + folder.getUrl());
}

// data: { moSo, target: 'order'|'dyeing'|'weaving'|'finishing', itemIndex (only for department
// targets), imageBase64 (a data: URL), fileName }. Uploads the image to Drive, makes it viewable
// via link, and writes the resulting URL directly into the matching order row/column (whichever of
// the 4 M/O, S/O sheets it's on) —
// this way the picture shows up on the next sync even if the client never manages to read this
// call's own response (fetch()+Apps Script CORS on POST can be flaky for some browsers/deployments).
function uploadDesignImageAndSave(data) {
  var moSo = String((data && data.moSo) || '').trim();
  if (!moSo) return { result: 'error', message: 'missing moSo' };

  var raw = String((data && data.imageBase64) || '');
  var commaIdx = raw.indexOf(',');
  var meta = commaIdx !== -1 ? raw.substring(0, commaIdx) : '';
  var base64Data = commaIdx !== -1 ? raw.substring(commaIdx + 1) : raw;
  var mimeMatch = meta.match(/data:([^;]+);base64/);
  var mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, mimeType, (data && data.fileName) || (moSo + '_design.jpg'));

  var folder = getOrCreateDesignImageFolder();
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  var url = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w1600";

  // NEW (2026-09-09): the row could now be on any of the 4 M/O-S/O x market sheets (see
  // ORDERS_SHEET_NAMES), not one fixed "ProductionOrders" sheet — search all of them by MoSo.
  ensureOrdersMigratedOnce_();
  var found = findOrderRowAcrossSheets_(moSo);

  // FIX (2026-09c): this used to always return {result:"success"} even when the row below wasn't
  // found (or the item-array write was skipped) — meaning the file really did land on Drive, but the
  // sheet was silently never updated, and the dashboard was told "success" regardless. That made a
  // moSo-matching problem indistinguishable from a working upload: the client would just wait forever
  // for a link that had already been dropped. Now a genuine failure to locate/update the row is
  // reported back as an explicit error instead.
  if (!found) {
    return { result: 'error', message: 'ไม่พบแถวของ M/O, S/O "' + moSo + '" ในชีต M/O, S/O ทั้ง 4 แท็บ (รูปถูกอัปโหลดขึ้น Drive แล้ว แต่ยังไม่ได้บันทึกลิงก์ลงชีต)' };
  }
  var sheet = found.sheet;
  var rowIndex = found.rowIndex;

  var target = data && data.target;
  if (target === 'order') {
    sheet.getRange(rowIndex, 16).setValue(url); // column 16 = DesignImageUrl
  } else {
    var colByTarget = { dyeing: 5, weaving: 6, finishing: 7 };
    var col = colByTarget[target];
    if (col) {
      var cell = sheet.getRange(rowIndex, col);
      var obj = {};
      try { obj = JSON.parse(cell.getValue() || '{}'); } catch (e) { obj = {}; }
      if (!Array.isArray(obj.items)) obj.items = [];
      var idx = Number(data.itemIndex);
      if (!isNaN(idx) && obj.items[idx]) {
        obj.items[idx].designImageUrl = url;
        cell.setValue(JSON.stringify(obj));
      } else {
        return { result: 'error', message: 'ไม่พบรายการ item ที่ index ' + data.itemIndex + ' ใน ' + target + ' (รูปถูกอัปโหลดขึ้น Drive แล้ว แต่ยังไม่ได้บันทึกลิงก์ลงชีต)' };
      }
    }
  }
  sheet.getRange(rowIndex, 8).setValue(new Date().toISOString().split('T')[0]); // LastUpdated

  return { result: 'success', url: url, fileId: fileId };
}

// ============================================================================
// NEW (2026-09-10): Carpet Production Planning calculation engine — global "Production Settings"
// (เอกสารอ้างอิง TH098/26-แก้แบบ). Section 1.2 of that PRD: regular_hours_per_day + per-department
// staff_count/ot_hours_per_day, shared across every M/O rather than set per order (per the user's
// choice — "ตั้งค่ากลาง ใช้ร่วมกันทุก M/O"). Stored as ONE row in its own tiny sheet (same "single
// settings row, read/write by header name" shape as the Issues sheet above, just always exactly one
// data row) so every device pulling from this same Google Sheet sees the same staffing assumptions —
// QCDashboard.html reads/writes this via ?action=getProductionSettings / ?type=productionSettings.
// The per-order design inputs (total_area, pattern%, colors, ...) that actually DRIVE the grade/hours
// calculation live on each order instead — see ORDERS_NEW_HEADERS's "ProductionCalc" column below.
// ============================================================================

var PRODUCTION_SETTINGS_SHEET_NAME = "ProductionSettings";
var PRODUCTION_SETTINGS_HEADERS = ["RegularHoursPerDay",
  "TuftingStaffCount", "TuftingOtHours", "TuftingLoomCount",
  "DesignStaffCount", "DesignOtHours",
  "DyeingStaffCount", "DyeingKgPerDay", "DyeingSetupHoursPerColor",
  "FinishingStaffCount", "FinishingOtHours",
  "FinishingGlueStandardMultiplier", "FinishingGlueTypesJson"];

function getOrCreateProductionSettingsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PRODUCTION_SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PRODUCTION_SETTINGS_SHEET_NAME);
    sheet.appendRow(PRODUCTION_SETTINGS_HEADERS);
    // Seed sensible defaults (PRD: regular_hours_per_day default = 8, 1 staff/0 OT per department,
    // 1 loom) as the sheet's one and only data row, so a fresh dashboard load before anyone has
    // opened the settings modal still gets real numbers instead of blanks.
    sheet.appendRow([8, 1, 0, 1, 1, 0, 1, 12, 0.5, 1, 0, 2, "[]"]);
  }
  ensureProductionSettingsHeaders(sheet);
  return sheet;
}

// Same self-healing "append whichever headers are missing" pattern used everywhere else in this file.
function ensureProductionSettingsHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); }) : [];
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var appended = false;
  PRODUCTION_SETTINGS_HEADERS.forEach(function(h) {
    if (lowerHeaders.indexOf(h.toLowerCase()) === -1) {
      headers.push(h);
      lowerHeaders.push(h.toLowerCase());
      appended = true;
    }
  });
  if (appended) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

function getProductionSettingsJsonResponse() {
  var sheet = getOrCreateProductionSettingsSheet();
  var headerNames = ensureProductionSettingsHeaders(sheet).map(function(h) { return h.toLowerCase(); });
  var idx = {};
  PRODUCTION_SETTINGS_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

  var lastRow = sheet.getLastRow();
  var row = lastRow >= 2 ? sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  var num = function(i, fallback) {
    return (i !== -1 && row[i] !== undefined && row[i] !== '' && !isNaN(Number(row[i]))) ? Number(row[i]) : fallback;
  };

  var settings = {
    regularHoursPerDay: num(idx.RegularHoursPerDay, 8),
    tufting: { staffCount: num(idx.TuftingStaffCount, 1), otHours: num(idx.TuftingOtHours, 0), loomCount: num(idx.TuftingLoomCount, 1) },
    design: { staffCount: num(idx.DesignStaffCount, 1), otHours: num(idx.DesignOtHours, 0) },
    dyeing: {
      staffCount: num(idx.DyeingStaffCount, 1),
      kgPerDay: num(idx.DyeingKgPerDay, 12),
      setupHoursPerColor: num(idx.DyeingSetupHoursPerColor, 0.5)
    },
    finishing: {
      staffCount: num(idx.FinishingStaffCount, 1),
      otHours: num(idx.FinishingOtHours, 0),
      glueStandardMultiplier: num(idx.FinishingGlueStandardMultiplier, 2),
      glueTypes: safeJsonParse_(
        idx.FinishingGlueTypesJson !== -1 ? row[idx.FinishingGlueTypesJson] : "[]",
        []
      )
    }
  };
  return ContentService.createTextOutput(JSON.stringify(settings)).setMimeType(ContentService.MimeType.JSON);
}

// Always overwrites the single data row (row 2) — there is only ever one, shared, current set of
// settings, unlike Orders/Issues which key on a per-record id.
function upsertProductionSettings(settings) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateProductionSettingsSheet();
    var headerNames = ensureProductionSettingsHeaders(sheet).map(function(h) { return h.toLowerCase(); });
    var idx = {};
    PRODUCTION_SETTINGS_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

    var s = settings || {};
    var tufting = s.tufting || {};
    var design = s.design || {};
    var dyeing = s.dyeing || {};
    var finishing = s.finishing || {};

    var rowValues = [];
    rowValues[idx.RegularHoursPerDay] = Number(s.regularHoursPerDay) || 8;
    rowValues[idx.TuftingStaffCount] = Number(tufting.staffCount) || 0;
    rowValues[idx.TuftingOtHours] = Number(tufting.otHours) || 0;
    rowValues[idx.TuftingLoomCount] = Number(tufting.loomCount) || 1;
    rowValues[idx.DesignStaffCount] = Number(design.staffCount) || 0;
    rowValues[idx.DesignOtHours] = Number(design.otHours) || 0;
    rowValues[idx.DyeingStaffCount] = Number(dyeing.staffCount) || 0;
    rowValues[idx.DyeingKgPerDay] = Number(dyeing.kgPerDay) || 0;
    rowValues[idx.DyeingSetupHoursPerColor] = Number(dyeing.setupHoursPerColor) || 0;
    rowValues[idx.FinishingStaffCount] = Number(finishing.staffCount) || 0;
    rowValues[idx.FinishingOtHours] = Number(finishing.otHours) || 0;
    rowValues[idx.FinishingGlueStandardMultiplier] = Number(finishing.glueStandardMultiplier) || 0;
    rowValues[idx.FinishingGlueTypesJson] = JSON.stringify(
      Array.isArray(finishing.glueTypes) ? finishing.glueTypes : []
    );
    for (var c = 0; c < rowValues.length; c++) { if (rowValues[c] === undefined) rowValues[c] = ''; }

    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  } finally {
    lock.releaseLock();
  }

  // NEW (2026-09-11): dual-write to Supabase — see syncProductionSettingsToSupabase_() below.
  syncProductionSettingsToSupabase_(settings);
}

// ============================================================================
// NEW (2026-09-12): "แม่แบบ (Template) ลูกค้า/สินค้า" สำหรับ SPECIFICATIONS checklist — ให้แผนกขายบันทึก
// ชุดติ๊ก SPECIFICATIONS ที่ใช้บ่อย (เช่น "ลูกค้า A แบบพรมทอมือ") ไว้เลือกใช้ซ้ำตอนเปิด M/O, S/O ใหม่
// (see SPEC_FIELD_GROUPS/renderSpecTemplateOptions() ใน QCDashboard.html). Same per-record id-keyed
// CRUD-by-header-name pattern as Issues above — ต่างกันตรงที่นี่ไม่ผูกกับ M/O ใดๆ เป็นแค่แม่แบบให้เลือก
// QCDashboard.html reads/writes this via ?action=getSpecTemplates,deleteSpecTemplate GET / ?type=
// specTemplate POST.
// ============================================================================

var SPEC_TEMPLATES_SHEET_NAME = "SpecTemplates";
var SPEC_TEMPLATES_HEADERS = ["ID", "Name", "Specs", "CreatedAt"];

function getOrCreateSpecTemplatesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SPEC_TEMPLATES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SPEC_TEMPLATES_SHEET_NAME);
    sheet.appendRow(SPEC_TEMPLATES_HEADERS);
  }
  ensureSpecTemplatesHeaders(sheet);
  return sheet;
}

// Same self-healing "append whichever headers are missing" pattern used everywhere else in this file.
function ensureSpecTemplatesHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); }) : [];
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var appended = false;
  SPEC_TEMPLATES_HEADERS.forEach(function(h) {
    if (lowerHeaders.indexOf(h.toLowerCase()) === -1) {
      headers.push(h);
      lowerHeaders.push(h.toLowerCase());
      appended = true;
    }
  });
  if (appended) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

function getSpecTemplatesJsonResponse() {
  var sheet = getOrCreateSpecTemplatesSheet();
  var headerNames = ensureSpecTemplatesHeaders(sheet).map(function(h) { return h.toLowerCase(); });
  var idx = {};
  SPEC_TEMPLATES_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

  var rows = sheet.getDataRange().getValues();
  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[idx.ID]) continue; // skip blank rows
    data.push({
      id: String(row[idx.ID] || ''),
      name: String(row[idx.Name] || ''),
      specs: idx.Specs !== -1 && row[idx.Specs] ? String(row[idx.Specs]) : '{}',
      createdAt: idx.CreatedAt !== -1 && row[idx.CreatedAt] ? String(row[idx.CreatedAt]) : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// Wrapped in the same script-lock pattern as upsertIssue() above — two staff saving templates within
// the same second or two should never be able to clash on the same target row.
function upsertSpecTemplate(template) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSpecTemplatesSheet();
    var headerNames = ensureSpecTemplatesHeaders(sheet).map(function(h) { return h.toLowerCase(); });
    var idx = {};
    SPEC_TEMPLATES_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

    var rows = sheet.getDataRange().getValues();
    var existingRowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][idx.ID]).trim() === String(template.id).trim()) {
        existingRowIndex = i + 1;
        break;
      }
    }

    var rowValues = [];
    rowValues[idx.ID] = template.id || '';
    rowValues[idx.Name] = template.name || '';
    rowValues[idx.Specs] = typeof template.specs === 'object' ? JSON.stringify(template.specs || {}) : (template.specs || '{}');
    rowValues[idx.CreatedAt] = template.createdAt || '';
    for (var c = 0; c < rowValues.length; c++) { if (rowValues[c] === undefined) rowValues[c] = ''; }

    if (existingRowIndex !== -1) {
      sheet.getRange(existingRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  } finally {
    lock.releaseLock();
  }
}

function deleteSpecTemplateById(id) {
  var sheet = getOrCreateSpecTemplatesSheet();
  var rows = sheet.getDataRange().getValues();
  var key = String(id || '').trim();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.deleteRow(i + 1);
      return ContentService.createTextOutput(JSON.stringify({ result: "success", deletedId: id })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ result: "not_found" })).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================================
// รายชื่อพนักงานทอมือ (2026-09-12): backend สำหรับ "บันทึกการทอรายวัน" ใน QCDashboard.html — CRUD
// เดียวกันกับ SpecTemplates ด้านบนเป๊ะๆ (own sheet tab, self-healing headers, lock-protected upsert,
// find-by-id-or-append), ต่างกันแค่ตอนสร้างชีตครั้งแรกจะ seed รายชื่อพนักงาน 17 คนจากไฟล์ Excel ที่ลูกค้า
// แนบมาให้ทันที (เหมือน getOrCreateProductionSettingsSheet() ที่ seed แถวตั้งต้นให้เหมือนกัน) เพื่อไม่ต้อง
// ให้ผู้ใช้พิมพ์ชื่อ 17 คนเองใหม่ตั้งแต่ต้น — ฝั่งเว็บเองก็มี DEFAULT_WEAVING_STAFF ชุดเดียวกันสำรองไว้
// เผื่อยังไม่เคยตั้งค่า Google Sheet URL เลย ทั้งสองฝั่งจึงต้องคงชื่อ/รหัสให้ตรงกันหากแก้ไขในอนาคต.
// =====================================================================================

var WEAVING_STAFF_SHEET_NAME = "WeavingStaff";
var WEAVING_STAFF_HEADERS = ["ID", "Code", "Name", "Nickname"];

// Same 17 คน seed list as DEFAULT_WEAVING_STAFF in QCDashboard.html — keep both in sync.
var WEAVING_STAFF_DEFAULT_SEED_ = [
  ["ws1", "", "สายฝน กลิ่นหอม", "ฝน"],
  ["ws2", "", "สมพร คิดแต่ง", "ตา"],
  ["ws3", "", "พนารัตน์ ทองสาย", "ต่าย"],
  ["ws4", "", "ปิ่นรัช อาจหาญ", "ปิ่น"],
  ["ws5", "", "อรพินน์ ปู่จินะ", "นก"],
  ["ws6", "", "สุพัฒตา แซ่โง้ว", "ปุ้ย"],
  ["ws7", "", "ปราณี แสงทอง", "เจี้ยบ"],
  ["ws8", "", "PAN WAR", "วา"],
  ["ws9", "", "รัตนา จ้อยประดิษฐ์", "จ้อย"],
  ["ws10", "", "NAN HTAY HTAY AUNG", "จีจี้"],
  ["ws11", "", "จุฑามาศ แสงหิรัญ", "นุ่น"],
  ["ws12", "", "THOMGDAM SI OUTHAI", "ต้า"],
  ["ws13", "", "บุษบา เพียรักษ์", "แล๊ค"],
  ["ws14", "", "อภิเชษ เพียรักษ์", "เขต"],
  ["ws15", "", "AYE WIN THEIN", "โม"],
  ["ws16", "", "HKIN SU HLAING", "แข"],
  ["ws17", "", "KHUM", "คำ"]
];

function getOrCreateWeavingStaffSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WEAVING_STAFF_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(WEAVING_STAFF_SHEET_NAME);
    sheet.appendRow(WEAVING_STAFF_HEADERS);
    // Seed the default 17-person roster only on first creation of the sheet, same as
    // getOrCreateProductionSettingsSheet()'s seed-default-row pattern — later deletes/edits by the
    // user are never overwritten since this only runs once, right when the tab is first made.
    sheet.getRange(2, 1, WEAVING_STAFF_DEFAULT_SEED_.length, WEAVING_STAFF_HEADERS.length).setValues(WEAVING_STAFF_DEFAULT_SEED_);
  }
  ensureWeavingStaffHeaders(sheet);
  return sheet;
}

function ensureWeavingStaffHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); }) : [];
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var appended = false;
  WEAVING_STAFF_HEADERS.forEach(function(h) {
    if (lowerHeaders.indexOf(h.toLowerCase()) === -1) {
      headers.push(h);
      lowerHeaders.push(h.toLowerCase());
      appended = true;
    }
  });
  if (appended) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

function getWeavingStaffJsonResponse() {
  var sheet = getOrCreateWeavingStaffSheet();
  var headerNames = ensureWeavingStaffHeaders(sheet).map(function(h) { return h.toLowerCase(); });
  var idx = {};
  WEAVING_STAFF_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

  var rows = sheet.getDataRange().getValues();
  var data = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row[idx.ID]) continue; // skip blank rows
    data.push({
      id: String(row[idx.ID] || ''),
      code: idx.Code !== -1 ? String(row[idx.Code] || '') : '',
      name: String(row[idx.Name] || ''),
      nickname: idx.Nickname !== -1 ? String(row[idx.Nickname] || '') : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// Wrapped in the same script-lock pattern as upsertSpecTemplate() above.
function upsertWeavingStaffMember(member) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateWeavingStaffSheet();
    var headerNames = ensureWeavingStaffHeaders(sheet).map(function(h) { return h.toLowerCase(); });
    var idx = {};
    WEAVING_STAFF_HEADERS.forEach(function(h) { idx[h] = headerNames.indexOf(h.toLowerCase()); });

    var rows = sheet.getDataRange().getValues();
    var existingRowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][idx.ID]).trim() === String(member.id).trim()) {
        existingRowIndex = i + 1;
        break;
      }
    }

    var rowValues = [];
    rowValues[idx.ID] = member.id || '';
    rowValues[idx.Code] = member.code || '';
    rowValues[idx.Name] = member.name || '';
    rowValues[idx.Nickname] = member.nickname || '';
    for (var c = 0; c < rowValues.length; c++) { if (rowValues[c] === undefined) rowValues[c] = ''; }

    if (existingRowIndex !== -1) {
      sheet.getRange(existingRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  } finally {
    lock.releaseLock();
  }
}

function deleteWeavingStaffMemberById(id) {
  var sheet = getOrCreateWeavingStaffSheet();
  var rows = sheet.getDataRange().getValues();
  var key = String(id || '').trim();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.deleteRow(i + 1);
      return ContentService.createTextOutput(JSON.stringify({ result: "success", deletedId: id })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ result: "not_found" })).setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================================
// Supabase dual-write (2026-09-11): เขียนข้อมูลเดียวกันไปที่ Supabase ควบคู่กับ Google Sheets เดิม
// ระหว่างช่วงเปลี่ยนระบบ ("ใช้คู่กันไปก่อนจนมั่นใจ") — ถ้ายังไม่ได้ตั้งค่า Script Properties
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) ฟังก์ชันกลุ่มนี้จะไม่ทำอะไรเลย (no-op) ระบบเดิมจึงยังใช้
// งานได้ตามปกติ 100% แม้ยังไม่ได้ตั้ง Supabase — เปิดใช้งานได้ทันทีที่ตั้งค่า 2 ค่านี้ครบ
//
// วิธีตั้งค่า: Apps Script Editor -> ไอคอนรูปเฟือง "Project Settings" -> "Script Properties" ->
// "Add script property":
//   SUPABASE_URL               = https://xxxxx.supabase.co   (จาก Supabase -> Project Settings -> API)
//   SUPABASE_SERVICE_ROLE_KEY  = (คัดลอกจาก Supabase -> Project Settings -> API -> "service_role" secret)
// ห้ามนำ service_role key ไปใส่ในเว็บ (QCDashboard.html) เด็ดขาด — มันคือกุญแจที่ข้ามทุกกฎ RLS ได้
// ถ้าใส่ในเว็บ ใครก็เปิด "ดูซอร์สโค้ด" แล้วเอาไปแก้ข้อมูลอะไรก็ได้ในฐานข้อมูลทั้งหมด
// =====================================================================================

// Shared operational records that previously existed only in each browser's localStorage.
// Records remain JSON-shaped so new fields can be added without destructive sheet migrations.
var SHARED_RECORDS_SHEET_NAME = "DashboardSharedRecords";
var SHARED_RECORDS_HEADERS = ["Collection", "ID", "Data", "UpdatedAt"];
var SHARED_RECORD_COLLECTIONS = {
  finishingStaff: true,
  surplusLedger: true,
  designJobLogs: true
};

function normalizeSharedRecordCollection_(collection) {
  var key = String(collection || '').trim();
  if (!SHARED_RECORD_COLLECTIONS[key]) throw new Error('Unsupported shared collection: ' + key);
  return key;
}

function getOrCreateSharedRecordsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHARED_RECORDS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHARED_RECORDS_SHEET_NAME);
    sheet.appendRow(SHARED_RECORDS_HEADERS);
  }
  ensureSharedRecordsHeaders_(sheet);
  return sheet;
}

function ensureSharedRecordsHeaders_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h).trim(); })
    : [];
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var appended = false;
  SHARED_RECORDS_HEADERS.forEach(function(h) {
    if (lowerHeaders.indexOf(h.toLowerCase()) === -1) {
      headers.push(h);
      lowerHeaders.push(h.toLowerCase());
      appended = true;
    }
  });
  if (appended) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return headers;
}

function sharedRecordsColumnMap_(sheet) {
  var lower = ensureSharedRecordsHeaders_(sheet).map(function(h) { return h.toLowerCase(); });
  return {
    collection: lower.indexOf('collection'),
    id: lower.indexOf('id'),
    data: lower.indexOf('data'),
    updatedAt: lower.indexOf('updatedat')
  };
}

function getSharedRecordsJsonResponse(collection) {
  var key = normalizeSharedRecordCollection_(collection);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHARED_RECORDS_SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput("[]").setMimeType(ContentService.MimeType.JSON);
  }
  var idx = sharedRecordsColumnMap_(sheet);
  var rows = sheet.getDataRange().getValues();
  var records = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idx.collection] || '') !== key) continue;
    var record = safeJsonParse_(rows[i][idx.data], null);
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      if (!record.id) record.id = String(rows[i][idx.id] || '');
      records.push(record);
    }
  }
  return ContentService.createTextOutput(JSON.stringify(records)).setMimeType(ContentService.MimeType.JSON);
}

function upsertSharedRecord(collection, record) {
  var key = normalizeSharedRecordCollection_(collection);
  var item = record || {};
  var id = String(item.id || '').trim();
  if (!id) throw new Error('Shared record ID is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSharedRecordsSheet_();
    var idx = sharedRecordsColumnMap_(sheet);
    var rows = sheet.getDataRange().getValues();
    var targetRow = -1;
    for (var i = 1; i < rows.length; i++) {
      if (
        String(rows[i][idx.collection] || '') === key &&
        String(rows[i][idx.id] || '') === id
      ) {
        targetRow = i + 1;
        break;
      }
    }
    var values = [];
    values[idx.collection] = key;
    values[idx.id] = id;
    values[idx.data] = JSON.stringify(item);
    values[idx.updatedAt] = new Date().toISOString();
    for (var c = 0; c < values.length; c++) if (values[c] === undefined) values[c] = '';
    if (targetRow === -1) sheet.appendRow(values);
    else sheet.getRange(targetRow, 1, 1, values.length).setValues([values]);
  } finally {
    lock.releaseLock();
  }
}

function deleteSharedRecord(collection, id) {
  var key = normalizeSharedRecordCollection_(collection);
  var recordId = String(id || '').trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSharedRecordsSheet_();
    var idx = sharedRecordsColumnMap_(sheet);
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (
        String(rows[i][idx.collection] || '') === key &&
        String(rows[i][idx.id] || '') === recordId
      ) {
        sheet.deleteRow(i + 1);
        return;
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function replaceSharedRecords(collection, records) {
  var key = normalizeSharedRecordCollection_(collection);
  var items = Array.isArray(records) ? records.filter(function(item) {
    return item && String(item.id || '').trim();
  }) : [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSharedRecordsSheet_();
    var idx = sharedRecordsColumnMap_(sheet);
    var rows = sheet.getDataRange().getValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][idx.collection] || '') === key) sheet.deleteRow(i + 1);
    }
    if (items.length > 0) {
      var now = new Date().toISOString();
      var width = sheet.getLastColumn();
      var values = items.map(function(item) {
        var row = [];
        row[idx.collection] = key;
        row[idx.id] = String(item.id);
        row[idx.data] = JSON.stringify(item);
        row[idx.updatedAt] = now;
        for (var c = 0; c < width; c++) {
          if (row[c] === undefined) row[c] = '';
        }
        return row;
      });
      sheet.getRange(sheet.getLastRow() + 1, 1, values.length, width).setValues(values);
    }
  } finally {
    lock.releaseLock();
  }
}

function getSupabaseConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL');
  var key = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key: key };
}

function blankToNull_(v) {
  return (v === undefined || v === null || v === '') ? null : v;
}

// ล้อมด้วย try/catch เสมอ — ถ้า Supabase ล่ม/เน็ตหลุด ต้องไม่ทำให้การบันทึกลง Google Sheets (ระบบหลัก
// อยู่ระหว่างช่วงเปลี่ยนผ่านนี้) ล้มเหลวไปด้วย. rowOrRows: object เดียว หรือ array ของ object (batch).
function supabaseUpsert_(table, rowOrRows) {
  var cfg = getSupabaseConfig_();
  if (!cfg) return; // ยังไม่ได้ตั้งค่า Supabase — ข้ามเงียบๆ ไม่กระทบระบบเดิม
  try {
    var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      payload: JSON.stringify(rowOrRows),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 300) {
      console.error('Supabase upsert to ' + table + ' failed (' + code + '): ' + res.getContentText());
    }
  } catch (err) {
    console.error('Supabase upsert to ' + table + ' error: ' + err);
  }
}

// แปลง order object (รูปแบบเดียวกับที่ upsertOrderIntoSheets_ ได้รับ จาก doPost ที่ browser ส่งมา — ค่า
// วันที่ถูก normalize เป็นสตริง "YYYY-MM-DD" อยู่แล้วจากฝั่ง QCDashboard.html) ให้เป็นแถวตาราง
// production_orders ของ Supabase (ชื่อคอลัมน์แบบ snake_case ตาม supabase/schema.sql)
function orderToSupabaseRow_(order) {
  var planDates = order.planDates || {};
  return {
    mo_so: order.moSo || '',
    order_type: (order.orderType === 'SO' || order.orderType === 'MO') ? order.orderType : 'MO',
    market: (order.market === 'export' || order.market === 'domestic') ? order.market : null,
    sales_name: order.salesName || '',
    customer_name: order.customerName || '',
    customer_po: order.customerPO || '',
    total_sqm: Number(order.totalSqm) || 0,
    total_pieces: Number(order.totalPieces) || 0,
    size_items: order.sizeItems || [],
    design_image_url: order.designImageUrl || '',
    due_date: blankToNull_(order.dueDate),
    due_date_history: order.dueDateHistory || [],
    current_stage: order.currentStage || 'planning',
    ready_to_ship: !!order.readyToShip,
    shipped: !!order.shipped,
    shipped_date: blankToNull_(order.shippedDate),
    is_inserted: !!order.isInserted,
    shipping_mark: order.shippingMark || '',
    open_date: blankToNull_(order.openDate),
    location_name: order.locationName || '',
    quality: order.quality || '',
    packaging: order.packaging || '',
    colors_count: Number(order.colorsCount) || 0,
    carpet_size_note: order.carpetSizeNote || '',
    incoterms: order.incoterms || '',
    postpone_dispatch_date: blankToNull_(order.postponeDispatchDate),
    design_ref: order.designRef || '',
    ref_note: order.refNote || '',
    order_remark: order.orderRemark || '',
    planning_deadline_auto: order.planningDeadlineAuto === false ? false : true,
    planning: order.planning || {},
    design: order.design || {},
    dyeing: order.dyeing || {},
    weaving: order.weaving || {},
    finishing: order.finishing || {},
    plan_dates: planDates,
    plan_durations: order.planDurations || {},
    production_calc: order.productionCalc || {},
    created_at: blankToNull_(order.createdAt),
    last_updated: blankToNull_(order.lastUpdated)
  };
}

function syncOrderToSupabase_(order) {
  supabaseUpsert_('production_orders', orderToSupabaseRow_(order));
}

function syncProductionSettingsToSupabase_(settings) {
  var s = settings || {};
  var tufting = s.tufting || {};
  var design = s.design || {};
  var finishing = s.finishing || {};
  supabaseUpsert_('production_settings', {
    id: 1,
    regular_hours_per_day: Number(s.regularHoursPerDay) || 8,
    tufting_staff_count: Number(tufting.staffCount) || 0,
    tufting_ot_hours: Number(tufting.otHours) || 0,
    tufting_loom_count: Number(tufting.loomCount) || 1,
    design_staff_count: Number(design.staffCount) || 0,
    design_ot_hours: Number(design.otHours) || 0,
    finishing_staff_count: Number(finishing.staffCount) || 0,
    finishing_ot_hours: Number(finishing.otHours) || 0
  });
}

function safeJsonParse_(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    var t = v.trim();
    if (t.indexOf('{') === 0 || t.indexOf('[') === 0) {
      try { return JSON.parse(t); } catch (e) { return fallback; }
    }
  }
  return fallback;
}

function formatDateForSupabase_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return null;
}

function truthyCell_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

// แปลงแถวดิบจาก Google Sheet (object ที่ key เป็นชื่อ header ตรงๆ เช่น raw.MoSo, raw.DueDate) ให้เป็น
// แถวตาราง production_orders ของ Supabase โดยตรง — ใช้เฉพาะตอนย้ายข้อมูลครั้งเดียว (migrateAllToSupabase
// ด้านล่าง) ต่างจาก orderToSupabaseRow_() ด้านบนที่แปลงจาก order object ที่ browser ส่งมาตอนบันทึกสด.
function rawSheetRowToSupabaseRow_(raw) {
  return {
    mo_so: String(raw.MoSo || '').trim(),
    order_type: (raw.OrderType === 'SO' || raw.OrderType === 'MO') ? raw.OrderType : 'MO',
    market: (raw.Market === 'export' || raw.Market === 'domestic') ? raw.Market : null,
    sales_name: raw.SalesName || '',
    customer_name: raw.CustomerName || '',
    customer_po: raw.CustomerPO || '',
    total_sqm: Number(raw.TotalSqm) || 0,
    total_pieces: Number(raw.TotalPieces) || 0,
    size_items: safeJsonParse_(raw.SizeItems, []),
    design_image_url: raw.DesignImageUrl || '',
    due_date: formatDateForSupabase_(raw.DueDate),
    due_date_history: safeJsonParse_(raw.DueDateHistory, []),
    current_stage: raw.CurrentStage || 'planning',
    ready_to_ship: truthyCell_(raw.ReadyToShip),
    shipped: truthyCell_(raw.Shipped),
    shipped_date: formatDateForSupabase_(raw.ShippedDate),
    is_inserted: truthyCell_(raw.IsInserted),
    shipping_mark: raw.ShippingMark || '',
    open_date: formatDateForSupabase_(raw.OpenDate),
    location_name: raw.LocationName || '',
    quality: raw.Quality || '',
    packaging: raw.Packaging || '',
    colors_count: Number(raw.ColorsCount) || 0,
    carpet_size_note: raw.CarpetSizeNote || '',
    incoterms: raw.Incoterms || '',
    postpone_dispatch_date: formatDateForSupabase_(raw.PostponeDispatchDate),
    design_ref: raw.DesignRef || '',
    ref_note: raw.RefNote || '',
    order_remark: raw.OrderRemark || '',
    planning_deadline_auto: !(raw.PlanningDeadlineAuto === false || String(raw.PlanningDeadlineAuto).trim().toUpperCase() === 'FALSE'),
    planning: safeJsonParse_(raw.Planning, {}),
    design: safeJsonParse_(raw.Design, {}),
    dyeing: safeJsonParse_(raw.Dyeing, {}),
    weaving: safeJsonParse_(raw.Weaving, {}),
    finishing: safeJsonParse_(raw.Finishing, {}),
    plan_dates: {
      design: formatDateForSupabase_(raw.PlanDateDesign) || '',
      planning: formatDateForSupabase_(raw.PlanDatePlanning) || '',
      dyeing: formatDateForSupabase_(raw.PlanDateDyeing) || '',
      weaving: formatDateForSupabase_(raw.PlanDateWeaving) || '',
      finishing: formatDateForSupabase_(raw.PlanDateFinishing) || ''
    },
    plan_durations: safeJsonParse_(raw.PlanDurations, {}),
    production_calc: safeJsonParse_(raw.ProductionCalc, {}),
    created_at: formatDateForSupabase_(raw.CreatedAt),
    last_updated: formatDateForSupabase_(raw.LastUpdated)
  };
}

// ฟังก์ชันรันครั้งเดียวสำหรับย้ายข้อมูล M/O, S/O ทั้งหมดที่มีอยู่ใน Google Sheets เข้า Supabase
// วิธีรัน: เปิดไฟล์นี้ใน Apps Script Editor -> เลือกฟังก์ชัน "migrateAllToSupabase" ที่ dropdown
// ด้านบน (ข้าง "Debug") -> กด "Run" (ต้องตั้งค่า Script Properties SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY ไว้ก่อน ดู "Supabase dual-write" ด้านบน) — ปลอดภัยที่จะรันซ้ำได้หลายครั้ง
// เพราะเป็น upsert (ไม่สร้างข้อมูลซ้ำ ข้อมูลเดิมใน Supabase จะถูกเขียนทับด้วยค่าล่าสุดจาก Sheets)
function migrateAllToSupabase() {
  var cfg = getSupabaseConfig_();
  if (!cfg) {
    var msg = 'ยังไม่ได้ตั้งค่า Script Properties: SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY กรุณาตั้งค่าก่อน (รูปเฟือง Project Settings -> Script Properties)';
    console.log(msg);
    return msg;
  }
  var infos = getAllOrderSheetInfos_();
  var allRows = [];
  infos.forEach(function(info) {
    var data = info.sheet.getDataRange().getValues();
    if (data.length < 2) return;
    var headers = data[0].map(function(h) { return String(h).trim(); });
    for (var r = 1; r < data.length; r++) {
      var raw = {};
      headers.forEach(function(h, c) { raw[h] = data[r][c]; });
      if (!raw.MoSo) continue;
      allRows.push(rawSheetRowToSupabaseRow_(raw));
    }
  });

  // ส่งเป็นชุดๆ (batch) ครั้งละ 200 แถว กัน request ใหญ่เกินไปจนหมดเวลา
  var BATCH = 200;
  var migrated = 0;
  for (var i = 0; i < allRows.length; i += BATCH) {
    supabaseUpsert_('production_orders', allRows.slice(i, i + BATCH));
    migrated += Math.min(BATCH, allRows.length - i);
  }
  var resultMsg = 'ย้ายข้อมูลเสร็จแล้ว: ' + migrated + ' M/O, S/O (จาก ' + infos.length + ' ชีต) เข้า Supabase';
  console.log(resultMsg);
  return resultMsg;
}

function doPost(e) {
  try {
    // NEW: route production-order saves (dashboard posts these with ?type=order) to the correct one
    // of the 4 M/O, S/O x market sheets (see ORDERS_SHEET_NAMES/upsertOrder), completely separate
    // from the QC upsert logic below.
    var type = e && e.parameter ? e.parameter.type : '';

    // NEW (2026-09-14): LINE Messaging API webhook events land on this SAME Web App URL once it's
    // pasted into LINE Developers Console's Webhook settings (see LINE_GROUP_ID's setup steps above) —
    // this Apps Script has never received a request from LINE's servers before now, only from the
    // dashboard itself. Told apart from the dashboard's own POSTs by shape, not by URL: every dashboard
    // POST always carries ?type=... in the query string (checked above), while LINE's webhook body is
    // always JSON shaped like {destination, events:[...]} and never carries that query param. Must
    // always return HTTP 200 quickly regardless of what's inside, or LINE will retry/flag the webhook.
    if (!type && e && e.postData && e.postData.contents) {
      try {
        var maybeLineWebhook = JSON.parse(e.postData.contents);
        if (maybeLineWebhook && Array.isArray(maybeLineWebhook.events)) {
          return handleLineWebhookEvents_(maybeLineWebhook.events);
        }
      } catch (webhookParseErr) {
        // Not JSON, or JSON but not a LINE webhook shape — fall through to normal routing below.
      }
    }

    if (!hasDashboardWriteAccess_(e)) {
      return dashboardWriteDeniedResponse_();
    }

    if (type === 'order') {
      var orderData = JSON.parse(e.postData.contents);
      upsertOrder(orderData);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // NEW (2026-09e): issue-report upsert (dashboard posts these with ?type=issue) — see upsertIssue()
    // above. LINE notification for a new/updated issue is sent separately by the dashboard via the
    // existing ?type=lineNotify path (see notifyLineIssueReported() in QCDashboard.html), so this
    // branch only needs to persist the row.
    if (type === 'issue') {
      var issueData = JSON.parse(e.postData.contents);
      upsertIssue(issueData);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // NEW (2026-09-10): production calculation engine's shared settings (dashboard posts these with
    // ?type=productionSettings) — see upsertProductionSettings() above.
    if (type === 'productionSettings') {
      var productionSettingsData = JSON.parse(e.postData.contents);
      upsertProductionSettings(productionSettingsData);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // NEW (2026-09-12): SPECIFICATIONS checklist template upsert (dashboard posts these with
    // ?type=specTemplate) — see upsertSpecTemplate() above.
    if (type === 'specTemplate') {
      var specTemplateData = JSON.parse(e.postData.contents);
      upsertSpecTemplate(specTemplateData);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // NEW (2026-09-12): รายชื่อพนักงานทอมือ upsert (dashboard posts these with ?type=weavingStaff) —
    // see upsertWeavingStaffMember() above.
    if (type === 'weavingStaff') {
      var weavingStaffData = JSON.parse(e.postData.contents);
      upsertWeavingStaffMember(weavingStaffData);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    if (type === 'sharedRecord') {
      var sharedRecordData = JSON.parse(e.postData.contents);
      upsertSharedRecord(sharedRecordData.collection, sharedRecordData.record);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    if (type === 'deleteSharedRecord') {
      var sharedDeleteData = JSON.parse(e.postData.contents);
      deleteSharedRecord(sharedDeleteData.collection, sharedDeleteData.id);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    if (type === 'replaceSharedRecords') {
      var sharedReplaceData = JSON.parse(e.postData.contents);
      replaceSharedRecords(sharedReplaceData.collection, sharedReplaceData.records);
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // NEW: design-image upload (dashboard posts these with ?type=uploadImage) — see
    // uploadDesignImageAndSave() above for the Drive + sheet-write logic.
    if (type === 'uploadImage') {
      var uploadData = JSON.parse(e.postData.contents);
      var uploadResult = uploadDesignImageAndSave(uploadData);
      return ContentService.createTextOutput(JSON.stringify(uploadResult)).setMimeType(ContentService.MimeType.JSON);
    }

    // NEW: LINE broadcast notification (dashboard posts these with ?type=lineNotify) — fired when an
    // M/O, S/O is confirmed ready to ship. Wrapped in its own try/catch so a LINE-side failure (bad
    // token, API outage, etc.) never surfaces as an error to the dashboard — sending the notification
    // is best-effort and never blocks the ready-to-ship confirmation itself.
    if (type === 'lineNotify') {
      try {
        var notifyData = JSON.parse(e.postData.contents);
        sendLineNotification(notifyData.message || ''); // group push if LINE_GROUP_ID is set, else old broadcast — see sendLineNotification() above
      } catch (lineErr) {
        Logger.log('LINE notify error: ' + lineErr.toString());
      }
      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // ===== QC upsert logic =====
    // FIX (2026-09): now writes every field by looking up its column NAME (via ensureQcHeaders /
    // qcColIndex) instead of a hardcoded column number, and includes "remark" — which previously
    // had no column at all and was silently dropped on every save. See the comments above
    // ensureQcHeaders() for the full explanation of both bugs this fixes ("remark disappears" and
    // "inspector doesn't show").
    //
    // FIX (2026-09b): the whole block below — read the sheet, figure out which row this record
    // belongs on, then write 10 cells one at a time — is now wrapped in a script lock. Without this,
    // two QC submissions arriving within the same second or two (very plausible on mobile: several
    // staff finishing a loom/dye check around the same time, or one person tapping "save" more than
    // once) could both read the sheet's "last row" before either had written anything, both compute
    // the SAME target row, and then have their 10 separate setValue() calls interleave — producing
    // one garbled row that mixes fields from two unrelated submissions. That's what caused some
    // rows' "MO/SO" cell to show what looked like a completely different record's raw JSON. The lock
    // makes each submission's read-then-write sequence atomic relative to every other one, so two
    // concurrent saves are simply queued one after another instead of colliding on the same row.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
      var headers = ensureQcHeaders(sheet);
      var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });

      var idIdx = qcColIndex(lowerHeaders, 'id');
      var dateIdx = qcColIndex(lowerHeaders, 'date', 'วันที่');
      var deptIdx = qcColIndex(lowerHeaders, 'department', 'แผนก');
      var mosoIdx = qcColIndex(lowerHeaders, 'mo/so') !== -1 ? qcColIndex(lowerHeaders, 'mo/so') : qcColIndex(lowerHeaders, 'mo/s/o');
      var detailsIdx = qcColIndex(lowerHeaders, 'details');
      var statusIdx = qcColIndex(lowerHeaders, 'status', 'สถานะ');
      var inspIdx = qcColIndex(lowerHeaders, 'inspector', 'ผู้ตรวจสอบ');
      var stampIdx = qcColIndex(lowerHeaders, 'stamp pass') !== -1 ? qcColIndex(lowerHeaders, 'stamp pass') : qcColIndex(lowerHeaders, 'stamp');
      var remarkIdx = qcColIndex(lowerHeaders, 'remark', 'หมายเหตุ');
      var extraIdx = qcColIndex(lowerHeaders, 'extradata', 'ข้อมูลเพิ่มเติม');

      var data = JSON.parse(e.postData.contents);
      var rows = sheet.getDataRange().getValues();

      var existingRowIndex = -1;
      if (data.id && idIdx !== -1) {
        for (var i = 1; i < rows.length; i++) {
          if (String(rows[i][idIdx]) === String(data.id)) {
            existingRowIndex = i + 1;
            break;
          }
        }
      }

      var targetRow = existingRowIndex !== -1 ? existingRowIndex : (sheet.getLastRow() + 1);
      var extraJson = typeof data.extraData === 'object' ? JSON.stringify(data.extraData || {}) : (data.extraData || '{}');

      // FIX (2026-09-09): "Details" used to get the same raw JSON blob as "ExtraData" — unreadable to
      // anyone opening the Sheet directly, and not usable as data the way the user actually types it
      // in the web app. The dashboard now sends a plain-text, human-readable version of the same
      // department fields as data.detailsText (see buildQcDetailsText() in QCDashboard.html) — write
      // that into "Details" instead, keeping "ExtraData" as the raw JSON machine-readable backup.
      // Falls back to the JSON blob only if an older/unmodified client posts without detailsText.
      var detailsText = (typeof data.detailsText === 'string' && data.detailsText) ? data.detailsText : extraJson;

      // Writes one cell at a time by column index, and skips any field whose column doesn't exist on
      // this sheet (idx === -1) instead of guessing a position — that guessing is exactly what let
      // fields land in the wrong column before this fix.
      var setCell = function(idx, value) {
        if (idx === -1) return;
        sheet.getRange(targetRow, idx + 1).setValue(value);
      };
      setCell(idIdx, data.id || '');
      setCell(dateIdx, data.date || '');
      setCell(deptIdx, data.department || '');
      setCell(mosoIdx, data.moSo || '');
      setCell(detailsIdx, detailsText);
      setCell(statusIdx, data.status || 'PASS');
      setCell(inspIdx, data.inspector || '');
      setCell(stampIdx, data.stamp || '-');
      setCell(remarkIdx, data.remark || '');
      setCell(extraIdx, extraJson);

      return ContentService.createTextOutput(JSON.stringify({ result: "success" })).setMimeType(ContentService.MimeType.JSON);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
