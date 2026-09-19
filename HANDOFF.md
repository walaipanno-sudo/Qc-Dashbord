# Claude Handoff: Qc-Dashbord

เอกสารนี้ใช้ส่งต่องานให้ Claude หรือโมเดลถัดไปในโปรเจกต์ QCDashboard ของ Siam Carpets

## สถานะล่าสุด

- วันที่สรุป: 19 กันยายน 2026
- Repository: `https://github.com/walaipanno-sudo/Qc-Dashbord`
- GitHub Pages: `https://walaipanno-sudo.github.io/Qc-Dashbord/`
- PR #6: **merged** เข้า `main`
- Merge commit ล่าสุดของ PR #6: `3f07d5b1ac8c58174adff86ead5cbfa9de9b2ea4`
- GitHub Pages deployment ล่าสุด:
  - Deployment ID: `6537923975`
  - SHA: `3f07d5b1ac8c58174adff86ead5cbfa9de9b2ea4`
  - สถานะ: `success`
- Branch ที่ใช้พัฒนาก่อน merge: `skywork/department-board-details-20260918`
- Commit ก่อน merge บน branch ดังกล่าว: `22f62a5`

## สิ่งที่ทำเสร็จแล้ว

### Production overview

เพิ่มการแสดงสถานะตามแผนกในหน้า Overview ของการผลิต M/O และ S/O:

- แผนกย้อม:
  - `ทั้งหมด X สี`
  - `ย้อมแล้ว Y สี`
  - `เหลือ Z สี`
- แผนกดีไซน์:
  - `กำลังทำแบบ`
  - `คิวทำแบบ`
  - `กำลังปั๊มผ้า`
  - `รอคิวปั๊มผ้า`
- แผนกแต่ง:
  - `กำลังแต่ง`
  - `รอแต่ง`
- สถานะทอเดิมยังคงรองรับ:
  - `จ้างทอภายนอก`
  - `กำลังทอจอ ...`
  - `รอคิวทอ`

ไฟล์ frontend ที่เกี่ยวข้อง:

- `index.html`
- `apps-script/index.html`

ไฟล์ทั้งสองควรมีโค้ด frontend ที่สอดคล้องกัน หากแก้ไฟล์หนึ่งให้ตรวจสอบอีกไฟล์ด้วย

### Layout

- คืน layout หน้าเว็บกลับเป็นรูปแบบเดิมตามคำขอของผู้ใช้
- คง `max-width: 1440px`
- ไม่ใช้ layout sidebar/full-width แบบทดลองที่ทำให้หน้าใหม่แสดงไม่เต็มจอ

### Apps Script Production

- ใช้ Production deployment เดิม ห้ามสร้าง deployment ใหม่โดยไม่จำเป็น
- Deployment ID เดิม:
  `AKfycbx4-GPp_qi4um9SWWQWo5xNtuVyA9ROIsmKbMIMQbvqcf-oFPQvCN2wJO-Wq1spt89_Yg`
- Apps Script version ล่าสุดที่ deploy:
  - Version: `71`
  - Description: `คืนรูปแบบหน้าเว็บเดิม คงสถานะการผลิตแบบใหม่`

GitHub Pages และ Apps Script Production เป็นคนละระบบ อย่าสับสนกัน:

- GitHub Pages deploy จาก `main`
- Apps Script Production ใช้ deployment ID เดิมด้านบน

## ไฟล์และคำสั่งสำคัญ

- `index.html`: frontend สำหรับ GitHub Pages
- `apps-script/index.html`: frontend สำหรับ Apps Script
- `apps-script/Code.js`: backend/API และการบันทึก Google Sheets
- `apps-script/appsscript.json`: Apps Script manifest
- `scripts/audit-html.js`: ตรวจ DOM และ inline handlers
- `.github/workflows/validate-apps-script.yml`: workflow ตรวจสอบบน GitHub Actions

ตรวจสอบสถานะ Git และ branch ก่อนเริ่มงาน:

```powershell
git status --short --branch
git fetch origin --prune
git log -10 --oneline --decorate
```

เริ่มงานใหม่จาก `main`:

```powershell
git checkout main
git pull origin main
git checkout -b claude/<short-task-name>
```

## Validation ก่อน commit/push

รันคำสั่งต่อไปนี้จากโฟลเดอร์ `Qc-Dashbord`:

```powershell
node C:\Users\walai\.skywork\skills\siam-carpets-production-workflow\scripts\validate_inline_js.js apps-script\index.html
node --check apps-script\Code.js
node scripts\audit-html.js index.html
git diff --check
```

ผลที่คาดหวัง:

- Inline JavaScript validation ผ่าน
- `node --check` ไม่มี syntax error
- HTML audit ไม่พบ duplicate IDs หรือ inline handler ที่หาย
- `git diff --check` ไม่มี whitespace error

หมายเหตุ: `audit-html.js` อาจรายงาน ID ที่สร้างแบบ dynamic/modal อยู่แล้ว เช่น
`deptTabCountAll`, `designRowsContainer`, `dyeRowsContainer`, `finishRowsContainer`
และ ID ลักษณะเดียวกัน อย่าลบโค้ดเดิมเพียงเพราะรายงาน baseline เหล่านี้

## ข้อควรระวัง

- อย่าใช้ `git reset --hard` หรือ revert การเปลี่ยนแปลงของผู้ใช้โดยไม่ได้รับอนุญาต
- อย่าเพิ่มไฟล์ชั่วคราวหรือไฟล์ screenshot เข้า commit โดยไม่จำเป็น
- ตอนตรวจสถานะให้แยกไฟล์ untracked เหล่านี้ออกจากงานหลัก:
  - `production-viewport.png`
  - `scripts/__pycache__/`
  - `scripts/build-historical-mo2026-import.py`
  - `scripts/preview-server.js`
- อย่าสร้าง Apps Script Production deployment ใหม่
- ห้ามแก้ schema หรือชื่อ sheet เดิมโดยไม่ตรวจ compatibility
- ถ้าแก้ frontend ให้ตรวจทั้ง `index.html` และ `apps-script/index.html`
- หลีกเลี่ยงการเปลี่ยน layout กลับเป็นแบบใหม่ที่ไม่เต็มจอ เว้นแต่ผู้ใช้ร้องขอ

## Workflow ส่งงานต่อ

1. อ่านไฟล์นี้, `README.md`, `git status` และ `git log` ก่อนเริ่ม
2. สร้าง branch แยกสำหรับงานย่อยหนึ่งเรื่อง
3. แก้ไขและรัน validation
4. commit เป็นช่วงเล็ก ๆ พร้อมข้อความที่อธิบายได้
5. push branch และเปิด Pull Request ไป `main`
6. ตรวจ diff, checks และผลกระทบต่อ Apps Script ก่อน merge
7. หลัง merge ให้ตรวจ GitHub Pages deployment ว่า SHA ตรงกับ merge commit
8. หากต้องแก้ Apps Script Production ให้รักษา deployment ID เดิม

ตัวอย่างคำสั่งหลัง merge:

```powershell
git fetch origin main --prune
git log -1 --oneline origin/main
gh api "repos/walaipanno-sudo/Qc-Dashbord/deployments?environment=github-pages&per_page=3"
```

## งานถัดไปที่แนะนำ

1. เปิดหน้า GitHub Pages และตรวจด้วยข้อมูลจริงของ M/O และ S/O ว่าสถานะย้อม, ดีไซน์ และแต่งตรงกับข้อมูลในระบบ
2. ตรวจ responsive layout บน desktop และ mobile โดยคงรูปแบบหน้าเดิม
3. เพิ่ม automated test สำหรับ helper:
   - `getOverviewDyeingLabel`
   - `getOverviewDesignLabel`
   - `getOverviewFinishingLabel`
4. ทบทวนข้อมูล legacy ของ dyeing ที่ใช้ `plannedColorCount`, `colorsOrdered`, `colorsCompleted` และ `items`
5. ตรวจว่าการแก้ไข frontend ในอนาคตยังคง sync ระหว่าง root page และ Apps Script page
6. หากพบ bug จาก production ให้สร้าง issue พร้อมระบุ M/O หรือ S/O, แผนก, ข้อมูล input และผลที่คาดหวัง

## Prompt สำหรับ Claude ตัวถัดไป

```text
ทำงานต่อจาก repository Qc-Dashbord โดยอ่าน HANDOFF.md และ README.md ก่อน

ตรวจสอบ git status, branch และ commit ล่าสุดก่อนแก้ไข
อย่าลบหรือ reset การเปลี่ยนแปลงเดิม
แก้เฉพาะงานที่ระบุในคำขอ
ถ้าแก้ frontend ให้ตรวจทั้ง index.html และ apps-script/index.html
ห้ามสร้าง Apps Script Production deployment ใหม่ และต้องรักษา deployment ID เดิม
รัน validation ที่ระบุใน HANDOFF.md
สรุปไฟล์ที่แก้ไข ผลการตรวจสอบ และงานที่ยังเหลือ
สร้าง commit และ push branch เมื่อการเปลี่ยนแปลงพร้อม review
```

