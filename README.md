# 🌲 MTP Wood Thailand - Executive Financial Dashboard & Report

ระบบรายงานสรุปผลการดำเนินงาน งบรายรับ-รายจ่าย และบัญชีภาระหนี้กู้ยืมแบบโต้ตอบ (Offline & Responsive Interactive Dashboard) สำหรับ **MTP Wood Thailand**

![MTP Wood Dashboard](https://img.shields.io/badge/Status-Complete-success?style=for-the-badge)
![Offline Ready](https://img.shields.io/badge/Offline-100%25-blue?style=for-the-badge)
![Design System](https://img.shields.io/badge/Design-Premium_White_%26_Brown-8c6239?style=for-the-badge)

---

## 🌟 คุณสมบัติหลัก (Key Features)

- **ทำงานแบบ ออฟไลน์ 100% (Offline Interactive Dashboard)**: รวมสไตล์ หน้าเว็บ และสคริปต์อยู่ในไฟล์เดียว เปิดดูผ่านเว็บเบราว์เซอร์ได้ทันทีโดยไม่ต้องใช้อินเทอร์เน็ต
- **ระบบการออกแบบ Premium White & Brown Design System**:
  - โทนสีไม้นุ่มนวล ครีมอุ่น (Soft Warm Cream `#fdfbf7`), น้ำตาลกาแฟเอสเพรสโซ่ (`#3c2f2f`) และสีไม้สักทอง (`#8c6239`)
  - แถบ Progress Bars และการ์ด KPI สถิติสรุปผลชัดเจน
- **รายงานสรุปงบสิงหาคม 2569 (August 2026)**:
  - **MTP รายรับ**: ฿360,701.00 (อิงจากไฟล์ `MTP_WOOD_MTP-REVENUE_all.xlsx`)
  - **MTP รายจ่าย**: ฿409,060.62 (อิงจากไฟล์ `MTP_WOOD_MTP-EXPENSES_all.xlsx`)
  - **ผลการดำเนินงานสุทธิ**: -฿48,359.62
- **การคุมบัญชีเงินยืม & เงินกู้ยืม**:
  - **เงินยืม ที.วอช**: แสดงรายการยืมเดือนล่าสุด พร้อมหมายเหตุระบุ *"ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"*
  - **เงินกู้ คุณอาแสวง**: แสดงตารางบันทึกการชำระเงินกู้ครบ 12 งวด (เงินต้น 500,000 บาท ดอกเบี้ย 1.5%/เดือน)
  - **ภาระหนี้สะสมสุทธิรวม 4 สมุดบัญชี**: ฿894,106.03

---

## 🚀 วิธีการอัปโหลดขึ้น GitHub & เปิดใช้งาน GitHub Pages

### วิธีที่ 1: อัปโหลดผ่านหน้าเว็บไซต์ GitHub (Drag & Drop)
1. ไปที่ [GitHub.com](https://github.com) แล้วสร้าง Repository ใหม่ (ตั้งชื่อ เช่น `mtp-wood-dashboard`)
2. กดปุ่ม **Upload files**
3. ลากไฟล์ `index.html`, `style.css`, `MTP_Wood_Thailand_Financial_Processing_Summary.xlsx` และ `README.md` วางลงใน GitHub แล้วกด **Commit changes**
4. ไปที่เมนู **Settings** -> **Pages** -> เลือก Branch เป็น `main` แล้วกด **Save**
5. คุณจะได้ลิงก์เว็บไซต์ออฟไลน์ออนไลน์ เช่น `https://<your-username>.github.io/mtp-wood-dashboard/` เปิดดูได้ทุกที่!

### วิธีที่ 2: ใช้ GitHub Desktop
1. ดาวน์โหลดโปรแกรม [GitHub Desktop](https://desktop.github.com/)
2. เลือก **Add Local Repository** แล้วเลือกโฟลเดอร์นี้
3. กด **Publish Repository** ขึ้น GitHub ได้ทันที

---

## 📂 โครงสร้างไฟล์ในโครงการ

```text
├── index.html                                        # หน้าสรุปผล Dashboard หลัก (เปิดดูบนเบราว์เซอร์ได้ทันที)
├── summary_offline.html                              # หน้าสรุปผลออฟไลน์สำรอง
├── style.css                                         # ไฟล์ CSS ระบบดีไซน์ Premium White & Brown System
├── MTP_Wood_Thailand_Financial_Processing_Summary.xlsx # ไฟล์ Excel สรุปทุกสมุดบัญชี
├── README.md                                         # เอกสารอธิบายโครงการ
└── .gitignore                                        # ไฟล์ละเว้นไฟล์ชั่วคราวสำหรับ Git
```

---

© 2026 MTP Wood Thailand. All rights reserved.
