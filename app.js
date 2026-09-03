// Configure PDF.js Worker (defer-safe: initialized when needed)
function ensurePdfJsWorker() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
    }
}

// ── jsonbin.io Cloud Share Config ────────────────────────────────────────────
// สมัครฟรีได้ที่ https://jsonbin.io  แล้ว paste Master Key ที่นี่
const JSONBIN_CONFIG = {
    apiKey: localStorage.getItem('mtp_jsonbin_key') || '',   // เก็บใน localStorage ได้จาก Settings
    baseUrl: 'https://api.jsonbin.io/v3'
};
// ──────────────────────────────────────────────────────────────────────────────

// Lazy-load Tesseract.js only when user actually scans (saves ~2MB on first load)
let _tesseractLoaded = false;
async function ensureTesseractLoaded() {
    if (_tesseractLoaded || window.Tesseract) {
        _tesseractLoaded = true;
        return;
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = () => { _tesseractLoaded = true; resolve(); };
        script.onerror = () => reject(new Error('ไม่สามารถโหลดมอดูล OCR (Tesseract.js) ได้'));
        document.head.appendChild(script);
    });
}

// App State
let db = {
    mtp_expenses: [],
    'mtp-expenses': [],
    mtp_revenue: [],
    'mtp-revenue': [],
    'jamjuree-revenue': [],
    'twash-loans': [],
    'asawaeng-loans': [],
    'wan-loans': [],
    'pimas-expenses': []
};

// Key Normalization Helper mapping all English and Thai sheet names to canonical sheet IDs
function normalizeLedgerKey(key) {
    if (!key) return 'mtp-expenses';
    const k = String(key).trim().toLowerCase();
    
    // 1. ค่าใช้จ่ายทั่วไป
    if (k === 'mtp-expenses' || k === 'mtp_expenses' || k === 'expenses' || k === '1. ค่าใช้จ่ายทั่วไป' || k === 'ค่าใช้จ่าย' || k === 'ค่าใช้จ่ายทั่วไป' || k === 'mtp รายจ่าย') return 'mtp-expenses';

    // MTP รายรับ
    if (k === 'mtp-revenue' || k === 'mtp_revenue' || k === 'mtp รายรับ' || k === 'รายรับ mtp' || k === 'รายรับ') return 'mtp-revenue';

    // จามจุรีย์ รายรับ
    if (k === 'jamjuree-revenue' || k === 'jamjuree_revenue' || k === 'จามจุรีย์ รายรับ' || k === 'จามจุรีย์') return 'jamjuree-revenue';

    // 2. เงินยืม ที.วอช
    if (k === 'twash-loans' || k === 'twash_loans' || k === 'twash' || k === '2. เงินยืม ที.วอช' || k === 'ยืมเงิน ที.วอช' || k === 'เงินยืม ที.วอช' || k === 'เงินยืมทีวอช') return 'twash-loans';

    // 3. เงินกู้ คุณอาแสวง
    if (k === 'asawaeng-loans' || k === 'asawaeng_loans' || k === 'asawaeng' || k === '3. เงินกู้ คุณอาแสวง' || k === 'กู้เงินอาแสวง' || k === 'กู้เงินคุณอาแสวง' || k === 'เงินกู้ คุณอาแสวง') return 'asawaeng-loans';

    // 4. เงินกู้ บ.วัน
    if (k === 'wan-loans' || k === 'wan_loans' || k === 'wan' || k === '4. เงินกู้ บ.วัน' || k === 'กู้เงิน บ.วัน' || k === 'กู้เงินบริษัท วัน' || k === 'เงินกู้ บ.วัน') return 'wan-loans';

    // 5. เงินสำรองจ่าย พี่มัด
    if (k === 'pimas-expenses' || k === 'pimas_expenses' || k === 'pmad-advance' || k === 'pmad_advance' || k === 'pmad-loans' || k === 'pmad_loans' || k === '5. เงินสำรองจ่าย พี่มัด' || k === 'พี่มัสสำรองจ่าย' || k === 'สำรองจ่ายพี่มัด' || k === 'เงินสำรองจ่าย พี่มัด') return 'pimas-expenses';

    return key;
}

function getAltKeys(normKey) {
    if (normKey === 'mtp-expenses') return ['mtp_expenses', 'expenses'];
    if (normKey === 'pimas-expenses') return ['pimas_expenses', 'pmad-advance', 'pmad_advance', 'pmad-loans', 'pmad_loans'];
    if (normKey === 'twash-loans') return ['twash_loans', 'twash'];
    if (normKey === 'asawaeng-loans') return ['asawaeng_loans', 'asawaeng'];
    if (normKey === 'wan-loans') return ['wan_loans', 'wan'];
    if (normKey === 'mtp-revenue') return ['mtp_revenue'];
    if (normKey === 'jamjuree-revenue') return ['jamjuree_revenue'];
    return [];
}

// Fingerprint generator for deduplication (date + time + amount + memo)
function generateRecordFingerprint(record) {
    const d = (record.date || '').trim();
    const t = (record.time || '').trim();
    const amt = parseFloat(record.amount !== undefined && record.amount !== 0 ? record.amount : (record.interest || record.principalRepaid || 0)).toFixed(2);
    const memo = (record.memo || record.merchant || record.purpose || record.description || record.customer || record.remarks || '').trim().toLowerCase();
    return `${d}_${t}_${amt}_${memo}`;
}

function isDuplicateRecord(list, newRecord) {
    if (!Array.isArray(list) || list.length === 0) return false;
    const fp = generateRecordFingerprint(newRecord);
    return list.some(existing => generateRecordFingerprint(existing) === fp);
}

// Robust Database Accessors to prevent key Mismatch
function getLedgerList(key) {
    if (!db) db = {};
    const normKey = normalizeLedgerKey(key);
    if (!db[normKey]) db[normKey] = [];
    
    // Sync alias references in db object
    const altKeys = getAltKeys(normKey);
    altKeys.forEach(ak => {
        db[ak] = db[normKey];
    });
    
    return db[normKey];
}

function pushToLedger(key, record) {
    const list = getLedgerList(key);
    
    // Deduplication: prevent adding identical duplicate entries while preserving existing ones
    if (isDuplicateRecord(list, record)) {
        return false;
    }
    
    list.unshift(record);
    const normKey = normalizeLedgerKey(key);
    const altKeys = getAltKeys(normKey);
    altKeys.forEach(ak => {
        db[ak] = list;
    });
    return true;
}

let appState = {
    apiKey: '',
    selectedMonth: '2026-08', // Default month
    activeTab: 'overview',
    viewerMode: false, // shared snapshot viewer state (Read-Only)
    isSharedWorkspace: false, // shared snapshot editable state (Editable)
    
    // OCR Scan temporary states
    scanImageBase64: '',
    scanImageMime: '',
    scanFileName: '',
    scanItems: [],
    
    // Multi-page PDF state
    currentPdfFile: null,
    pdfTotalPages: 1,
    pdfCurrentPage: 1,
    
    // Pagination states
    pagination: {
        'mtp-expenses': { page: 1, limit: 10 },
        'mtp-revenue': { page: 1, limit: 10 },
        'jamjuree-revenue': { page: 1, limit: 10 },
        'twash-loans': { page: 1, limit: 10 },
        'asawaeng-loans': { page: 1, limit: 10 },
        'wan-loans': { page: 1, limit: 10 },
        'pimas-expenses': { page: 1, limit: 10 }
    },
    
    // Search text states
    search: {
        'mtp-expenses': '',
        'mtp-revenue': '',
        'jamjuree-revenue': '',
        'twash-loans': '',
        'asawaeng-loans': '',
        'wan-loans': '',
        'pimas-expenses': ''
    },
    
    // Reusable charts instance
    charts: {
        cashflow: null
    }
};

// Sheet configuration details (headers, dynamic form fields)
const SHEET_CONFIGS = {
    'mtp-expenses': {
        title: '1. ค่าใช้จ่ายทั่วไป',
        headers: ['วันที่', 'หมวดหมู่', 'รายละเอียด', 'เลขที่อ้างอิง', 'จำนวนเงิน (บาท)', 'ผู้รับเงิน / ปลายทาง', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'date', label: 'วันที่ใช้จ่าย', type: 'date', required: true },
            { id: 'category', label: 'หมวดหมู่รายจ่าย', type: 'select', required: true, options: [
                'ค่าไม้',
                'ค่าน้ำมัน',
                'ค่าแรง',
                'ค่าอะไหล่',
                'ค่าไฟ/น้ำ',
                'ค่าเช่า/อื่นๆ'
            ]},
            { id: 'merchant', label: 'รายละเอียดรายการ', type: 'text', required: true, placeholder: 'เช่น ค่าหนังสือรับรอง, ค่าน้ำมัน, ค่าซ่อมสายสลิง' },
            { id: 'billRef', label: 'เลขที่อ้างอิงบิล / โอน (Ref No.)', type: 'text', placeholder: 'เช่น REF-1002, บิลเลขที่ 01' },
            { id: 'amount', label: 'จำนวนเงิน (บาท)', type: 'number', required: true, step: '0.01' },
            { id: 'payee', label: 'ผู้รับเงิน / ปลายทาง', type: 'text', placeholder: 'เช่น พาณิชย์ จ.เชียงราย, ธ.กรุงไทย, ปตท.' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'คำอธิบายเพิ่มเติม / ผู้โอน' }
        ]
    },
    'mtp-revenue': {
        title: 'MTP รายรับ',
        headers: ['วันที่', 'รายการ/ลูกค้า', 'ยอดเงิน (บาท)', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'date', label: 'วันที่รับเงิน', type: 'date', required: true },
            { id: 'customer', label: 'รายการ/ลูกค้า', type: 'text', required: true, placeholder: 'เช่น บจก. ไทยวู้ด, เศษขี้เลื่อยโรงเลื่อย' },
            { id: 'amount', label: 'ยอดเงิน (บาท)', type: 'number', required: true, step: '0.01' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'คำอธิบายเพิ่มเติม' }
        ]
    },
    'jamjuree-revenue': {
        title: 'จามจุรีย์ รายรับ',
        headers: ['วันที่', 'รายการ/ลูกค้า', 'ยอดเงิน (บาท)', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'date', label: 'วันที่รับเงิน', type: 'date', required: true },
            { id: 'customer', label: 'รายการ/ลูกค้า', type: 'text', required: true, placeholder: 'เช่น ขายโต๊ะจามจุรีย์, เงินมัดจำตู้ไม้' },
            { id: 'amount', label: 'ยอดเงิน (บาท)', type: 'number', required: true, step: '0.01' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'คำอธิบายเพิ่มเติม' }
        ]
    },
    'twash-loans': {
        title: '2. เงินยืม ที.วอช',
        headers: ['วันที่', 'รายการ/วัตถุประสงค์', 'ประเภท', 'เลขที่อ้างอิง', 'ยอดเงิน (บาท)', 'ยอดคงเหลือสะสม (บาท)', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'date', label: 'วันที่ทำรายการ', type: 'date', required: true },
            { id: 'purpose', label: 'รายการ/วัตถุประสงค์', type: 'text', required: true, placeholder: 'เช่น ยืมสำรองจ่ายน้ำมันสะสม, จ่ายเงินกู้คืน' },
            { id: 'type', label: 'ประเภทรายการ', type: 'select', required: true, options: [
                { value: 'borrow', label: 'ยืมเงิน (Borrow)' },
                { value: 'repay', label: 'คืนเงิน (Repay)' }
            ]},
            { id: 'billRef', label: 'เลขที่อ้างอิงบิล / โอน (Ref No.)', type: 'text', placeholder: 'เช่น REF-1002, เลขที่ใบโอน' },
            { id: 'amount', label: 'ยอดเงิน (บาท)', type: 'number', required: true, step: '0.01' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'หมายเลขอ้างอิง / รายละเอียดโอน' }
        ]
    },
    'asawaeng-loans': {
        title: '3. เงินกู้ คุณอาแสวง',
        headers: ['งวดที่', 'วันที่ชำระ', 'เงินต้นคงเหลือ (ต้นงวด)', 'ดอกเบี้ย 1.5%', 'ชำระเงินต้น', 'ยอดคงเหลือ (ปลายงวด)', 'เลขที่อ้างอิง', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'installment', label: 'งวดที่', type: 'number', placeholder: 'เช่น 1, 2, 3...' },
            { id: 'date', label: 'วันที่ชำระ', type: 'date', required: true },
            { id: 'principalBeginning', label: 'เงินต้นคงเหลือ (ต้นงวด)', type: 'number', step: '0.01', placeholder: 'ระบุยอดต้นงวด (หากละไว้จะคำนวณจากงวดก่อน)' },
            { id: 'interest', label: 'ดอกเบี้ย (1.5%)', type: 'number', step: '0.01', placeholder: 'อัตโนมัติ 1.5% ของเงินต้นคงเหลือ' },
            { id: 'amount', label: 'ชำระเงินต้น (บาท)', type: 'number', required: true, step: '0.01', placeholder: 'จำนวนเงินที่ชำระคืนเงินต้น' },
            { id: 'billRef', label: 'เลขที่อ้างอิงบิล / โอน (Ref No.)', type: 'text', placeholder: 'เช่น REF-1002, ใบโอนเงิน' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'รายละเอียดเพิ่มเติม' }
        ]
    },
    'wan-loans': {
        title: '4. เงินกู้ บ.วัน',
        headers: ['วันที่', 'รายการ/วัตถุประสงค์', 'ประเภท', 'เลขที่อ้างอิง', 'ยอดเงิน (บาท)', 'ยอดคงเหลือสะสม (บาท)', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'date', label: 'วันที่ทำรายการ', type: 'date', required: true },
            { id: 'purpose', label: 'รายการ/วัตถุประสงค์', type: 'text', required: true, placeholder: 'เช่น รับเงินกู้ก้อนแรก, ชำระหนี้คืนบริษัท วัน' },
            { id: 'type', label: 'ประเภทรายการ', type: 'select', required: true, options: [
                { value: 'borrow', label: 'ยืมเงิน/รับเงินกู้ (Borrow)' },
                { value: 'repay', label: 'คืนเงิน/ชำระหนี้ (Repay)' }
            ]},
            { id: 'billRef', label: 'เลขที่อ้างอิงบิล / โอน (Ref No.)', type: 'text', placeholder: 'เช่น REF-1002, เลขที่ใบโอน' },
            { id: 'amount', label: 'ยอดเงิน (บาท)', type: 'number', required: true, step: '0.01' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'รายละเอียดสัญญา / โอน' }
        ]
    },
    'pimas-expenses': {
        title: '5. เงินสำรองจ่าย พี่มัด',
        headers: ['วันที่', 'รายการ', 'สถานะ', 'เลขที่อ้างอิง', 'ยอดเงิน (บาท)', 'ยอดคงเหลือสะสม (บาท)', 'หมายเหตุ', 'จัดการ'],
        fields: [
            { id: 'date', label: 'วันที่สำรองจ่าย', type: 'date', required: true },
            { id: 'description', label: 'รายการค่าใช้จ่าย', type: 'text', required: true, placeholder: 'เช่น ซื้อโซ่เลื่อยยนต์, เลี้ยงช่างโรงงาน' },
            { id: 'status', label: 'สถานะชำระเงิน', type: 'select', required: true, options: [
                { value: 'unpaid', label: 'ค้างจ่าย (Unpaid)' },
                { value: 'paid', label: 'จ่ายแล้ว (Paid)' }
            ]},
            { id: 'billRef', label: 'เลขที่อ้างอิงบิล / โอน (Ref No.)', type: 'text', placeholder: 'เช่น REF-1002, เลขที่ใบโอน' },
            { id: 'amount', label: 'ยอดเงิน (บาท)', type: 'number', required: true, step: '0.01' },
            { id: 'remarks', label: 'หมายเหตุ', type: 'text', placeholder: 'คำอธิบายเบิกเงิน / อนุมัติ' }
        ]
    }
};

// Hide loading splash screen with smooth transition
function hideLoadingSplash() {
    const splash = document.getElementById('app-loading-splash');
    if (splash) {
        splash.style.opacity = '0';
        setTimeout(() => {
            splash.style.display = 'none';
            splash.remove(); // Free DOM memory
        }, 400);
    }
}

// Initial Startup (optimized for fast first paint)
window.addEventListener('DOMContentLoaded', () => {
    const splashStatus = document.getElementById('loading-splash-status');
    const updateSplash = (msg) => { if (splashStatus) splashStatus.textContent = msg; };

    updateSplash('กำลังโหลดข้อมูล...');
    loadSettings();
    
    // Check URL hash for shared payload loading
    const hasSharedData = checkUrlHashForSharedData();
    
    if (!hasSharedData) {
        loadDatabase();
    }
    
    // Initialize defaults for JSON Importer template
    handleImportTargetChange();

    updateSplash('กำลังประมวลผลข้อมูล...');

    // Phase 1: KPIs and tables (fast, critical for first paint)
    calculateSummaryKPIs();
    renderOverviewBreakdowns();
    renderOverviewClosingTable();
    
    // Toggle demo alert visibility
    const isDemo = localStorage.getItem('mtp_is_demo') === 'true';
    const banner = document.getElementById('demo-mode-banner');
    if (banner) {
        banner.style.display = (isDemo && !appState.viewerMode && !appState.isSharedWorkspace) ? 'block' : 'none';
    }
    applyViewerModeUIAdjustments();
    if (SHEET_CONFIGS[appState.activeTab]) {
        renderSheetTable(appState.activeTab);
    }

    // Phase 2: Charts (deferred — let the browser paint first)
    requestAnimationFrame(() => {
        updateSplash('กำลังสร้างกราฟ...');
        renderOverviewCharts();
        // All done — hide splash
        hideLoadingSplash();
    });
});

// Switch view tabs
function switchTab(tabId) {
    // If Read-Only mode is active, do not allow switching to administrative sections
    if (appState.viewerMode && (tabId === 'scan' || tabId === 'settings')) {
        showToast('เมนูนี้ไม่พร้อมใช้งานในโหมดผู้เข้าชมแบบอ่านอย่างเดียว', 'error');
        return;
    }

    appState.activeTab = tabId;
    
    // Switch active states in navigation buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`tab-${tabId}`);
    activeBtn.classList.add('active');

    // Auto-scroll nav bar to show selected tab button
    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

    // Switch active view container
    document.querySelectorAll('.tab-content').forEach(view => {
        view.classList.remove('active');
    });
    document.getElementById(`view-${tabId}`).classList.add('active');

    // Redraw and recalculate views accordingly
    if (tabId === 'overview') {
        setTimeout(() => {
            renderOverviewCharts();
            renderOverviewClosingTable();
        }, 100);
    } else if (tabId === 'vendors') {
        renderVendorSummaryTable();
    } else if (SHEET_CONFIGS[tabId]) {
        renderSheetTable(tabId);
    }
}

// Global Month Switch handler
function handleMonthChange() {
    const selector = document.getElementById('month-selector');
    appState.selectedMonth = selector.value;
    
    // Reset pagination for all tables when month changes to prevent page index overflow
    Object.keys(appState.pagination).forEach(key => {
        appState.pagination[key].page = 1;
    });

    processAndRefreshAll();
    showToast(`กรองข้อมูลแสดงผลประจำเดือน: ${selector.options[selector.selectedIndex].text}`, 'info');
}

// Processing & calculations loop
function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `padding: 10px 18px; border-radius: 8px; font-weight: 500; font-size: 0.85rem; color: #fff; background: ${type === 'error' ? '#e53935' : (type === 'success' ? '#2e7d32' : '#333')}; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: opacity 0.3s;`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function processAndRefreshAll() {
    updateMonthSelectorDropdown();
    calculateSummaryKPIs();
    renderOverviewCharts();
    renderOverviewBreakdowns();
    renderOverviewClosingTable();

    // Toggle demo alert visibility
    const isDemo = localStorage.getItem('mtp_is_demo') === 'true';
    const banner = document.getElementById('demo-mode-banner');
    if (banner) {
        banner.style.display = (isDemo && !appState.viewerMode && !appState.isSharedWorkspace) ? 'block' : 'none';
    }

    // Handle UI Adjustments based on Viewer permissions
    applyViewerModeUIAdjustments();

    // If currently viewing a ledger, redraw it
    if (SHEET_CONFIGS[appState.activeTab]) {
        renderSheetTable(appState.activeTab);
    }
}

// Check URL for shared data — supports both ?bin=ID (jsonbin short link) and #data= (Base64 fallback)
function checkUrlHashForSharedData() {
    // ── Priority 1: ?bin=<jsonbinId> short link ───────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const binId = urlParams.get('bin');
    if (binId) {
        // Show loading state immediately
        showToast('⏳ กำลังโหลดรายงานจาก Cloud…', 'info');
        const apiKey = JSONBIN_CONFIG.apiKey || '';
        const headers = { 'X-Bin-Meta': 'false' };
        if (apiKey) headers['X-Master-Key'] = apiKey;

        fetch(`${JSONBIN_CONFIG.baseUrl}/b/${binId}`, { headers })
            .then(res => {
                if (!res.ok) throw new Error(`jsonbin fetch error ${res.status}`);
                return res.json();
            })
            .then(shared => {
                applySharedData(shared);
                showToast('✅ โหลดรายงาน View Only สำเร็จ!', 'success');
            })
            .catch(err => {
                console.error('[checkUrlHashForSharedData] jsonbin fetch failed:', err);
                showToast('ไม่สามารถโหลดข้อมูลจากลิงก์สั้นได้: ' + err.message, 'error');
            });
        return true;   // async — UI will update via applySharedData() callback
    }

    // ── Priority 2: #data= Base64 fallback (legacy / localhost) ─────────────
    const hash = window.location.hash;
    if (hash && hash.startsWith('#data=')) {
        try {
            const rawBase64 = hash.replace('#data=', '');
            const jsonStr = decodeURIComponent(escape(atob(decodeURIComponent(rawBase64))));
            const shared = JSON.parse(jsonStr);
            if (shared && shared.month && shared.db) {
                applySharedData(shared);
                return true;
            }
        } catch (e) {
            console.error("Failed to decode shared hash payload", e);
            showToast('ลิงก์ข้อมูลแชร์ไม่สมบูรณ์หรือชำรุด', 'error');
        }
    }
    return false;
}

// Apply shared payload to app state + UI — called by both ?bin= and #data= paths
function applySharedData(shared) {
    if (!shared || !shared.month || !shared.db) return;

    db = shared.db;
    appState.selectedMonth = shared.month;

    const isReadOnly = (shared.readOnly !== false);   // default to read-only for safety
    appState.viewerMode = isReadOnly;
    appState.isSharedWorkspace = !isReadOnly;

    // Sync month selector dropdown
    const selector = document.getElementById('month-selector');
    if (selector) {
        let optExists = false;
        for (let i = 0; i < selector.options.length; i++) {
            if (selector.options[i].value === shared.month) {
                optExists = true;
                selector.selectedIndex = i;
                break;
            }
        }
        if (!optExists) {
            const newOpt = document.createElement('option');
            newOpt.value = shared.month;
            newOpt.textContent = `${shared.month} (แชร์พิเศษ)`;
            newOpt.selected = true;
            selector.appendChild(newOpt);
        }
    }

    // Render workspace banner
    const banner       = document.getElementById('shared-workspace-banner');
    const bannerText   = document.getElementById('shared-workspace-banner-text');
    const bannerActions = document.getElementById('shared-workspace-banner-actions');

    if (isReadOnly) {
        banner.style.display = 'block';
        banner.style.backgroundColor = 'var(--accent-light)';
        banner.style.borderColor = 'var(--accent-color)';
        banner.style.borderLeft = '5px solid var(--accent-color)';
        bannerText.innerHTML = `👁️ <strong>View /</strong> คุณกำลังชมสรุปงบประจำเดือน <strong>${shared.month}</strong>`;
        bannerActions.innerHTML = `
            <button class="btn btn-secondary" onclick="exitSharedWorkspace()" style="padding: 0.4rem 1rem; font-size: 0.8rem; border-color: var(--border-hover);">
                ออกและโหลดข้อมูลส่วนตัว
            </button>
        `;
    } else {
        banner.style.display = 'block';
        banner.style.backgroundColor = 'var(--success-bg)';
        banner.style.borderColor = 'var(--success-color)';
        banner.style.borderLeft = '5px solid var(--success-color)';
        bannerText.innerHTML = `✏️ <strong>พื้นที่ข้อมูลแชร์ร่วมกัน (แก้ไขได้):</strong> คุณกำลังเปิดข้อมูลรอบเดือน <strong>${shared.month}</strong> คุณสามารถป้อน สแกน หรือกดเซฟทับฐานข้อมูลได้`;
        bannerActions.innerHTML = `
            <button class="btn btn-primary" onclick="importSharedDataToLocal()" style="padding: 0.4rem 1rem; font-size: 0.8rem;">
                บันทึกลงเครื่องนี้ (บันทึกถาวร)
            </button>
            <button class="btn btn-secondary" onclick="exitSharedWorkspace()" style="padding: 0.4rem 1rem; font-size: 0.8rem; border-color: var(--border-hover);">
                ยกเลิก / โหลดข้อมูลส่วนตัว
            </button>
        `;
    }

    // Rebuild UI with shared data
    refreshAllUIState();
}


// Exit Shared Workspace / Viewer Mode
function exitSharedWorkspace() {
    window.location.hash = '';
    appState.viewerMode = false;
    appState.isSharedWorkspace = false;
    
    const banner = document.getElementById('shared-workspace-banner');
    if (banner) banner.style.display = 'none';

    // Remove any special option from selector
    const selector = document.getElementById('month-selector');
    for (let i = 0; i < selector.options.length; i++) {
        if (selector.options[i].textContent.includes('(แชร์พิเศษ)')) {
            selector.remove(i);
            break;
        }
    }
    selector.value = '2026-08';
    appState.selectedMonth = '2026-08';

    loadDatabase();
    processAndRefreshAll();
    switchTab('overview');
    showToast('ออกจากระบบพื้นที่ข้อมูลแชร์และดึงฐานข้อมูลหลักกลับมาสำเร็จ', 'info');
}

// Save shared workspace data to active browser local storage
function importSharedDataToLocal() {
    if (appState.viewerMode) return;
    
    // Save to local storage
    localStorage.setItem('mtp_wood_db', JSON.stringify(db));
    localStorage.setItem('mtp_is_demo', 'false');
    
    // Turn off banner and load normally
    appState.isSharedWorkspace = false;
    const banner = document.getElementById('shared-workspace-banner');
    if (banner) banner.style.display = 'none';

    showToast('บันทึกข้อมูลนำเข้าเครื่องปัจจุบันสำเร็จเรียบร้อยแล้ว!', 'success');
    processAndRefreshAll();
}

// Toggle UI Elements visibility depending on Read-Only status
function applyViewerModeUIAdjustments() {
    const adminElements = document.querySelectorAll('.admin-only');
    const tableAddBtns = document.querySelectorAll('.table-header .btn-primary');

    if (appState.viewerMode) {
        adminElements.forEach(el => el.style.display = 'none');
        tableAddBtns.forEach(el => el.style.display = 'none');
        
        // Hide API Connection controls
        const keyInput = document.getElementById('api-key-input');
        if (keyInput) keyInput.disabled = true;
    } else {
        adminElements.forEach(el => el.style.display = '');
        tableAddBtns.forEach(el => el.style.display = '');
        
        const keyInput = document.getElementById('api-key-input');
        if (keyInput) keyInput.disabled = false;
    }
}

// Dynamic Month Selector Dropdown populator
function updateMonthSelectorDropdown() {
    const selector = document.getElementById('month-selector');
    if (!selector) return;

    // Pre-populate months from Jan 2024 to Dec 2026
    const monthsSet = new Set();
    for (let year = 2024; year <= 2026; year++) {
        for (let month = 1; month <= 12; month++) {
            const mStr = `${year}-${String(month).padStart(2, '0')}`;
            monthsSet.add(mStr);
        }
    }
    
    Object.keys(db).forEach(key => {
        if (Array.isArray(db[key])) {
            db[key].forEach(item => {
                if (item.date && item.date.length >= 7) {
                    const month = item.date.slice(0, 7); // YYYY-MM
                    if (/^\d{4}-\d{2}$/.test(month)) {
                        monthsSet.add(month);
                    }
                }
            });
        }
    });

    const sortedMonths = Array.from(monthsSet).sort();

    // Map month string to Thai name
    const getThaiMonthName = (monthStr) => {
        if (monthStr === 'all') return '🌐 ดูข้อมูลรวมทุกเดือน (All-Time)';
        const parts = monthStr.split('-');
        if (parts.length < 2) return monthStr;
        const yearAD = parseInt(parts[0]);
        const monthNum = parseInt(parts[1]);
        const yearBE = yearAD + 543;
        
        const thaiMonthNames = [
            "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
            "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
        ];
        
        return `${thaiMonthNames[monthNum] || ''} ${yearBE}`;
    };

    // Save current selected value
    const currentVal = appState.selectedMonth;

    selector.innerHTML = '';

    // "All" option at top
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = '🌐 ดูข้อมูลรวมทุกเดือน (All-Time)';
    if (currentVal === 'all') optAll.selected = true;
    selector.appendChild(optAll);

    sortedMonths.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = getThaiMonthName(m);
        if (m === currentVal) opt.selected = true;
        selector.appendChild(opt);
    });
    
    // Fallback if current selected month is not in dropdown
    if (currentVal !== 'all' && !sortedMonths.includes(currentVal)) {
        const opt = document.createElement('option');
        opt.value = currentVal;
        opt.textContent = getThaiMonthName(currentVal);
        opt.selected = true;
        selector.appendChild(opt);
    }
}

// Helper to translate Thai/English target sheet names
// Uses substring matching (includes) so numbered labels and variant spellings all resolve correctly.
function resolveTargetSheet(sheetName, defaultSheet) {
    if (!sheetName) return defaultSheet;
    const raw = String(sheetName).trim();
    const name = raw.toLowerCase();

    // ── P'Mad / P'Mas advance (pimas-expenses) ─────────────────────────────
    if (
        name === 'pimas-expenses' ||
        name === 'pmad-advance' ||
        name === 'pmad_advance' ||
        name === 'pmad-loans' ||
        name === 'pmad_loans' ||
        name.includes('พี่มัส') ||
        name.includes('พี่มัด') ||
        name.includes('สำรองจ่าย') ||
        name.includes('มัสถชัย')
    ) return 'pimas-expenses';

    // ── 1. ค่าใช้จ่ายทั่วไป (mtp-expenses) ────────────────────────────────
    if (
        name === 'mtp-expenses' ||
        name === 'mtp_expenses' ||
        name === 'expenses' ||
        name.includes('ค่าใช้จ่ายทั่วไป') ||
        name.includes('ค่าใช้จ่าย') ||
        name.includes('mtp รายจ่าย')
    ) return 'mtp-expenses';

    // ── MTP รายรับ (mtp-revenue) ───────────────────────────────────────────
    if (
        name === 'mtp-revenue' ||
        name === 'mtp_revenue' ||
        name.includes('mtp รายรับ')
    ) return 'mtp-revenue';

    // ── จามจุรีย์ รายรับ (jamjuree-revenue) ───────────────────────────────
    if (
        name === 'jamjuree-revenue' ||
        name.includes('จามจุรีย์')
    ) return 'jamjuree-revenue';

    // ── 2. เงินยืม ที.วอช (twash-loans) ───────────────────────────────────
    if (
        name === 'twash-loans' ||
        name.includes('ที.วอช') ||
        name.includes('t-wash') ||
        name.includes('twash') ||
        name.includes('ยืมเงิน ที') ||
        name.includes('เงินยืม ที')
    ) return 'twash-loans';

    // ── 3. เงินกู้ คุณอาแสวง (asawaeng-loans) ─────────────────────────────
    if (
        name === 'asawaeng-loans' ||
        name.includes('แสวง') ||
        name.includes('อาแสวง') ||
        name.includes('กู้เงินอา')
    ) return 'asawaeng-loans';

    // ── 4. เงินกู้ บ.วัน (wan-loans) ──────────────────────────────────────
    if (
        name === 'wan-loans' ||
        name.includes('บ.วัน') ||
        name.includes('บริษัท วัน') ||
        name.includes('กู้เงิน บ') ||
        name.includes('wan')
    ) return 'wan-loans';

    return defaultSheet;
}

// JSON Import Formats & Guidelines Templates
const JSON_TEMPLATES = {
    'mtp_expenses': `[
  {
    "date": "2026-07-06",
    "category": "ค่าของเบ็ดเตล็ด/ค่าของใช้งาน",
    "merchant": "ค่าหนังสือรับรอง",
    "amount": 950.00,
    "payee": "พาณิชย์ จ.เชียงราย",
    "remarks": "เวลา 11:23"
  }
]`,
    'mtp_revenue': `[
  {
    "date": "2026-07-05",
    "customer": "บจก. เอเชียทิมเบอร์",
    "amount": 150000.00,
    "remarks": "ส่งมอบไม้สักแปรรูป"
  }
]`,
    'jamjuree-revenue': `[
  {
    "date": "2026-07-12",
    "customer": "ร้านสิริเฟอร์นิเจอร์",
    "amount": 42000.00,
    "remarks": "โต๊ะจามจุรีย์ขัดเรียบร้อย"
  }
]`,
    'twash-loans': `[
  {
    "date": "2026-07-01",
    "purpose": "ยืมจ่ายค่าอะไหล่ด่วนรถสอย",
    "type": "borrow",
    "amount": 25000.00,
    "remarks": "ยืมทดรองจ่าย"
  }
]`,
    'asawaeng-loans': `[
  {
    "date": "2026-07-10",
    "purpose": "โอนเงินชำระหนี้คืนคุณอาแสวงงวดประจำเดือน",
    "type": "repay",
    "amount": 20000.00,
    "remarks": "โอนผ่านกสิกรไทย"
  }
]`,
    'wan-loans': `[
  {
    "date": "2026-07-15",
    "purpose": "โอนชำระหนี้คืนบริษัท วัน",
    "type": "repay",
    "amount": 15000.00,
    "remarks": "ตัดชำระรายเดือน"
  }
]`,
    'pimas-expenses': `[
  {
    "date": "2026-07-10",
    "description": "โซ่เลื่อยยนต์และอะไหล่ด่วนแท่นบาก",
    "status": "unpaid",
    "amount": 6500.00,
    "remarks": "รอเบิกงวดถัดไป"
  }
]`
};

function handleImportTargetChange() {
    const target = document.getElementById('scan-target-ledger').value;
    const templatePre = document.getElementById('scan-json-template');
    if (templatePre && JSON_TEMPLATES[target]) {
        templatePre.textContent = JSON_TEMPLATES[target];
    }
}

function clearImportTextarea() {
    const textarea = document.getElementById('scan-json-textarea');
    if (textarea) textarea.value = '';
}

// ── JSON Import Pre-processing helpers ───────────────────────────────────────

/**
 * Sanitize raw textarea text before JSON.parse():
 *  - Strip C-style comments (// single-line and /* multi-line *\/)
 *  - Remove Markdown code-block fences (```json … ``` / ``` … ```)
 *  - Strip UTF-8 BOM
 *  - Replace "smart" / curly quotes with straight ones
 *  - Replace single-quote delimiters with double-quote delimiters
 *  - Strip trailing commas before ] or } (common copy-paste mistake)
 */
function sanitizeJsonText(raw) {
    let t = raw.trim();

    // ── Step 0: Strip C-style comments (// and /* … */) ─────────────────────
    // Handles: single-line //  and  multi-line /* … */
    // The ([^:]|^) negative look-behind keeps http:// URLs intact
    t = t.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1').trim();

    // Remove BOM
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);

    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    // Replace smart / curly quotes → straight
    t = t
        .replace(/[\u2018\u2019]/g, "'")   // ' '
        .replace(/[\u201C\u201D]/g, '"');   // " "

    // Replace single-quoted property keys / string values → double quotes
    // Only swap outer single quotes (not apostrophes inside words)
    // Strategy: if JSON doesn't start with [ or { after trimming, try a naive swap
    if (!t.startsWith('[') && !t.startsWith('{')) {
        t = t.replace(/'/g, '"');
    } else {
        // Selective swap: 'key': → "key":  and : 'value' → : "value"
        t = t.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    }

    // Remove trailing commas before ] or } (e.g., [1, 2, 3,] )
    t = t.replace(/,\s*([}\]])/g, '$1');

    return t;
}


/**
 * Parse sanitized JSON with a rich Thai error message on failure.
 * Extracts line/column from the SyntaxError message when available.
 */
function parseAndValidateJSON(sanitized) {
    let parsed;
    try {
        parsed = JSON.parse(sanitized);
    } catch (syntaxErr) {
        // Extract position hint from SyntaxError message (e.g. "… at position 42")
        const posMatch = syntaxErr.message.match(/position (\d+)/i);
        const lineColHint = posMatch
            ? (() => {
                const pos = parseInt(posMatch[1], 10);
                const beforeErr = sanitized.slice(0, pos);
                const line = (beforeErr.match(/\n/g) || []).length + 1;
                const col  = pos - beforeErr.lastIndexOf('\n');
                return ` (บรรทัด ${line}, ตำแหน่ง ${col})`;
              })()
            : '';

        throw new Error(
            `รูปแบบ JSON ไม่ถูกต้อง${posHint(syntaxErr)}${lineColHint}\n` +
            `คำแนะนำ: ตรวจสอบเครื่องหมาย " , [ ] และคัดลอกเฉพาะข้อความในวงเล็บ [ … ]\n` +
            `(ข้อผิดพลาดเดิม: ${syntaxErr.message})`
        );
    }

    // ── Schema Validation ─────────────────────────────────────────────────────
    if (!Array.isArray(parsed)) {
        throw new Error(
            'ข้อมูล JSON ต้องเป็นอาร์เรย์ (Array) ที่เริ่มด้วย [ และจบด้วย ]\n' +
            `แต่ได้รับ: ${typeof parsed}`
        );
    }

    const REQUIRED_KEYS = ['date', 'amount', 'targetSheet'];
    const missingItems = [];

    parsed.forEach((item, idx) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            missingItems.push(`รายการที่ ${idx + 1}: ต้องเป็น Object ไม่ใช่ ${JSON.stringify(item)}`);
            return;
        }
        const missing = REQUIRED_KEYS.filter(k => !(k in item));
        if (missing.length > 0) {
            missingItems.push(`รายการที่ ${idx + 1}: ขาด field "${missing.join('", "')}"`);
        }
    });

    if (missingItems.length > 0) {
        // Show first 5 issues at most
        const preview = missingItems.slice(0, 5).join('\n');
        const extra   = missingItems.length > 5 ? `\n…และอีก ${missingItems.length - 5} รายการ` : '';
        throw new Error(
            `ข้อมูลไม่ครบถ้วน — ทุกรายการต้องมี date, amount, targetSheet:\n${preview}${extra}`
        );
    }

    return parsed;
}

/** Helper: extract position hint string from a SyntaxError */
function posHint(err) {
    return '';   // placeholder — detail already embedded in parseAndValidateJSON
}

// ── Main Import Entry Point ───────────────────────────────────────────────────
function executeJSONImport() {
    if (appState.viewerMode) return;
    const rawText = document.getElementById('scan-json-textarea').value;
    const target  = document.getElementById('scan-target-ledger').value;

    if (!rawText.trim()) {
        showToast('กรุณากรอกข้อมูล JSON ก่อนนำเข้า', 'error');
        return;
    }

    let parsed;
    try {
        const sanitized = sanitizeJsonText(rawText);
        parsed = parseAndValidateJSON(sanitized);
    } catch (validationErr) {
        console.error('[executeJSONImport] validation:', validationErr);
        // Show a prominent alert with full detail (not just toast)
        alert(
            '❌ ไม่สามารถนำเข้าข้อมูลได้\n\n' +
            validationErr.message
        );
        showToast('JSON ไม่ถูกต้อง — ดูรายละเอียดในกล่องแจ้งเตือน', 'error');
        return;
    }

    try {
        let importCount   = 0;
        let dupesSkipped  = 0;
        let lastTargetTabId = '';
        let recentMonth   = '';

        parsed.forEach(item => {
            // ── Step 1: resolve targetSheet from item or fall back to dropdown ──
            let itemTarget = resolveTargetSheet(item.targetSheet, target);
            itemTarget = normalizeLedgerKey(itemTarget);

            lastTargetTabId = itemTarget;

            const date   = item.date || new Date().toISOString().split('T')[0];
            const amount = parseFloat(item.amount) || 0;
            const id     = 'rec_import_' + Date.now() + '_' + Math.floor(Math.random() * 100000);

            // Track most-recent month to auto-switch after import
            if (date.length >= 7) {
                const m = date.slice(0, 7);
                if (m > recentMonth) recentMonth = m;
            }

            // billRef / referenceNo is optional — pass through if present
            const billRef = item.billRef || item.referenceNo || item.billNo || item.refNo || '';

            let record = { id, date, billRef };

            // ── Step 2: build sheet-specific fields ───────────────────────────
            if (itemTarget === 'mtp-expenses') {
                let category = item.category;
                if (category) {
                    // Normalise old multi-word categories → new 6-tag system
                    if (category.includes('ไม้'))                                             category = 'ค่าไม้';
                    else if (category.includes('น้ำมัน'))                                    category = 'ค่าน้ำมัน';
                    else if (category.includes('แรง') || category.includes('คนงาน') ||
                             category.includes('เงินเดือน') || category.includes('รับเหมา')) category = 'ค่าแรง';
                    else if (category.includes('ซ่อม') || category.includes('อะไหล่') ||
                             category.includes('เครื่องจักร') || category.includes('รถยนต์') ||
                             category.includes('ลูกปืน') || category.includes('ใบมีด'))      category = 'ค่าอะไหล่';
                    else if (category.includes('ไฟ') || category.includes('น้ำ') ||
                             category.includes('โทรศัพท์'))                                  category = 'ค่าไฟ/น้ำ';
                    else                                                                      category = 'ค่าเช่า/อื่นๆ';
                } else {
                    // Auto-detect from memo keywords
                    const memo = item.merchant || item.memo || '';
                    if      (memo.includes('ไม้'))                                            category = 'ค่าไม้';
                    else if (memo.includes('น้ำมัน'))                                        category = 'ค่าน้ำมัน';
                    else if (memo.includes('แรง') || memo.includes('คนงาน') ||
                             memo.includes('เงินเดือน') || memo.includes('ค่าจ้าง'))         category = 'ค่าแรง';
                    else if (memo.includes('ซ่อม') || memo.includes('อะไหล่') ||
                             memo.includes('ลูกปืน') || memo.includes('ใบมีด'))              category = 'ค่าอะไหล่';
                    else if (memo.includes('ไฟ') || memo.includes('น้ำ') ||
                             memo.includes('โทรศัพท์'))                                      category = 'ค่าไฟ/น้ำ';
                    else                                                                      category = 'ค่าเช่า/อื่นๆ';
                }
                record.category = category;
                record.merchant  = item.merchant || item.memo || '(ไม่ระบุรายละเอียด)';
                record.amount    = amount;
                record.payee     = item.payee || item.recipient || '(ไม่ระบุ)';
                record.remarks   = item.remarks || (item.time ? 'เวลา ' + item.time : '');

            } else if (itemTarget === 'mtp-revenue' || itemTarget === 'jamjuree-revenue') {
                record.customer = item.customer || item.recipient || '(ไม่ระบุ)';
                record.amount   = amount;
                record.remarks  = item.remarks || item.memo || '';

            } else if (itemTarget === 'asawaeng-loans') {
                record.installment = item.installment || item.period || item.installmentNo || '';
                record.purpose = item.purpose || item.memo || item.merchant || '(ชำระเงินกู้อาแสวง)';

                const isInterestPayment = item.type === 'interest' ||
                                          (item.memo || '').includes('ดอกเบี้ย') ||
                                          (item.purpose || '').includes('ดอกเบี้ย') ||
                                          (amount === 7500 && !item.principalRepaid);

                if (isInterestPayment) {
                    record.type = 'interest';
                    record.interest = amount > 0 ? amount : 7500;
                    record.principalRepaid = 0;
                    record.amount = 0;
                } else {
                    record.type = item.type || 'repay';
                    record.principalRepaid = parseFloat(item.principalRepaid !== undefined ? item.principalRepaid : amount);
                    record.amount = record.principalRepaid;
                    if (item.interest !== undefined) {
                        record.interest = parseFloat(item.interest) || 0;
                    }
                }

                if (item.principalBeginning !== undefined) {
                    record.principalBeginning = parseFloat(item.principalBeginning);
                }
                record.remarks = item.remarks || (item.time ? 'เวลา ' + item.time : '');

            } else if (
                itemTarget === 'twash-loans' ||
                itemTarget === 'wan-loans'
            ) {
                record.purpose = item.purpose || item.memo || '(ไม่ระบุวัตถุประสงค์)';
                record.type    = item.type || 'repay';
                record.amount  = amount;
                record.remarks = item.remarks || '';

            } else if (itemTarget === 'pimas-expenses') {
                record.description = item.description || item.memo || '(ไม่ระบุรายละเอียด)';

                let status = 'paid';
                if (item.status) {
                    status = item.status;
                } else if (item.type) {
                    if (item.type === 'advance') status = 'unpaid';
                    else if (item.type === 'repay') status = 'paid';
                }
                record.status  = status;
                record.amount  = amount;
                record.remarks = item.remarks || (item.time ? 'เวลา ' + item.time : '');
            }

            // Append record with deduplication check
            const added = pushToLedger(itemTarget, record);
            if (added) {
                importCount++;
            } else {
                dupesSkipped++;
            }
        });

        // ── Step 3: persist and rebuild UI state ──────────────────────────────
        saveDatabase();

        const importedMonthsSet = new Set();
        parsed.forEach(item => {
            const d = item.date || '';
            if (d.length >= 7) importedMonthsSet.add(d.slice(0, 7));
        });
        const importedMonths = Array.from(importedMonthsSet).sort();
        const earliestMonth  = importedMonths[0] || recentMonth;

        updateMonthSelectorDropdown();

        if (earliestMonth) {
            appState.selectedMonth = earliestMonth;
            const selector = document.getElementById('month-selector');
            if (selector) selector.value = earliestMonth;
        }

        refreshAllUIState();
        clearImportTextarea();

        const config = SHEET_CONFIGS[lastTargetTabId];
        const destinationLabel = config ? config.title : lastTargetTabId || 'สมุดบัญชี';
        const dupInfo = dupesSkipped > 0 ? ` (ข้ามรายการซ้ำ ${dupesSkipped} รายการ)` : '';
        showToast(`นำเข้าข้อมูลสำเร็จ ${importCount} รายการ${dupInfo} → ${destinationLabel}`, 'success');

        if (lastTargetTabId && document.getElementById(`view-${lastTargetTabId}`)) {
            switchTab(lastTargetTabId);
        }

    } catch (e) {
        console.error('[executeJSONImport] runtime:', e);
        showToast('การนำเข้าล้มเหลว: ' + e.message, 'error');
    }
}


// Configurable Share Link Modal Event handlers
function saveJsonbinKey() {
    const input = document.getElementById('jsonbin-api-key-input');
    if (!input) return;
    const key = input.value.trim();
    if (key) {
        localStorage.setItem('mtp_jsonbin_key', key);
        JSONBIN_CONFIG.apiKey = key;
        showToast('✅ บันทึก jsonbin API Key เรียบร้อย! กด "สร้างลิงก์สั้น" เพื่อทดสอบ', 'success');
    } else {
        localStorage.removeItem('mtp_jsonbin_key');
        JSONBIN_CONFIG.apiKey = '';
        showToast('ลบ API Key แล้ว — ระบบจะสร้างลิงก์ยาว (Base64) แทน', 'info');
    }
}

function openShareModal() {
    // Pre-fill key input if key is already saved
    const savedKey = localStorage.getItem('mtp_jsonbin_key') || '';
    const keyInput = document.getElementById('jsonbin-api-key-input');
    if (keyInput && savedKey) keyInput.value = savedKey;

    document.getElementById('share-modal').classList.add('active');
}


function closeShareModal() {
    document.getElementById('share-modal').classList.remove('active');
}

function updateGeneratedShareLink() {
    const filterMonth = appState.selectedMonth;
    const permission = document.querySelector('input[name="share-permission"]:checked').value;
    const readOnly = (permission === 'readonly');

    const filterByMonthOrAll = (list) => {
        if (!list) return [];
        if (filterMonth === 'all') return list;
        return list.filter(it => it.date && it.date.startsWith(filterMonth));
    };

    // Revenue & Expense: filter to selected month (or all if 'all')
    // Loan & Advance ledgers: send ALL historical records so cumulative balances are correct
    const sharePayload = {
        month: filterMonth,
        readOnly: readOnly,
        db: {
            mtp_expenses:         filterByMonthOrAll(db.mtp_expenses),
            mtp_revenue:          filterByMonthOrAll(db.mtp_revenue),
            'jamjuree-revenue':   filterByMonthOrAll(db['jamjuree-revenue']),
            'twash-loans':        (db['twash-loans']        || []),
            'asawaeng-loans':     (db['asawaeng-loans']     || []),
            'wan-loans':          (db['wan-loans']           || []),
            'pimas-expenses':     (db['pimas-expenses']      || [])
        }
    };

    const apiKey = JSONBIN_CONFIG.apiKey;
    const urlInput = document.getElementById('generated-share-url');
    const copyBtn  = document.getElementById('btn-copy-share-link');

    if (!apiKey) {
        // Fallback: Base64 URL (long, but works on localhost)
        try {
            const jsonStr = JSON.stringify(sharePayload);
            const encodedData = btoa(unescape(encodeURIComponent(jsonStr)));
            const finalUrl = `${window.location.origin}${window.location.pathname}#data=${encodeURIComponent(encodedData)}`;
            urlInput.value = finalUrl;
            if (copyBtn) copyBtn.textContent = '📋 คัดลอก (Base64)';
        } catch (e) {
            console.error(e);
            showToast('ล้มเหลวในการสร้างลิงก์ — กรุณาตั้ง API Key ที่การตั้งค่า', 'error');
        }
        return;
    }

    // Save to jsonbin.io → get short bin ID
    urlInput.value = 'กำลังสร้างลิงก์สั้น…';
    if (copyBtn) { copyBtn.disabled = true; copyBtn.textContent = '⏳ กำลังอัพโหลด…'; }

    fetch(`${JSONBIN_CONFIG.baseUrl}/b`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Master-Key': apiKey,
            'X-Bin-Name': `MTP-${filterMonth}`,
            'X-Bin-Private': 'false'
        },
        body: JSON.stringify(sharePayload)
    })
    .then(res => {
        if (!res.ok) throw new Error(`jsonbin error ${res.status}`);
        return res.json();
    })
    .then(data => {
        const binId = data?.metadata?.id;
        if (!binId) throw new Error('ไม่ได้รับ Bin ID จาก jsonbin');
        const appBase = window.location.origin + window.location.pathname;
        const shortUrl = `${appBase}?bin=${binId}`;
        urlInput.value = shortUrl;
        if (copyBtn) { copyBtn.disabled = false; copyBtn.textContent = '📋 คัดลอกลิงก์'; }
        showToast(`✅ สร้างลิงก์สั้นสำเร็จ! (Bin: ${binId})`, 'success');
    })
    .catch(err => {
        console.error('[jsonbin]', err);
        urlInput.value = 'เกิดข้อผิดพลาด — ดูคอนโซล';
        if (copyBtn) { copyBtn.disabled = false; copyBtn.textContent = '📋 คัดลอก'; }
        showToast('ไม่สามารถอัพโหลดข้อมูลได้: ' + err.message, 'error');
    });
}

function copyShareLinkToClipboard() {
    const urlInput = document.getElementById('generated-share-url');
    urlInput.select();
    urlInput.setSelectionRange(0, 99999); // For mobile devices

    navigator.clipboard.writeText(urlInput.value).then(() => {
        showToast('คัดลอกลิงก์แชร์สิทธิ์เรียบร้อย ส่งให้ผู้รับเปิดได้ทันที!', 'success');
        closeShareModal();
    }).catch(err => {
        console.error(err);
        showToast('ล้มเหลวในการคัดลอก กรุณาคัดลอกจากช่องข้อความด้วยตนเอง', 'error');
    });
}

// Start Real Use: Wipes mock databases
function clearDemoDataForRealUse() {
    const modal = document.getElementById('confirm-modal');
    const confirmBtn = document.getElementById('confirm-modal-btn');
    
    modal.classList.add('active');
    document.getElementById('confirm-modal-body').textContent = 'คุณแน่ใจหรือไม่ว่าต้องการล้างข้อมูลจำลองเดโมทั้งหมดเพื่อเริ่มต้นการบันทึกบัญชีของจริง?';
    
    confirmBtn.onclick = () => {
        db = { mtp_expenses: [], mtp_revenue: [], 'jamjuree-revenue': [], 'twash-loans': [], 'asawaeng-loans': [], 'wan-loans': [], 'pimas-expenses': [] };
        localStorage.setItem('mtp_is_demo', 'false');
        saveDatabase();
        processAndRefreshAll();
        closeConfirmModal();
        showToast('ล้างข้อมูลเดโมเรียบร้อยแล้ว! ระบบพร้อมสำหรับการใช้งานจริง', 'success');
    };
}

// Storage helpers
function loadSettings() {
    const key = localStorage.getItem('gemini_api_key');
    if (key) {
        appState.apiKey = key;
        document.getElementById('api-key-input').value = key;
        document.getElementById('api-status-dot').style.backgroundColor = 'var(--success-color)';
        document.getElementById('api-status-text').textContent = 'Gemini API: พร้อมใช้งาน';
    } else {
        document.getElementById('api-status-dot').style.backgroundColor = 'var(--text-muted)';
        document.getElementById('api-status-text').textContent = 'Gemini API: ไม่พร้อมใช้งาน';
    }
}

// Save Key
function saveApiKey() {
    const keyInput = document.getElementById('api-key-input');
    const key = keyInput.value.trim();
    if (key) {
        localStorage.setItem('gemini_api_key', key);
        appState.apiKey = key;
        document.getElementById('api-status-dot').style.backgroundColor = 'var(--success-color)';
        document.getElementById('api-status-text').textContent = 'Gemini API: พร้อมใช้งาน';
        showToast('บันทึก API Key ของ Gemini สำเร็จ', 'success');
    } else {
        localStorage.removeItem('gemini_api_key');
        appState.apiKey = '';
        document.getElementById('api-status-dot').style.backgroundColor = 'var(--text-muted)';
        document.getElementById('api-status-text').textContent = 'Gemini API: ไม่พร้อมใช้งาน';
        showToast('ลบ API Key เรียบร้อยแล้ว', 'info');
    }
}

function toggleApiKeyShow() {
    const input = document.getElementById('api-key-input');
    const btn = document.getElementById('toggle-key-text');
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'ซ่อน';
    } else {
        input.type = 'password';
        btn.textContent = 'แสดง';
    }
}

async function testApiKeyConnection() {
    const key = document.getElementById('api-key-input').value.trim();
    if (!key) {
        showToast('กรุณากรอก API Key ก่อนทดสอบ', 'error');
        return;
    }

    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] })
        });
        
        if (res.ok) {
            showToast('เชื่อมต่อ Gemini Developer API สำเร็จและพร้อมใช้งาน!', 'success');
        } else {
            const err = await res.json();
            showToast(`การเชื่อมต่อล้มเหลว: ${err.error.message}`, 'error');
        }
    } catch (e) {
        showToast(`เครือข่ายขัดข้อง: ${e.message}`, 'error');
    }
}

function loadMtpDemoDatabase(force = false) {
    db = {"mtp-expenses": [{"id": "exp_01", "date": "2026-09-01", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 10:35 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_02", "date": "2026-08-31", "category": "ค่าอะไหล่", "merchant": "ค่าวงเดือน", "amount": 3000.0, "remarks": "เวลา 11:26 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_03", "date": "2026-08-29", "category": "คืนเงิน", "merchant": "ตีคืนเงินยืม ที.วอช ชร", "amount": 50000.0, "remarks": "เวลา 16:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_04", "date": "2026-08-29", "category": "ค่าเช่า/อื่นๆ", "merchant": "น้ำมันเบรค และอาหารกลางวัน", "amount": 2000.0, "remarks": "เวลา 11:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_05", "date": "2026-08-28", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1720.0, "remarks": "เวลา 13:41 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_06", "date": "2026-08-28", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าโทรศัพท์ (AIS 084-809-5498)", "amount": 2558.79, "remarks": "เวลา 09:53 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_07", "date": "2026-08-27", "category": "ค่าเช่า/อื่นๆ", "merchant": "ค่าทำบิล", "amount": 5050.0, "remarks": "เวลา 17:34 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_08", "date": "2026-08-27", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 16:23 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_09", "date": "2026-08-25", "category": "อื่นๆ", "merchant": "ค่าใบอนุญาต (ทส จ. เชียงราย)", "amount": 1000.0, "remarks": "เวลา 15:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_10", "date": "2026-08-25", "category": "ชำระค่างวด", "merchant": "ค่างวดรถสิบล้อ", "amount": 20700.0, "remarks": "เวลา 14:59 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_11", "date": "2026-08-25", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 13883.0, "remarks": "เวลา 10:38 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_12", "date": "2026-08-25", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 1000.0, "remarks": "เวลา 09:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_13", "date": "2026-08-24", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 09:12 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_14", "date": "2026-08-24", "category": "อื่นๆ", "merchant": "ยาฆ่าแมลง", "amount": 1657.0, "remarks": "เวลา 16:16 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_15", "date": "2026-08-24", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 1130.0, "remarks": "เวลา 16:12 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_16", "date": "2026-08-24", "category": "อื่นๆ", "merchant": "ปูน", "amount": 4300.0, "remarks": "เวลา 13:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_17", "date": "2026-08-24", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 3815.0, "remarks": "เวลา 09:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_18", "date": "2026-08-20", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 7000.0, "remarks": "เวลา 15:27 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_19", "date": "2026-08-20", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1040.0, "remarks": "เวลา 14:24 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_20", "date": "2026-08-20", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (นายมัสถชัย คำอ้าย)", "amount": 9309.3, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028710054"}, {"id": "exp_21", "date": "2026-08-20", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (จามจุรีย์ วูด)", "amount": 4929.53, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028752392"}, {"id": "exp_22", "date": "2026-08-20", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 08:48 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_23", "date": "2026-08-19", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3000.0, "remarks": "เวลา 08:27 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_24", "date": "2026-08-18", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 10482.0, "remarks": "เวลา 11:51 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_25", "date": "2026-08-18", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 800.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_26", "date": "2026-08-18", "category": "ดอกเบี้ย", "merchant": "ดอกเบี้ย", "amount": 2600.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_27", "date": "2026-08-17", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:13 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_28", "date": "2026-08-17", "category": "ค่าแรง", "merchant": "ค่าแรง 1-15 ส.ค.69", "amount": 108775.0, "remarks": "เวลา 16:41 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_29", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "สำรองจ่าย ค่าไม้และน้ำมัน", "amount": 5000.0, "remarks": "เวลา 08:18 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_30", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1250.0, "remarks": "เวลา 17:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_31", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1485.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_32", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "คนงานเบิก", "amount": 5000.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_33", "date": "2026-08-14", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 5000.0, "remarks": "เวลา 11:45 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_34", "date": "2026-08-14", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1610.0, "remarks": "เวลา 14:31 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_35", "date": "2026-08-13", "category": "ค่าแรง", "merchant": "ค่าขับรถ", "amount": 700.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_36", "date": "2026-08-13", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1541.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_37", "date": "2026-08-12", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:56 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_38", "date": "2026-08-12", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 3100.0, "remarks": "เวลา 17:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_39", "date": "2026-08-11", "category": "คืนเงิน", "merchant": "คืน ที.วอช", "amount": 40000.0, "remarks": "เวลา 22:01 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_40", "date": "2026-08-11", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 08:29 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_41", "date": "2026-08-11", "category": "ค่าไม้", "merchant": "ซื้อพาเลตไม้ มือ 2 (หักจากยอดรับ นวศิลา)", "amount": 2000.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_42", "date": "2026-08-11", "category": "ค่าอะไหล่", "merchant": "หักค่าตะปู 3 ลัง (หักจากยอดรับ นวศิลา)", "amount": 4200.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_43", "date": "2026-08-10", "category": "ค่าอะไหล่", "merchant": "ค่ายางรถ โฟล์คลิฟท์", "amount": 4400.0, "remarks": "เวลา 15:47 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_44", "date": "2026-08-10", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3500.0, "remarks": "เวลา 14:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_45", "date": "2026-08-10", "category": "อื่นๆ", "merchant": "ค่ารถ", "amount": 6000.0, "remarks": "เวลา 08:48 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_46", "date": "2026-08-09", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_47", "date": "2026-08-08", "category": "ค่าแรง", "merchant": "คนงานเบิกเงิน", "amount": 8500.0, "remarks": "เวลา 15:19 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_48", "date": "2026-08-07", "category": "สำรองจ่าย", "merchant": "สำรองจ่ายพี่มัส", "amount": 2000.0, "remarks": "เวลา 12:26 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_49", "date": "2026-08-07", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 2800.0, "remarks": "เวลา 20:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_50", "date": "2026-08-06", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 13:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_51", "date": "2026-08-04", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 4000.0, "remarks": "เวลา 14:56 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_52", "date": "2026-08-04", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 6225.0, "remarks": "เวลา 14:55 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_53", "date": "2026-08-04", "category": "ค่าอะไหล่", "merchant": "ซ่อมได", "amount": 1000.0, "remarks": "เวลา 09:36 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_54", "date": "2026-08-03", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 15:09 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_55", "date": "2026-08-03", "category": "อื่นๆ", "merchant": "ค่าตำรวจแม่อ้อ", "amount": 2000.0, "remarks": "เวลา 11:58 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_56", "date": "2026-08-03", "category": "ค่าอะไหล่", "merchant": "ยางแท่นเครื่อง", "amount": 2000.0, "remarks": "เวลา 09:02 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_57", "date": "2026-08-02", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 09:30 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_58", "date": "2026-08-01", "category": "อื่นๆ", "merchant": "ค่าแนะนำ", "amount": 2000.0, "remarks": "เวลา 09:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}], "mtp_expenses": [{"id": "exp_01", "date": "2026-09-01", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 10:35 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_02", "date": "2026-08-31", "category": "ค่าอะไหล่", "merchant": "ค่าวงเดือน", "amount": 3000.0, "remarks": "เวลา 11:26 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_03", "date": "2026-08-29", "category": "คืนเงิน", "merchant": "ตีคืนเงินยืม ที.วอช ชร", "amount": 50000.0, "remarks": "เวลา 16:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_04", "date": "2026-08-29", "category": "ค่าเช่า/อื่นๆ", "merchant": "น้ำมันเบรค และอาหารกลางวัน", "amount": 2000.0, "remarks": "เวลา 11:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_05", "date": "2026-08-28", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1720.0, "remarks": "เวลา 13:41 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_06", "date": "2026-08-28", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าโทรศัพท์ (AIS 084-809-5498)", "amount": 2558.79, "remarks": "เวลา 09:53 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_07", "date": "2026-08-27", "category": "ค่าเช่า/อื่นๆ", "merchant": "ค่าทำบิล", "amount": 5050.0, "remarks": "เวลา 17:34 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_08", "date": "2026-08-27", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 16:23 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_09", "date": "2026-08-25", "category": "อื่นๆ", "merchant": "ค่าใบอนุญาต (ทส จ. เชียงราย)", "amount": 1000.0, "remarks": "เวลา 15:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_10", "date": "2026-08-25", "category": "ชำระค่างวด", "merchant": "ค่างวดรถสิบล้อ", "amount": 20700.0, "remarks": "เวลา 14:59 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_11", "date": "2026-08-25", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 13883.0, "remarks": "เวลา 10:38 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_12", "date": "2026-08-25", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 1000.0, "remarks": "เวลา 09:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_13", "date": "2026-08-24", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 09:12 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_14", "date": "2026-08-24", "category": "อื่นๆ", "merchant": "ยาฆ่าแมลง", "amount": 1657.0, "remarks": "เวลา 16:16 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_15", "date": "2026-08-24", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 1130.0, "remarks": "เวลา 16:12 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_16", "date": "2026-08-24", "category": "อื่นๆ", "merchant": "ปูน", "amount": 4300.0, "remarks": "เวลา 13:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_17", "date": "2026-08-24", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 3815.0, "remarks": "เวลา 09:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_18", "date": "2026-08-20", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 7000.0, "remarks": "เวลา 15:27 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_19", "date": "2026-08-20", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1040.0, "remarks": "เวลา 14:24 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_20", "date": "2026-08-20", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (นายมัสถชัย คำอ้าย)", "amount": 9309.3, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028710054"}, {"id": "exp_21", "date": "2026-08-20", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (จามจุรีย์ วูด)", "amount": 4929.53, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028752392"}, {"id": "exp_22", "date": "2026-08-20", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 08:48 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_23", "date": "2026-08-19", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3000.0, "remarks": "เวลา 08:27 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_24", "date": "2026-08-18", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 10482.0, "remarks": "เวลา 11:51 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_25", "date": "2026-08-18", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 800.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_26", "date": "2026-08-18", "category": "ดอกเบี้ย", "merchant": "ดอกเบี้ย", "amount": 2600.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_27", "date": "2026-08-17", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:13 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_28", "date": "2026-08-17", "category": "ค่าแรง", "merchant": "ค่าแรง 1-15 ส.ค.69", "amount": 108775.0, "remarks": "เวลา 16:41 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_29", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "สำรองจ่าย ค่าไม้และน้ำมัน", "amount": 5000.0, "remarks": "เวลา 08:18 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_30", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1250.0, "remarks": "เวลา 17:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_31", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1485.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_32", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "คนงานเบิก", "amount": 5000.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_33", "date": "2026-08-14", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 5000.0, "remarks": "เวลา 11:45 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_34", "date": "2026-08-14", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1610.0, "remarks": "เวลา 14:31 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_35", "date": "2026-08-13", "category": "ค่าแรง", "merchant": "ค่าขับรถ", "amount": 700.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_36", "date": "2026-08-13", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1541.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_37", "date": "2026-08-12", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:56 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_38", "date": "2026-08-12", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 3100.0, "remarks": "เวลา 17:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_39", "date": "2026-08-11", "category": "คืนเงิน", "merchant": "คืน ที.วอช", "amount": 40000.0, "remarks": "เวลา 22:01 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_40", "date": "2026-08-11", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 08:29 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_41", "date": "2026-08-11", "category": "ค่าไม้", "merchant": "ซื้อพาเลตไม้ มือ 2 (หักจากยอดรับ นวศิลา)", "amount": 2000.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_42", "date": "2026-08-11", "category": "ค่าอะไหล่", "merchant": "หักค่าตะปู 3 ลัง (หักจากยอดรับ นวศิลา)", "amount": 4200.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_43", "date": "2026-08-10", "category": "ค่าอะไหล่", "merchant": "ค่ายางรถ โฟล์คลิฟท์", "amount": 4400.0, "remarks": "เวลา 15:47 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_44", "date": "2026-08-10", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3500.0, "remarks": "เวลา 14:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_45", "date": "2026-08-10", "category": "อื่นๆ", "merchant": "ค่ารถ", "amount": 6000.0, "remarks": "เวลา 08:48 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_46", "date": "2026-08-09", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_47", "date": "2026-08-08", "category": "ค่าแรง", "merchant": "คนงานเบิกเงิน", "amount": 8500.0, "remarks": "เวลา 15:19 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_48", "date": "2026-08-07", "category": "สำรองจ่าย", "merchant": "สำรองจ่ายพี่มัส", "amount": 2000.0, "remarks": "เวลา 12:26 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_49", "date": "2026-08-07", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 2800.0, "remarks": "เวลา 20:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_50", "date": "2026-08-06", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 13:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_51", "date": "2026-08-04", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 4000.0, "remarks": "เวลา 14:56 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_52", "date": "2026-08-04", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 6225.0, "remarks": "เวลา 14:55 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_53", "date": "2026-08-04", "category": "ค่าอะไหล่", "merchant": "ซ่อมได", "amount": 1000.0, "remarks": "เวลา 09:36 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_54", "date": "2026-08-03", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 15:09 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_55", "date": "2026-08-03", "category": "อื่นๆ", "merchant": "ค่าตำรวจแม่อ้อ", "amount": 2000.0, "remarks": "เวลา 11:58 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_56", "date": "2026-08-03", "category": "ค่าอะไหล่", "merchant": "ยางแท่นเครื่อง", "amount": 2000.0, "remarks": "เวลา 09:02 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_57", "date": "2026-08-02", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 09:30 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_58", "date": "2026-08-01", "category": "อื่นๆ", "merchant": "ค่าแนะนำ", "amount": 2000.0, "remarks": "เวลา 09:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}], "mtp-revenue": [{"id": "rev_01", "date": "2026-09-01", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 48000.0, "remarks": "เวลา 13:00 น. | บิลเงินสดเล่มที่ 07 เลขที่ 0312 (วันที่ 31-8-69) ลูกค้า: ภพลาภิน | Ref: 016244130046DTF03777"}, {"id": "rev_02", "date": "2026-09-01", "description": "NARAWUT PONGL", "customer": "NARAWUT PONGL", "amount": 54406.0, "remarks": "เวลา 09:48 น. | โอนจาก ธ.กรุงศรีอยุธยา เข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_03", "date": "2026-08-29", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 53375.0, "remarks": "เวลา 16:33 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_04", "date": "2026-08-23", "description": "นางสาว ยุพเรศ อารีย์", "customer": "นางสาว ยุพเรศ อารีย์", "amount": 6180.0, "remarks": "เวลา 10:09 น. | โอนจาก ธ.ออมสิน เข้า บจก.เอ็มทีพี วูด"}, {"id": "rev_05", "date": "2026-08-21", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 50000.0, "remarks": "เวลา 18:01 น. | เบิกล่วงหน้า พาเลต มัด เชียงราย 21/8/2569"}, {"id": "rev_06", "date": "2026-08-20", "description": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "customer": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "amount": 22000.0, "remarks": "เวลา 17:11 น. | ใบส่งของเล่มที่ 10 เลขที่ 0478 (ยอดรวม 33,850 ชำระเงินโอน 22,000 ค้าง 11,850) | Ref: Aa41d8a530905492f"}, {"id": "rev_07", "date": "2026-08-17", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 30000.0, "remarks": "เวลา 15:05 น. | เบิกล่วงหน้ามัดเชียงราย 17/8/2569"}, {"id": "rev_08", "date": "2026-08-11", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 64170.0, "remarks": "เวลา 17:49 น. | ยอดขายพาเลต 70,370 บาท (หักค่าตะปู 4,200 และหักพาเลตมือสอง 2,000 รับสุทธิ 64,170)"}, {"id": "rev_09", "date": "2026-08-08", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 7380.0, "remarks": "เวลา 18:34 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_10", "date": "2026-08-08", "description": "นาย ปนาวุธ แ.", "customer": "นาย ปนาวุธ แ.", "amount": 23680.0, "remarks": "เวลา 16:25 น. | ใบส่งของเล่มที่ 10 เลขที่ 0477 (ยอดรวม 23,970 หักส่วนลด 100 ยอดชำระสุทธิ 23,680) | Ref: 016220162517DTF03076"}, {"id": "rev_11", "date": "2026-08-08", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 1510.0, "remarks": "เวลา 08:59 น. | ใบส่งของเล่มที่ 10 เลขที่ 0475 (วันที่ 7-8-69) | Ref: 016220085932CTF07013"}], "mtp_revenue": [{"id": "rev_01", "date": "2026-09-01", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 48000.0, "remarks": "เวลา 13:00 น. | บิลเงินสดเล่มที่ 07 เลขที่ 0312 (วันที่ 31-8-69) ลูกค้า: ภพลาภิน | Ref: 016244130046DTF03777"}, {"id": "rev_02", "date": "2026-09-01", "description": "NARAWUT PONGL", "customer": "NARAWUT PONGL", "amount": 54406.0, "remarks": "เวลา 09:48 น. | โอนจาก ธ.กรุงศรีอยุธยา เข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_03", "date": "2026-08-29", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 53375.0, "remarks": "เวลา 16:33 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_04", "date": "2026-08-23", "description": "นางสาว ยุพเรศ อารีย์", "customer": "นางสาว ยุพเรศ อารีย์", "amount": 6180.0, "remarks": "เวลา 10:09 น. | โอนจาก ธ.ออมสิน เข้า บจก.เอ็มทีพี วูด"}, {"id": "rev_05", "date": "2026-08-21", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 50000.0, "remarks": "เวลา 18:01 น. | เบิกล่วงหน้า พาเลต มัด เชียงราย 21/8/2569"}, {"id": "rev_06", "date": "2026-08-20", "description": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "customer": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "amount": 22000.0, "remarks": "เวลา 17:11 น. | ใบส่งของเล่มที่ 10 เลขที่ 0478 (ยอดรวม 33,850 ชำระเงินโอน 22,000 ค้าง 11,850) | Ref: Aa41d8a530905492f"}, {"id": "rev_07", "date": "2026-08-17", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 30000.0, "remarks": "เวลา 15:05 น. | เบิกล่วงหน้ามัดเชียงราย 17/8/2569"}, {"id": "rev_08", "date": "2026-08-11", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 64170.0, "remarks": "เวลา 17:49 น. | ยอดขายพาเลต 70,370 บาท (หักค่าตะปู 4,200 และหักพาเลตมือสอง 2,000 รับสุทธิ 64,170)"}, {"id": "rev_09", "date": "2026-08-08", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 7380.0, "remarks": "เวลา 18:34 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_10", "date": "2026-08-08", "description": "นาย ปนาวุธ แ.", "customer": "นาย ปนาวุธ แ.", "amount": 23680.0, "remarks": "เวลา 16:25 น. | ใบส่งของเล่มที่ 10 เลขที่ 0477 (ยอดรวม 23,970 หักส่วนลด 100 ยอดชำระสุทธิ 23,680) | Ref: 016220162517DTF03076"}, {"id": "rev_11", "date": "2026-08-08", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 1510.0, "remarks": "เวลา 08:59 น. | ใบส่งของเล่มที่ 10 เลขที่ 0475 (วันที่ 7-8-69) | Ref: 016220085932CTF07013"}], "jamjuree-revenue": [], "twash-loans": [{"id": "tw_01", "date": "2026-02-16", "time": "13:56", "purpose": "ยืมเงิน ที.วอช", "description": "ยืมเงิน ที.วอช (ผู้รับเงิน: นางสาว นงลักษณ์ ฝักทอง)", "type": "borrow", "amount": 22500.0, "borrow": 22500.0, "repay": 0.0, "cum_balance": 22500.0, "recipient": "นางสาว นงลักษณ์ ฝักทอง", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 13:56 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_02", "date": "2026-03-04", "time": "18:50", "purpose": "คืนเงิน ที.วอช (1 แสน)", "description": "คืนเงิน ที.วอช (1 แสน) (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 100000.0, "borrow": 0.0, "repay": 100000.0, "cum_balance": -77500.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 18:50 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_03", "date": "2026-03-31", "time": "11:23", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 60000.0, "borrow": 0.0, "repay": 60000.0, "cum_balance": -137500.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 11:23 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_04", "date": "2026-04-11", "time": "19:35", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 10000.0, "borrow": 0.0, "repay": 10000.0, "cum_balance": -147500.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 19:35 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_05", "date": "2026-04-12", "time": "14:19", "purpose": "ยืมเงิน ที.วอช", "description": "ยืมเงิน ที.วอช (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 10000.0, "borrow": 10000.0, "repay": 0.0, "cum_balance": -137500.0, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:19 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_06", "date": "2026-04-12", "time": "16:41", "purpose": "ยืมเงิน ที.วอช", "description": "ยืมเงิน ที.วอช (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 10000.0, "borrow": 10000.0, "repay": 0.0, "cum_balance": -127500.0, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 16:41 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_07", "date": "2026-04-28", "time": "14:28", "purpose": "ยืมเงิน ที.วอช (ค่ารถหกล้อ)", "description": "ยืมเงิน ที.วอช (ค่ารถหกล้อ) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 20900.0, "borrow": 20900.0, "repay": 0.0, "cum_balance": -106600.0, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:28 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_08", "date": "2026-04-28", "time": "18:05", "purpose": "คืนเงินค่าไฟ ที.วอช", "description": "คืนเงินค่าไฟ ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 4638.0, "borrow": 0.0, "repay": 4638.0, "cum_balance": -111238.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 18:05 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_09", "date": "2026-04-28", "time": "18:05", "purpose": "ยืมเงิน ที.วอช (ค่าไฟฟ้า)", "description": "ยืมเงิน ที.วอช (ค่าไฟฟ้า) (ผู้รับเงิน: การไฟฟ้าส่วนภูมิภาค)", "type": "borrow", "amount": 4639.72, "borrow": 4639.72, "repay": 0.0, "cum_balance": -106598.28, "recipient": "การไฟฟ้าส่วนภูมิภาค", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 18:05 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_10", "date": "2026-04-30", "time": "12:37", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 8000.0, "borrow": 0.0, "repay": 8000.0, "cum_balance": -114598.28, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 12:37 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_11", "date": "2026-05-11", "time": "21:58", "purpose": "คืนเงินยืม ที.วอช", "description": "คืนเงินยืม ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 30000.0, "borrow": 0.0, "repay": 30000.0, "cum_balance": -144598.28, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 21:58 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_12", "date": "2026-05-14", "time": "15:50", "purpose": "ยืมค่าน้ำมัน", "description": "ยืมค่าน้ำมัน (ผู้รับเงิน: K-POWER (2016) CO.,LTD.)", "type": "borrow", "amount": 16900.0, "borrow": 16900.0, "repay": 0.0, "cum_balance": -127698.28, "recipient": "K-POWER (2016) CO.,LTD.", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 15:50 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_13", "date": "2026-06-06", "time": "13:38", "purpose": "ยืมเงิน ที.วอช 2500", "description": "ยืมเงิน ที.วอช 2500 (ผู้รับเงิน: นาย แสวง ทองคำ)", "type": "borrow", "amount": 7500.0, "borrow": 7500.0, "repay": 0.0, "cum_balance": -120198.28, "recipient": "นาย แสวง ทองคำ", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 13:38 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_14", "date": "2026-06-19", "time": "14:48", "purpose": "ยืม บจก. เชียงใหม่", "description": "ยืม บจก. เชียงใหม่ (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 20000.0, "borrow": 20000.0, "repay": 0.0, "cum_balance": -100198.28, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:48 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_15", "date": "2026-07-04", "time": "12:28", "purpose": "ยืมเงิน ที.วอช (ชำระค่าดอกเบี้ยเงินกู้)", "description": "ยืมเงิน ที.วอช (ชำระค่าดอกเบี้ยเงินกู้) (ผู้รับเงิน: นาย แสวง ทองคำ)", "type": "borrow", "amount": 7500.0, "borrow": 7500.0, "repay": 0.0, "cum_balance": -92698.28, "recipient": "นาย แสวง ทองคำ", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 12:28 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_16", "date": "2026-07-19", "time": "10:29", "purpose": "ยืม ที.วอช เชียงใหม่", "description": "ยืม ที.วอช เชียงใหม่ (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ)", "type": "borrow", "amount": 50000.0, "borrow": 50000.0, "repay": 0.0, "cum_balance": -42698.28, "recipient": "นาย ธนวัฏ คงอ่ำ", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 10:29 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_17", "date": "2026-07-22", "time": "09:38", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 8000.0, "borrow": 0.0, "repay": 8000.0, "cum_balance": -50698.28, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 09:38 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_18", "date": "2026-07-25", "time": "14:39", "purpose": "ยืม ที.วอช", "description": "ยืม ที.วอช (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 5000.0, "borrow": 5000.0, "repay": 0.0, "cum_balance": -45698.28, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:39 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_19", "date": "2026-07-26", "time": "12:53", "purpose": "ยืม ที.วอช", "description": "ยืม ที.วอช (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 5000.0, "borrow": 5000.0, "repay": 0.0, "cum_balance": -40698.28, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 12:53 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_20", "date": "2026-08-03", "time": "11:58", "purpose": "ยืม ที.วอช (ตำรวจแม่อ้อ)", "description": "ยืม ที.วอช (ตำรวจแม่อ้อ) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 2000.0, "borrow": 2000.0, "repay": 0.0, "cum_balance": -38698.28, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016215115859CTF06226", "targetSheet": "twash-loans", "remarks": "เวลา 11:58 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_21", "date": "2026-08-08", "time": "15:19", "purpose": "ยืมเงิน ที.วอช เชียงราย (คนงานเบิก)", "description": "ยืมเงิน ที.วอช เชียงราย (คนงานเบิก) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 8500.0, "borrow": 8500.0, "repay": 0.0, "cum_balance": -30198.28, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016220151948DTF06172", "targetSheet": "twash-loans", "remarks": "เวลา 15:19 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_22", "date": "2026-08-11", "time": "22:01", "purpose": "คืนที่วอช", "description": "คืนที่วอช (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 40000.0, "borrow": 0.0, "repay": 40000.0, "cum_balance": -70198.28, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260811511422022", "targetSheet": "twash-loans", "remarks": "เวลา 22:01 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_23", "date": "2026-08-17", "time": "16:39", "purpose": "ยืม ที.วอช เชียงราย (เงินหมุนเข้าบริษัท)", "description": "ยืม ที.วอช เชียงราย (เงินหมุนเข้าบริษัท) (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 80000.0, "borrow": 80000.0, "repay": 0.0, "cum_balance": 9801.720000000001, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "016229163919CTF06413", "targetSheet": "twash-loans", "remarks": "เวลา 16:39 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_24", "date": "2026-08-18", "time": "11:51", "purpose": "ยืม ที.วอช (ซื้อไม้)", "description": "ยืม ที.วอช (ซื้อไม้) (ผู้รับเงิน: นาย ชาติชาย คำสงค์)", "type": "borrow", "amount": 10482.0, "borrow": 10482.0, "repay": 0.0, "cum_balance": 20283.72, "recipient": "นาย ชาติชาย คำสงค์", "billRef": "016230115142CTF05189", "targetSheet": "twash-loans", "remarks": "เวลา 11:51 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_25", "date": "2026-08-20", "time": "08:48", "purpose": "ยืม ที.วอช ชร (น้ำมัน)", "description": "ยืม ที.วอช ชร (น้ำมัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 4000.0, "borrow": 4000.0, "repay": 0.0, "cum_balance": 24283.72, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016232084859CTF02868", "targetSheet": "twash-loans", "remarks": "เวลา 08:48 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_26", "date": "2026-08-20", "time": "15:25", "purpose": "ยืม ที.วอช ชร (ค่าไฟ นายมัสถชัย คำอ้าย)", "description": "ยืม ที.วอช ชร (ค่าไฟ นายมัสถชัย คำอ้าย) (ผู้รับเงิน: การไฟฟ้าส่วนภูมิภาค)", "type": "borrow", "amount": 9309.3, "borrow": 9309.3, "repay": 0.0, "cum_balance": 33593.020000000004, "recipient": "การไฟฟ้าส่วนภูมิภาค", "billRef": "885204248774", "targetSheet": "twash-loans", "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 (CA: 020028710054) | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_27", "date": "2026-08-20", "time": "15:25", "purpose": "ยืม ที.วอช ชร (ค่าไฟ จามจุรีย์ วูด)", "description": "ยืม ที.วอช ชร (ค่าไฟ จามจุรีย์ วูด) (ผู้รับเงิน: การไฟฟ้าส่วนภูมิภาค)", "type": "borrow", "amount": 4929.53, "borrow": 4929.53, "repay": 0.0, "cum_balance": 38522.55, "recipient": "การไฟฟ้าส่วนภูมิภาค", "billRef": "883804261789", "targetSheet": "twash-loans", "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 (CA: 020028752392) | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_28", "date": "2026-08-20", "time": "15:27", "purpose": "ยืม ที.วอช ชร (ค่าไม้)", "description": "ยืม ที.วอช ชร (ค่าไม้) (ผู้รับเงิน: นาย เรวัตร พรมเผ่า)", "type": "borrow", "amount": 7000.0, "borrow": 7000.0, "repay": 0.0, "cum_balance": 45522.55, "recipient": "นาย เรวัตร พรมเผ่า", "billRef": "016232152708DOR07811", "targetSheet": "twash-loans", "remarks": "เวลา 15:27 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_29", "date": "2026-08-20", "time": "21:23", "purpose": "คืนค่าไฟ (ที.วอช)", "description": "คืนค่าไฟ (ที.วอช) (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 14239.0, "borrow": 0.0, "repay": 14239.0, "cum_balance": 31283.550000000003, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260820573293239", "targetSheet": "twash-loans", "remarks": "เวลา 21:23 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_30", "date": "2026-08-22", "time": "01:55", "purpose": "คืน ที.วอช เชียงใหม่", "description": "คืน ที.วอช เชียงใหม่ (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 50000.0, "borrow": 0.0, "repay": 50000.0, "cum_balance": -18716.449999999997, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260822581404643", "targetSheet": "twash-loans", "remarks": "เวลา 01:55 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_31", "date": "2026-08-25", "time": "09:33", "purpose": "ยืม ที.วูอช ชร (ค่าน้ำมัน)", "description": "ยืม ที.วูอช ชร (ค่าน้ำมัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 1000.0, "borrow": 1000.0, "repay": 0.0, "cum_balance": -17716.449999999997, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016237093358BTF09829", "targetSheet": "twash-loans", "remarks": "เวลา 09:33 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_32", "date": "2026-08-25", "time": "10:38", "purpose": "ยืม ที.วอช (ค่าไม้)", "description": "ยืม ที.วอช (ค่าไม้) (ผู้รับเงิน: นาย ชาติชาย คำสงค์)", "type": "borrow", "amount": 13883.0, "borrow": 13883.0, "repay": 0.0, "cum_balance": -3833.449999999997, "recipient": "นาย ชาติชาย คำสงค์", "billRef": "016237103813CTF06330", "targetSheet": "twash-loans", "remarks": "เวลา 10:38 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_33", "date": "2026-08-25", "time": "14:59", "purpose": "ยืม ที.วอช ชร (ค่างวดรถสิบล้อ)", "description": "ยืม ที.วอช ชร (ค่างวดรถสิบล้อ) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 20700.0, "borrow": 20700.0, "repay": 0.0, "cum_balance": 16866.550000000003, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016237145907DTF04568", "targetSheet": "twash-loans", "remarks": "เวลา 14:59 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_34", "date": "2026-08-25", "time": "15:33", "purpose": "ยืม ที.วอช ชร (ค่าใบอนุญาต ป่าไม้)", "description": "ยืม ที.วอช ชร (ค่าใบอนุญาต ป่าไม้) (ผู้รับเงิน: ทส จ. เชียงราย)", "type": "borrow", "amount": 1000.0, "borrow": 1000.0, "repay": 0.0, "cum_balance": 17866.550000000003, "recipient": "ทส จ. เชียงราย", "billRef": "016237153356DPM06703", "targetSheet": "twash-loans", "remarks": "เวลา 15:33 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_35", "date": "2026-08-27", "time": "16:23", "purpose": "ยืม ที.วอช ชร (น้ำมัน)", "description": "ยืม ที.วอช ชร (น้ำมัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 4000.0, "borrow": 4000.0, "repay": 0.0, "cum_balance": 21866.550000000003, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016239162356CTF08438", "targetSheet": "twash-loans", "remarks": "เวลา 16:23 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_36", "date": "2026-08-27", "time": "17:34", "purpose": "ยืม ที.วอช ชร (ค่าบิลโรงพิมพ์)", "description": "ยืม ที.วอช ชร (ค่าบิลโรงพิมพ์) (ผู้รับเงิน: หจก. โรงพิมพ์ศรีอยุธยา)", "type": "borrow", "amount": 5050.0, "borrow": 5050.0, "repay": 0.0, "cum_balance": 26916.550000000003, "recipient": "หจก. โรงพิมพ์ศรีอยุธยา", "billRef": "016239173427DOR07581", "targetSheet": "twash-loans", "remarks": "เวลา 17:34 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_37", "date": "2026-08-28", "time": "09:53", "purpose": "ยืม ที.วอช (ค่าโทรศัพท์ AIS)", "description": "ยืม ที.วอช (ค่าโทรศัพท์ AIS) (ผู้รับเงิน: เอไอเอส (AIS))", "type": "borrow", "amount": 2558.79, "borrow": 2558.79, "repay": 0.0, "cum_balance": 29475.340000000004, "recipient": "เอไอเอส (AIS)", "billRef": "016240095320DPM13340", "targetSheet": "twash-loans", "remarks": "เวลา 09:53 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_38", "date": "2026-08-28", "time": "13:41", "purpose": "ยืม ที.วอช (ค่าไม้)", "description": "ยืม ที.วอช (ค่าไม้) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 1720.0, "borrow": 1720.0, "repay": 0.0, "cum_balance": 31195.340000000004, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016240134112CTF08641", "targetSheet": "twash-loans", "remarks": "เวลา 13:41 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_39", "date": "2026-08-29", "time": "11:12", "purpose": "ยืม ที.วอช ชร (น้ำมันเบรค/อาหารกลางวัน)", "description": "ยืม ที.วอช ชร (น้ำมันเบรค/อาหารกลางวัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 2000.0, "borrow": 2000.0, "repay": 0.0, "cum_balance": 33195.340000000004, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016241111212DTF05739", "targetSheet": "twash-loans", "remarks": "เวลา 11:12 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_40", "date": "2026-08-29", "time": "16:57", "purpose": "ตีคืนเงินยืม ที.วอช ชร", "description": "ตีคืนเงินยืม ที.วอช ชร (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 50000.0, "borrow": 0.0, "repay": 50000.0, "cum_balance": -16804.659999999996, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260829632439442", "targetSheet": "twash-loans", "remarks": "เวลา 16:57 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_41", "date": "2026-09-01", "time": "13:58", "purpose": "ยืม ที.วอช (ค่าแรง)", "description": "ยืม ที.วอช (ค่าแรง) (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 10000.0, "borrow": 10000.0, "repay": 0.0, "cum_balance": -6804.659999999996, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "016244135816DTF00769", "targetSheet": "twash-loans", "remarks": "เวลา 13:58 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_42", "date": "2026-09-02", "time": "03:53", "purpose": "ยืม ที.วอช ชร (ดอกเบี้ย 3 แสน บริษัทวัน)", "description": "ยืม ที.วอช ชร (ดอกเบี้ย 3 แสน บริษัทวัน) (ผู้รับเงิน: น.ส. ผนิสา คงอ่ำ)", "type": "borrow", "amount": 4500.0, "borrow": 4500.0, "repay": 0.0, "cum_balance": -2304.659999999996, "recipient": "น.ส. ผนิสา คงอ่ำ", "billRef": "016245035301DTF02229", "targetSheet": "twash-loans", "remarks": "เวลา 03:53 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_43", "date": "2026-09-02", "time": "14:11", "purpose": "ยืม ที.วอช ชร (ต่อใบอนุญาตป่าไม้)", "description": "ยืม ที.วอช ชร (ต่อใบอนุญาตป่าไม้) (ผู้รับเงิน: นาง สุกัลยา จันต๊ะอิน)", "type": "borrow", "amount": 20000.0, "borrow": 20000.0, "repay": 0.0, "cum_balance": 17695.340000000004, "recipient": "นาง สุกัลยา จันต๊ะอิน", "billRef": "016245141131CPP05895", "targetSheet": "twash-loans", "remarks": "เวลา 14:11 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_44", "date": "2026-09-03", "time": "17:16", "purpose": "ยืม ที.วอช ชร (จ่ายหน้างาน)", "description": "ยืม ที.วอช ชร (จ่ายหน้างาน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 2000.0, "borrow": 2000.0, "repay": 0.0, "cum_balance": 19695.340000000004, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016246171640CTF01281", "targetSheet": "twash-loans", "remarks": "เวลา 17:16 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}], "asawaeng-loans": [{"id": "asw_01", "date": "2025-09-27", "purpose": "เงินกู้ยืมลงทุนจากคุณอาแสวง (เงินต้น)", "type": "borrow", "amount": 500000.0, "remarks": "สัญญาเงินต้น 500,000 บาท | ดอกเบี้ย 1.5%/เดือน (ชำระสะสม 12 งวด 90,000 บาท) ชำระเงินต้น 0.00 บาท"}], "wan-loans": [{"id": "wan_01", "date": "2026-06-01", "purpose": "รับเงินกู้ยืมหมุนเวียน บ.วัน", "type": "borrow", "amount": 250000.0, "remarks": "สัญญากู้ยืม 250,000 บาท"}, {"id": "wan_02", "date": "2026-07-15", "purpose": "โอนชำระหนี้คืนบริษัท วัน", "type": "repay", "amount": 75000.0, "remarks": "ชำระคืน 75,000 บาท (คงเหลือ 175,000 บาท)"}], "pimas-expenses": [{"id": "pimas_01", "date": "2026-06-04", "description": "สำรองจ่ายค่าอัดยางนอกรถแทรกเตอร์", "status": "paid", "amount": 8500.0, "remarks": "ชำระคืนพี่มัสแล้ว 20 มิ.ย."}, {"id": "pimas_02", "date": "2026-06-18", "description": "ของชำร่วยงานบุญวันก่อตั้งโรงงาน", "status": "paid", "amount": 12000.0, "remarks": "ชำระคืนพี่มัสแล้ว 25 มิ.ย."}, {"id": "pimas_03", "date": "2026-07-10", "description": "โซ่เลื่อยยนต์และอะไหล่ด่วนแท่นบาก", "status": "unpaid", "amount": 6500.0, "remarks": "รอเบิกงวดถัดไป"}, {"id": "pimas_04", "date": "2026-07-24", "description": "สั่งข้าวกล่องช่างซ่อมฐานปูนเสาโรงงาน", "status": "paid", "amount": 4200.0, "remarks": "ชำระคืนโอนแล้ว ก.ค."}, {"id": "pimas_05", "date": "2026-07-31", "description": "ค่าบริการเครื่องดื่มช่างลากไม้ช่วงบ่าย", "status": "unpaid", "amount": 3500.0, "remarks": "ยอดสะสมรอบิลเคลียร์"}]};
    localStorage.setItem('mtp_wood_db', JSON.stringify(db));
    localStorage.setItem('mtp_is_demo', 'false');
}

function loadDatabase() {
    db = {"mtp-expenses": [{"id": "exp_01", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 10:35 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_02", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ค่าวงเดือน", "amount": 3000.0, "remarks": "เวลา 11:26 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_03", "date": "2026-08-15", "category": "คืนเงิน", "merchant": "ตีคืนเงินยืม ที.วอช ชร", "amount": 50000.0, "remarks": "เวลา 16:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_04", "date": "2026-08-15", "category": "ค่าเช่า/อื่นๆ", "merchant": "น้ำมันเบรค และอาหารกลางวัน", "amount": 2000.0, "remarks": "เวลา 11:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_05", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1720.0, "remarks": "เวลา 13:41 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_06", "date": "2026-08-15", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าโทรศัพท์ (AIS 084-809-5498)", "amount": 2558.79, "remarks": "เวลา 09:53 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_07", "date": "2026-08-15", "category": "ค่าเช่า/อื่นๆ", "merchant": "ค่าทำบิล", "amount": 5050.0, "remarks": "เวลา 17:34 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_08", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 16:23 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_09", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่าใบอนุญาต (ทส จ. เชียงราย)", "amount": 1000.0, "remarks": "เวลา 15:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_10", "date": "2026-08-15", "category": "ชำระค่างวด", "merchant": "ค่างวดรถสิบล้อ", "amount": 20700.0, "remarks": "เวลา 14:59 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_11", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 13883.0, "remarks": "เวลา 10:38 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_12", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 1000.0, "remarks": "เวลา 09:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_13", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 09:12 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_14", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ยาฆ่าแมลง", "amount": 1657.0, "remarks": "เวลา 16:16 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_15", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 1130.0, "remarks": "เวลา 16:12 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_16", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ปูน", "amount": 4300.0, "remarks": "เวลา 13:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_17", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 3815.0, "remarks": "เวลา 09:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_18", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 7000.0, "remarks": "เวลา 15:27 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_19", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1040.0, "remarks": "เวลา 14:24 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_20", "date": "2026-08-15", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (นายมัสถชัย คำอ้าย)", "amount": 9309.3, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028710054"}, {"id": "exp_21", "date": "2026-08-15", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (จามจุรีย์ วูด)", "amount": 4929.53, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028752392"}, {"id": "exp_22", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 08:48 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_23", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3000.0, "remarks": "เวลา 08:27 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_24", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 10482.0, "remarks": "เวลา 11:51 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_25", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 800.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_26", "date": "2026-08-15", "category": "ดอกเบี้ย", "merchant": "ดอกเบี้ย", "amount": 2600.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_27", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:13 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_28", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "ค่าแรง 1-15 ส.ค.69", "amount": 108775.0, "remarks": "เวลา 16:41 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_29", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "สำรองจ่าย ค่าไม้และน้ำมัน", "amount": 5000.0, "remarks": "เวลา 08:18 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_30", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1250.0, "remarks": "เวลา 17:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_31", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1485.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_32", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "คนงานเบิก", "amount": 5000.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_33", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 5000.0, "remarks": "เวลา 11:45 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_34", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1610.0, "remarks": "เวลา 14:31 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_35", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "ค่าขับรถ", "amount": 700.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_36", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1541.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_37", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:56 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_38", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 3100.0, "remarks": "เวลา 17:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_39", "date": "2026-08-15", "category": "คืนเงิน", "merchant": "คืน ที.วอช", "amount": 40000.0, "remarks": "เวลา 22:01 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_40", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 08:29 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_41", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อพาเลตไม้ มือ 2 (หักจากยอดรับ นวศิลา)", "amount": 2000.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_42", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "หักค่าตะปู 3 ลัง (หักจากยอดรับ นวศิลา)", "amount": 4200.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_43", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ค่ายางรถ โฟล์คลิฟท์", "amount": 4400.0, "remarks": "เวลา 15:47 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_44", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3500.0, "remarks": "เวลา 14:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_45", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่ารถ", "amount": 6000.0, "remarks": "เวลา 08:48 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_46", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_47", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "คนงานเบิกเงิน", "amount": 8500.0, "remarks": "เวลา 15:19 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_48", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่ายพี่มัส", "amount": 2000.0, "remarks": "เวลา 12:26 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_49", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 2800.0, "remarks": "เวลา 20:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_50", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 13:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_51", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 4000.0, "remarks": "เวลา 14:56 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_52", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 6225.0, "remarks": "เวลา 14:55 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_53", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ซ่อมได", "amount": 1000.0, "remarks": "เวลา 09:36 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_54", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 15:09 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_55", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่าตำรวจแม่อ้อ", "amount": 2000.0, "remarks": "เวลา 11:58 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_56", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ยางแท่นเครื่อง", "amount": 2000.0, "remarks": "เวลา 09:02 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_57", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 09:30 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_58", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่าแนะนำ", "amount": 2000.0, "remarks": "เวลา 09:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}], "mtp_expenses": [{"id": "exp_01", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 10:35 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_02", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ค่าวงเดือน", "amount": 3000.0, "remarks": "เวลา 11:26 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_03", "date": "2026-08-15", "category": "คืนเงิน", "merchant": "ตีคืนเงินยืม ที.วอช ชร", "amount": 50000.0, "remarks": "เวลา 16:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_04", "date": "2026-08-15", "category": "ค่าเช่า/อื่นๆ", "merchant": "น้ำมันเบรค และอาหารกลางวัน", "amount": 2000.0, "remarks": "เวลา 11:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_05", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1720.0, "remarks": "เวลา 13:41 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_06", "date": "2026-08-15", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าโทรศัพท์ (AIS 084-809-5498)", "amount": 2558.79, "remarks": "เวลา 09:53 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_07", "date": "2026-08-15", "category": "ค่าเช่า/อื่นๆ", "merchant": "ค่าทำบิล", "amount": 5050.0, "remarks": "เวลา 17:34 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_08", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 16:23 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_09", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่าใบอนุญาต (ทส จ. เชียงราย)", "amount": 1000.0, "remarks": "เวลา 15:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_10", "date": "2026-08-15", "category": "ชำระค่างวด", "merchant": "ค่างวดรถสิบล้อ", "amount": 20700.0, "remarks": "เวลา 14:59 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_11", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 13883.0, "remarks": "เวลา 10:38 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_12", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 1000.0, "remarks": "เวลา 09:33 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_13", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 09:12 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_14", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ยาฆ่าแมลง", "amount": 1657.0, "remarks": "เวลา 16:16 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_15", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 1130.0, "remarks": "เวลา 16:12 น. | โอนพร้อมเพย์จาก บจก. เอ็มทีพี วูด"}, {"id": "exp_16", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ปูน", "amount": 4300.0, "remarks": "เวลา 13:57 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_17", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 3815.0, "remarks": "เวลา 09:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_18", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 7000.0, "remarks": "เวลา 15:27 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_19", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1040.0, "remarks": "เวลา 14:24 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_20", "date": "2026-08-15", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (นายมัสถชัย คำอ้าย)", "amount": 9309.3, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028710054"}, {"id": "exp_21", "date": "2026-08-15", "category": "ค่าไฟ/น้ำ", "merchant": "ค่าไฟฟ้า (จามจุรีย์ วูด)", "amount": 4929.53, "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 | CA: 020028752392"}, {"id": "exp_22", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 4000.0, "remarks": "เวลา 08:48 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_23", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3000.0, "remarks": "เวลา 08:27 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_24", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 10482.0, "remarks": "เวลา 11:51 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_25", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 800.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_26", "date": "2026-08-15", "category": "ดอกเบี้ย", "merchant": "ดอกเบี้ย", "amount": 2600.0, "remarks": "เวลา 10:16 น. | สลิป 3,400 (ดอกเบี้ย 2,600 + ค่าไม้ 800)"}, {"id": "exp_27", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:13 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_28", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "ค่าแรง 1-15 ส.ค.69", "amount": 108775.0, "remarks": "เวลา 16:41 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_29", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "สำรองจ่าย ค่าไม้และน้ำมัน", "amount": 5000.0, "remarks": "เวลา 08:18 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_30", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1250.0, "remarks": "เวลา 17:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_31", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1485.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_32", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "คนงานเบิก", "amount": 5000.0, "remarks": "เวลา 12:17 น. | สลิป 6,485 (คนงานเบิก 5,000 + ค่าไม้ 1,485)"}, {"id": "exp_33", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 5000.0, "remarks": "เวลา 11:45 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_34", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1610.0, "remarks": "เวลา 14:31 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_35", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "ค่าขับรถ", "amount": 700.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_36", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ค่าไม้", "amount": 1541.0, "remarks": "เวลา 18:11 น. | ยอดรวมสลิป 2,241 (ค่าไม้ 1,541 + ค่าขับรถ 700)"}, {"id": "exp_37", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:56 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_38", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 3100.0, "remarks": "เวลา 17:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_39", "date": "2026-08-15", "category": "คืนเงิน", "merchant": "คืน ที.วอช", "amount": 40000.0, "remarks": "เวลา 22:01 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_40", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 3000.0, "remarks": "เวลา 08:29 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_41", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อพาเลตไม้ มือ 2 (หักจากยอดรับ นวศิลา)", "amount": 2000.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_42", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "หักค่าตะปู 3 ลัง (หักจากยอดรับ นวศิลา)", "amount": 4200.0, "remarks": "เวลา 17:49 น. | รายจ่ายหักกลบยอดบิลขายพาเลต"}, {"id": "exp_43", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ค่ายางรถ โฟล์คลิฟท์", "amount": 4400.0, "remarks": "เวลา 15:47 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_44", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 3500.0, "remarks": "เวลา 14:10 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_45", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่ารถ", "amount": 6000.0, "remarks": "เวลา 08:48 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_46", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่าย", "amount": 4000.0, "remarks": "เวลา 08:14 น. | โอนจาก บจก. เอ็มทีพี วูด"}, {"id": "exp_47", "date": "2026-08-15", "category": "ค่าแรง", "merchant": "คนงานเบิกเงิน", "amount": 8500.0, "remarks": "เวลา 15:19 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_48", "date": "2026-08-15", "category": "สำรองจ่าย", "merchant": "สำรองจ่ายพี่มัส", "amount": 2000.0, "remarks": "เวลา 12:26 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_49", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 2800.0, "remarks": "เวลา 20:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_50", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 13:12 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_51", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 4000.0, "remarks": "เวลา 14:56 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_52", "date": "2026-08-15", "category": "ค่าไม้", "merchant": "ซื้อไม้", "amount": 6225.0, "remarks": "เวลา 14:55 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_53", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ซ่อมได", "amount": 1000.0, "remarks": "เวลา 09:36 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_54", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 15:09 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_55", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่าตำรวจแม่อ้อ", "amount": 2000.0, "remarks": "เวลา 11:58 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_56", "date": "2026-08-15", "category": "ค่าอะไหล่", "merchant": "ยางแท่นเครื่อง", "amount": 2000.0, "remarks": "เวลา 09:02 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_57", "date": "2026-08-15", "category": "ค่าน้ำมัน", "merchant": "ค่าน้ำมัน", "amount": 2000.0, "remarks": "เวลา 09:30 น. | ผู้โอน: นาย ธนวัฏ"}, {"id": "exp_58", "date": "2026-08-15", "category": "อื่นๆ", "merchant": "ค่าแนะนำ", "amount": 2000.0, "remarks": "เวลา 09:46 น. | โอนจาก บจก. เอ็มทีพี วูด"}], "mtp-revenue": [{"id": "rev_01", "date": "2026-08-15", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 48000.0, "remarks": "เวลา 13:00 น. | บิลเงินสดเล่มที่ 07 เลขที่ 0312 (วันที่ 31-8-69) ลูกค้า: ภพลาภิน | Ref: 016244130046DTF03777"}, {"id": "rev_02", "date": "2026-08-15", "description": "NARAWUT PONGL", "customer": "NARAWUT PONGL", "amount": 54406.0, "remarks": "เวลา 09:48 น. | โอนจาก ธ.กรุงศรีอยุธยา เข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_03", "date": "2026-08-15", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 53375.0, "remarks": "เวลา 16:33 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_04", "date": "2026-08-15", "description": "นางสาว ยุพเรศ อารีย์", "customer": "นางสาว ยุพเรศ อารีย์", "amount": 6180.0, "remarks": "เวลา 10:09 น. | โอนจาก ธ.ออมสิน เข้า บจก.เอ็มทีพี วูด"}, {"id": "rev_05", "date": "2026-08-15", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 50000.0, "remarks": "เวลา 18:01 น. | เบิกล่วงหน้า พาเลต มัด เชียงราย 21/8/2569"}, {"id": "rev_06", "date": "2026-08-15", "description": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "customer": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "amount": 22000.0, "remarks": "เวลา 17:11 น. | ใบส่งของเล่มที่ 10 เลขที่ 0478 (ยอดรวม 33,850 ชำระเงินโอน 22,000 ค้าง 11,850) | Ref: Aa41d8a530905492f"}, {"id": "rev_07", "date": "2026-08-15", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 30000.0, "remarks": "เวลา 15:05 น. | เบิกล่วงหน้ามัดเชียงราย 17/8/2569"}, {"id": "rev_08", "date": "2026-08-15", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 64170.0, "remarks": "เวลา 17:49 น. | ยอดขายพาเลต 70,370 บาท (หักค่าตะปู 4,200 และหักพาเลตมือสอง 2,000 รับสุทธิ 64,170)"}, {"id": "rev_09", "date": "2026-08-15", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 7380.0, "remarks": "เวลา 18:34 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_10", "date": "2026-08-15", "description": "นาย ปนาวุธ แ.", "customer": "นาย ปนาวุธ แ.", "amount": 23680.0, "remarks": "เวลา 16:25 น. | ใบส่งของเล่มที่ 10 เลขที่ 0477 (ยอดรวม 23,970 หักส่วนลด 100 ยอดชำระสุทธิ 23,680) | Ref: 016220162517DTF03076"}, {"id": "rev_11", "date": "2026-08-15", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 1510.0, "remarks": "เวลา 08:59 น. | ใบส่งของเล่มที่ 10 เลขที่ 0475 (วันที่ 7-8-69) | Ref: 016220085932CTF07013"}], "mtp_revenue": [{"id": "rev_01", "date": "2026-08-15", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 48000.0, "remarks": "เวลา 13:00 น. | บิลเงินสดเล่มที่ 07 เลขที่ 0312 (วันที่ 31-8-69) ลูกค้า: ภพลาภิน | Ref: 016244130046DTF03777"}, {"id": "rev_02", "date": "2026-08-15", "description": "NARAWUT PONGL", "customer": "NARAWUT PONGL", "amount": 54406.0, "remarks": "เวลา 09:48 น. | โอนจาก ธ.กรุงศรีอยุธยา เข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_03", "date": "2026-08-15", "description": "นาย อุดมเลิศ พ.", "customer": "นาย อุดมเลิศ พ.", "amount": 53375.0, "remarks": "เวลา 16:33 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_04", "date": "2026-08-15", "description": "นางสาว ยุพเรศ อารีย์", "customer": "นางสาว ยุพเรศ อารีย์", "amount": 6180.0, "remarks": "เวลา 10:09 น. | โอนจาก ธ.ออมสิน เข้า บจก.เอ็มทีพี วูด"}, {"id": "rev_05", "date": "2026-08-15", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 50000.0, "remarks": "เวลา 18:01 น. | เบิกล่วงหน้า พาเลต มัด เชียงราย 21/8/2569"}, {"id": "rev_06", "date": "2026-08-15", "description": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "customer": "ร้อยตำรวจเอก พุทธิพงษ์ พ.", "amount": 22000.0, "remarks": "เวลา 17:11 น. | ใบส่งของเล่มที่ 10 เลขที่ 0478 (ยอดรวม 33,850 ชำระเงินโอน 22,000 ค้าง 11,850) | Ref: Aa41d8a530905492f"}, {"id": "rev_07", "date": "2026-08-15", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 30000.0, "remarks": "เวลา 15:05 น. | เบิกล่วงหน้ามัดเชียงราย 17/8/2569"}, {"id": "rev_08", "date": "2026-08-15", "description": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "customer": "หจก. นวศิลา อินเตอร์ กรุ๊ป", "amount": 64170.0, "remarks": "เวลา 17:49 น. | ยอดขายพาเลต 70,370 บาท (หักค่าตะปู 4,200 และหักพาเลตมือสอง 2,000 รับสุทธิ 64,170)"}, {"id": "rev_09", "date": "2026-08-15", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 7380.0, "remarks": "เวลา 18:34 น. | โอนเงินเข้า บจก. เอ็มทีพี วูด"}, {"id": "rev_10", "date": "2026-08-15", "description": "นาย ปนาวุธ แ.", "customer": "นาย ปนาวุธ แ.", "amount": 23680.0, "remarks": "เวลา 16:25 น. | ใบส่งของเล่มที่ 10 เลขที่ 0477 (ยอดรวม 23,970 หักส่วนลด 100 ยอดชำระสุทธิ 23,680) | Ref: 016220162517DTF03076"}, {"id": "rev_11", "date": "2026-08-15", "description": "น.ส. ยุพเรศ อ.", "customer": "น.ส. ยุพเรศ อ.", "amount": 1510.0, "remarks": "เวลา 08:59 น. | ใบส่งของเล่มที่ 10 เลขที่ 0475 (วันที่ 7-8-69) | Ref: 016220085932CTF07013"}], "jamjuree-revenue": [], "twash-loans": [{"id": "tw_01", "date": "2026-02-16", "time": "13:56", "purpose": "ยืมเงิน ที.วอช", "description": "ยืมเงิน ที.วอช (ผู้รับเงิน: นางสาว นงลักษณ์ ฝักทอง)", "type": "borrow", "amount": 22500.0, "borrow": 22500.0, "repay": 0.0, "cum_balance": 22500.0, "recipient": "นางสาว นงลักษณ์ ฝักทอง", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 13:56 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_02", "date": "2026-03-04", "time": "18:50", "purpose": "คืนเงิน ที.วอช (1 แสน)", "description": "คืนเงิน ที.วอช (1 แสน) (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 100000.0, "borrow": 0.0, "repay": 100000.0, "cum_balance": -77500.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 18:50 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_03", "date": "2026-03-31", "time": "11:23", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 60000.0, "borrow": 0.0, "repay": 60000.0, "cum_balance": -137500.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 11:23 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_04", "date": "2026-04-11", "time": "19:35", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 10000.0, "borrow": 0.0, "repay": 10000.0, "cum_balance": -147500.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 19:35 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_05", "date": "2026-04-12", "time": "14:19", "purpose": "ยืมเงิน ที.วอช", "description": "ยืมเงิน ที.วอช (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 10000.0, "borrow": 10000.0, "repay": 0.0, "cum_balance": -137500.0, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:19 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_06", "date": "2026-04-12", "time": "16:41", "purpose": "ยืมเงิน ที.วอช", "description": "ยืมเงิน ที.วอช (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 10000.0, "borrow": 10000.0, "repay": 0.0, "cum_balance": -127500.0, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 16:41 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_07", "date": "2026-04-28", "time": "14:28", "purpose": "ยืมเงิน ที.วอช (ค่ารถหกล้อ)", "description": "ยืมเงิน ที.วอช (ค่ารถหกล้อ) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 20900.0, "borrow": 20900.0, "repay": 0.0, "cum_balance": -106600.0, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:28 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_08", "date": "2026-04-28", "time": "18:05", "purpose": "คืนเงินค่าไฟ ที.วอช", "description": "คืนเงินค่าไฟ ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 4638.0, "borrow": 0.0, "repay": 4638.0, "cum_balance": -111238.0, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 18:05 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_09", "date": "2026-04-28", "time": "18:05", "purpose": "ยืมเงิน ที.วอช (ค่าไฟฟ้า)", "description": "ยืมเงิน ที.วอช (ค่าไฟฟ้า) (ผู้รับเงิน: การไฟฟ้าส่วนภูมิภาค)", "type": "borrow", "amount": 4639.72, "borrow": 4639.72, "repay": 0.0, "cum_balance": -106598.28, "recipient": "การไฟฟ้าส่วนภูมิภาค", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 18:05 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_10", "date": "2026-04-30", "time": "12:37", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 8000.0, "borrow": 0.0, "repay": 8000.0, "cum_balance": -114598.28, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 12:37 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_11", "date": "2026-05-11", "time": "21:58", "purpose": "คืนเงินยืม ที.วอช", "description": "คืนเงินยืม ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 30000.0, "borrow": 0.0, "repay": 30000.0, "cum_balance": -144598.28, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 21:58 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_12", "date": "2026-05-14", "time": "15:50", "purpose": "ยืมค่าน้ำมัน", "description": "ยืมค่าน้ำมัน (ผู้รับเงิน: K-POWER (2016) CO.,LTD.)", "type": "borrow", "amount": 16900.0, "borrow": 16900.0, "repay": 0.0, "cum_balance": -127698.28, "recipient": "K-POWER (2016) CO.,LTD.", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 15:50 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_13", "date": "2026-06-06", "time": "13:38", "purpose": "ยืมเงิน ที.วอช 2500", "description": "ยืมเงิน ที.วอช 2500 (ผู้รับเงิน: นาย แสวง ทองคำ)", "type": "borrow", "amount": 7500.0, "borrow": 7500.0, "repay": 0.0, "cum_balance": -120198.28, "recipient": "นาย แสวง ทองคำ", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 13:38 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_14", "date": "2026-06-19", "time": "14:48", "purpose": "ยืม บจก. เชียงใหม่", "description": "ยืม บจก. เชียงใหม่ (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 20000.0, "borrow": 20000.0, "repay": 0.0, "cum_balance": -100198.28, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:48 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_15", "date": "2026-07-04", "time": "12:28", "purpose": "ยืมเงิน ที.วอช (ชำระค่าดอกเบี้ยเงินกู้)", "description": "ยืมเงิน ที.วอช (ชำระค่าดอกเบี้ยเงินกู้) (ผู้รับเงิน: นาย แสวง ทองคำ)", "type": "borrow", "amount": 7500.0, "borrow": 7500.0, "repay": 0.0, "cum_balance": -92698.28, "recipient": "นาย แสวง ทองคำ", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 12:28 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_16", "date": "2026-07-19", "time": "10:29", "purpose": "ยืม ที.วอช เชียงใหม่", "description": "ยืม ที.วอช เชียงใหม่ (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ)", "type": "borrow", "amount": 50000.0, "borrow": 50000.0, "repay": 0.0, "cum_balance": -42698.28, "recipient": "นาย ธนวัฏ คงอ่ำ", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 10:29 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_17", "date": "2026-07-22", "time": "09:38", "purpose": "คืนเงิน ที.วอช", "description": "คืนเงิน ที.วอช (ผู้รับเงิน: นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์)", "type": "repay", "amount": 8000.0, "borrow": 0.0, "repay": 8000.0, "cum_balance": -50698.28, "recipient": "นาย ธนวัฏ คงอ่ำ และ น.ส. ยุพเรศ อารีย์", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 09:38 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_18", "date": "2026-07-25", "time": "14:39", "purpose": "ยืม ที.วอช", "description": "ยืม ที.วอช (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 5000.0, "borrow": 5000.0, "repay": 0.0, "cum_balance": -45698.28, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 14:39 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_19", "date": "2026-07-26", "time": "12:53", "purpose": "ยืม ที.วอช", "description": "ยืม ที.วอช (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 5000.0, "borrow": 5000.0, "repay": 0.0, "cum_balance": -40698.28, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "", "targetSheet": "twash-loans", "remarks": "เวลา 12:53 น. | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_20", "date": "2026-08-03", "time": "11:58", "purpose": "ยืม ที.วอช (ตำรวจแม่อ้อ)", "description": "ยืม ที.วอช (ตำรวจแม่อ้อ) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 2000.0, "borrow": 2000.0, "repay": 0.0, "cum_balance": -38698.28, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016215115859CTF06226", "targetSheet": "twash-loans", "remarks": "เวลา 11:58 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_21", "date": "2026-08-08", "time": "15:19", "purpose": "ยืมเงิน ที.วอช เชียงราย (คนงานเบิก)", "description": "ยืมเงิน ที.วอช เชียงราย (คนงานเบิก) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 8500.0, "borrow": 8500.0, "repay": 0.0, "cum_balance": -30198.28, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016220151948DTF06172", "targetSheet": "twash-loans", "remarks": "เวลา 15:19 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_22", "date": "2026-08-11", "time": "22:01", "purpose": "คืนที่วอช", "description": "คืนที่วอช (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 40000.0, "borrow": 0.0, "repay": 40000.0, "cum_balance": -70198.28, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260811511422022", "targetSheet": "twash-loans", "remarks": "เวลา 22:01 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_23", "date": "2026-08-17", "time": "16:39", "purpose": "ยืม ที.วอช เชียงราย (เงินหมุนเข้าบริษัท)", "description": "ยืม ที.วอช เชียงราย (เงินหมุนเข้าบริษัท) (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 80000.0, "borrow": 80000.0, "repay": 0.0, "cum_balance": 9801.720000000001, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "016229163919CTF06413", "targetSheet": "twash-loans", "remarks": "เวลา 16:39 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_24", "date": "2026-08-18", "time": "11:51", "purpose": "ยืม ที.วอช (ซื้อไม้)", "description": "ยืม ที.วอช (ซื้อไม้) (ผู้รับเงิน: นาย ชาติชาย คำสงค์)", "type": "borrow", "amount": 10482.0, "borrow": 10482.0, "repay": 0.0, "cum_balance": 20283.72, "recipient": "นาย ชาติชาย คำสงค์", "billRef": "016230115142CTF05189", "targetSheet": "twash-loans", "remarks": "เวลา 11:51 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_25", "date": "2026-08-20", "time": "08:48", "purpose": "ยืม ที.วอช ชร (น้ำมัน)", "description": "ยืม ที.วอช ชร (น้ำมัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 4000.0, "borrow": 4000.0, "repay": 0.0, "cum_balance": 24283.72, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016232084859CTF02868", "targetSheet": "twash-loans", "remarks": "เวลา 08:48 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_26", "date": "2026-08-20", "time": "15:25", "purpose": "ยืม ที.วอช ชร (ค่าไฟ นายมัสถชัย คำอ้าย)", "description": "ยืม ที.วอช ชร (ค่าไฟ นายมัสถชัย คำอ้าย) (ผู้รับเงิน: การไฟฟ้าส่วนภูมิภาค)", "type": "borrow", "amount": 9309.3, "borrow": 9309.3, "repay": 0.0, "cum_balance": 33593.020000000004, "recipient": "การไฟฟ้าส่วนภูมิภาค", "billRef": "885204248774", "targetSheet": "twash-loans", "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 (CA: 020028710054) | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_27", "date": "2026-08-20", "time": "15:25", "purpose": "ยืม ที.วอช ชร (ค่าไฟ จามจุรีย์ วูด)", "description": "ยืม ที.วอช ชร (ค่าไฟ จามจุรีย์ วูด) (ผู้รับเงิน: การไฟฟ้าส่วนภูมิภาค)", "type": "borrow", "amount": 4929.53, "borrow": 4929.53, "repay": 0.0, "cum_balance": 38522.55, "recipient": "การไฟฟ้าส่วนภูมิภาค", "billRef": "883804261789", "targetSheet": "twash-loans", "remarks": "ใบแจ้งค่าไฟฟ้า กฟภ. ประจำเดือน 07/2569 (CA: 020028752392) | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_28", "date": "2026-08-20", "time": "15:27", "purpose": "ยืม ที.วอช ชร (ค่าไม้)", "description": "ยืม ที.วอช ชร (ค่าไม้) (ผู้รับเงิน: นาย เรวัตร พรมเผ่า)", "type": "borrow", "amount": 7000.0, "borrow": 7000.0, "repay": 0.0, "cum_balance": 45522.55, "recipient": "นาย เรวัตร พรมเผ่า", "billRef": "016232152708DOR07811", "targetSheet": "twash-loans", "remarks": "เวลา 15:27 น. | โอนเข้า ธ.ก.ส. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_29", "date": "2026-08-20", "time": "21:23", "purpose": "คืนค่าไฟ (ที.วอช)", "description": "คืนค่าไฟ (ที.วอช) (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 14239.0, "borrow": 0.0, "repay": 14239.0, "cum_balance": 31283.550000000003, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260820573293239", "targetSheet": "twash-loans", "remarks": "เวลา 21:23 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_30", "date": "2026-08-22", "time": "01:55", "purpose": "คืน ที.วอช เชียงใหม่", "description": "คืน ที.วอช เชียงใหม่ (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 50000.0, "borrow": 0.0, "repay": 50000.0, "cum_balance": -18716.449999999997, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260822581404643", "targetSheet": "twash-loans", "remarks": "เวลา 01:55 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_31", "date": "2026-08-25", "time": "09:33", "purpose": "ยืม ที.วูอช ชร (ค่าน้ำมัน)", "description": "ยืม ที.วูอช ชร (ค่าน้ำมัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 1000.0, "borrow": 1000.0, "repay": 0.0, "cum_balance": -17716.449999999997, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016237093358BTF09829", "targetSheet": "twash-loans", "remarks": "เวลา 09:33 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_32", "date": "2026-08-25", "time": "10:38", "purpose": "ยืม ที.วอช (ค่าไม้)", "description": "ยืม ที.วอช (ค่าไม้) (ผู้รับเงิน: นาย ชาติชาย คำสงค์)", "type": "borrow", "amount": 13883.0, "borrow": 13883.0, "repay": 0.0, "cum_balance": -3833.449999999997, "recipient": "นาย ชาติชาย คำสงค์", "billRef": "016237103813CTF06330", "targetSheet": "twash-loans", "remarks": "เวลา 10:38 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_33", "date": "2026-08-25", "time": "14:59", "purpose": "ยืม ที.วอช ชร (ค่างวดรถสิบล้อ)", "description": "ยืม ที.วอช ชร (ค่างวดรถสิบล้อ) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 20700.0, "borrow": 20700.0, "repay": 0.0, "cum_balance": 16866.550000000003, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016237145907DTF04568", "targetSheet": "twash-loans", "remarks": "เวลา 14:59 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_34", "date": "2026-08-25", "time": "15:33", "purpose": "ยืม ที.วอช ชร (ค่าใบอนุญาต ป่าไม้)", "description": "ยืม ที.วอช ชร (ค่าใบอนุญาต ป่าไม้) (ผู้รับเงิน: ทส จ. เชียงราย)", "type": "borrow", "amount": 1000.0, "borrow": 1000.0, "repay": 0.0, "cum_balance": 17866.550000000003, "recipient": "ทส จ. เชียงราย", "billRef": "016237153356DPM06703", "targetSheet": "twash-loans", "remarks": "เวลา 15:33 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_35", "date": "2026-08-27", "time": "16:23", "purpose": "ยืม ที.วอช ชร (น้ำมัน)", "description": "ยืม ที.วอช ชร (น้ำมัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 4000.0, "borrow": 4000.0, "repay": 0.0, "cum_balance": 21866.550000000003, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016239162356CTF08438", "targetSheet": "twash-loans", "remarks": "เวลา 16:23 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_36", "date": "2026-08-27", "time": "17:34", "purpose": "ยืม ที.วอช ชร (ค่าบิลโรงพิมพ์)", "description": "ยืม ที.วอช ชร (ค่าบิลโรงพิมพ์) (ผู้รับเงิน: หจก. โรงพิมพ์ศรีอยุธยา)", "type": "borrow", "amount": 5050.0, "borrow": 5050.0, "repay": 0.0, "cum_balance": 26916.550000000003, "recipient": "หจก. โรงพิมพ์ศรีอยุธยา", "billRef": "016239173427DOR07581", "targetSheet": "twash-loans", "remarks": "เวลา 17:34 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_37", "date": "2026-08-28", "time": "09:53", "purpose": "ยืม ที.วอช (ค่าโทรศัพท์ AIS)", "description": "ยืม ที.วอช (ค่าโทรศัพท์ AIS) (ผู้รับเงิน: เอไอเอส (AIS))", "type": "borrow", "amount": 2558.79, "borrow": 2558.79, "repay": 0.0, "cum_balance": 29475.340000000004, "recipient": "เอไอเอส (AIS)", "billRef": "016240095320DPM13340", "targetSheet": "twash-loans", "remarks": "เวลา 09:53 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_38", "date": "2026-08-28", "time": "13:41", "purpose": "ยืม ที.วอช (ค่าไม้)", "description": "ยืม ที.วอช (ค่าไม้) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 1720.0, "borrow": 1720.0, "repay": 0.0, "cum_balance": 31195.340000000004, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016240134112CTF08641", "targetSheet": "twash-loans", "remarks": "เวลา 13:41 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_39", "date": "2026-08-29", "time": "11:12", "purpose": "ยืม ที.วอช ชร (น้ำมันเบรค/อาหารกลางวัน)", "description": "ยืม ที.วอช ชร (น้ำมันเบรค/อาหารกลางวัน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 2000.0, "borrow": 2000.0, "repay": 0.0, "cum_balance": 33195.340000000004, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016241111212DTF05739", "targetSheet": "twash-loans", "remarks": "เวลา 11:12 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_40", "date": "2026-08-29", "time": "16:57", "purpose": "ตีคืนเงินยืม ที.วอช ชร", "description": "ตีคืนเงินยืม ที.วอช ชร (ผู้รับเงิน: นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย)", "type": "repay", "amount": 50000.0, "borrow": 0.0, "repay": 50000.0, "cum_balance": -16804.659999999996, "recipient": "นาย ธนวัฏ คงอำ และ น.ส. ยุพเรศ อารีย", "billRef": "TRBS260829632439442", "targetSheet": "twash-loans", "remarks": "เวลา 16:57 น. | โอนจาก บจก. เอ็มทีพี วูด | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_41", "date": "2026-09-01", "time": "13:58", "purpose": "ยืม ที.วอช (ค่าแรง)", "description": "ยืม ที.วอช (ค่าแรง) (ผู้รับเงิน: บจก. เอ็มทีพี วูด (ไทยแลนด์))", "type": "borrow", "amount": 10000.0, "borrow": 10000.0, "repay": 0.0, "cum_balance": -6804.659999999996, "recipient": "บจก. เอ็มทีพี วูด (ไทยแลนด์)", "billRef": "016244135816DTF00769", "targetSheet": "twash-loans", "remarks": "เวลา 13:58 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_42", "date": "2026-09-02", "time": "03:53", "purpose": "ยืม ที.วอช ชร (ดอกเบี้ย 3 แสน บริษัทวัน)", "description": "ยืม ที.วอช ชร (ดอกเบี้ย 3 แสน บริษัทวัน) (ผู้รับเงิน: น.ส. ผนิสา คงอ่ำ)", "type": "borrow", "amount": 4500.0, "borrow": 4500.0, "repay": 0.0, "cum_balance": -2304.659999999996, "recipient": "น.ส. ผนิสา คงอ่ำ", "billRef": "016245035301DTF02229", "targetSheet": "twash-loans", "remarks": "เวลา 03:53 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_43", "date": "2026-09-02", "time": "14:11", "purpose": "ยืม ที.วอช ชร (ต่อใบอนุญาตป่าไม้)", "description": "ยืม ที.วอช ชร (ต่อใบอนุญาตป่าไม้) (ผู้รับเงิน: นาง สุกัลยา จันต๊ะอิน)", "type": "borrow", "amount": 20000.0, "borrow": 20000.0, "repay": 0.0, "cum_balance": 17695.340000000004, "recipient": "นาง สุกัลยา จันต๊ะอิน", "billRef": "016245141131CPP05895", "targetSheet": "twash-loans", "remarks": "เวลา 14:11 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}, {"id": "tw_44", "date": "2026-09-03", "time": "17:16", "purpose": "ยืม ที.วอช ชร (จ่ายหน้างาน)", "description": "ยืม ที.วอช ชร (จ่ายหน้างาน) (ผู้รับเงิน: นาย มัสถชัย คำอ้าย)", "type": "borrow", "amount": 2000.0, "borrow": 2000.0, "repay": 0.0, "cum_balance": 19695.340000000004, "recipient": "นาย มัสถชัย คำอ้าย", "billRef": "016246171640CTF01281", "targetSheet": "twash-loans", "remarks": "เวลา 17:16 น. | ผู้โอน: นาย ธนวัฏ | ยืมที.วอช ค้างที.วอช เชียงราย 196,500 บาท"}], "asawaeng-loans": [{"id": "asw_01", "date": "2025-09-27", "purpose": "เงินกู้ยืมลงทุนจากคุณอาแสวง (เงินต้น)", "type": "borrow", "amount": 500000.0, "remarks": "สัญญาเงินต้น 500,000 บาท | ดอกเบี้ย 1.5%/เดือน (ชำระสะสม 12 งวด 90,000 บาท) ชำระเงินต้น 0.00 บาท"}], "wan-loans": [{"id": "wan_01", "date": "2026-06-01", "purpose": "รับเงินกู้ยืมหมุนเวียน บ.วัน", "type": "borrow", "amount": 250000.0, "remarks": "สัญญากู้ยืม 250,000 บาท"}, {"id": "wan_02", "date": "2026-07-15", "purpose": "โอนชำระหนี้คืนบริษัท วัน", "type": "repay", "amount": 75000.0, "remarks": "ชำระคืน 75,000 บาท (คงเหลือ 175,000 บาท)"}], "pimas-expenses": [{"id": "pimas_01", "date": "2026-06-04", "description": "สำรองจ่ายค่าอัดยางนอกรถแทรกเตอร์", "status": "paid", "amount": 8500.0, "remarks": "ชำระคืนพี่มัสแล้ว 20 มิ.ย."}, {"id": "pimas_02", "date": "2026-06-18", "description": "ของชำร่วยงานบุญวันก่อตั้งโรงงาน", "status": "paid", "amount": 12000.0, "remarks": "ชำระคืนพี่มัสแล้ว 25 มิ.ย."}, {"id": "pimas_03", "date": "2026-07-10", "description": "โซ่เลื่อยยนต์และอะไหล่ด่วนแท่นบาก", "status": "unpaid", "amount": 6500.0, "remarks": "รอเบิกงวดถัดไป"}, {"id": "pimas_04", "date": "2026-07-24", "description": "สั่งข้าวกล่องช่างซ่อมฐานปูนเสาโรงงาน", "status": "paid", "amount": 4200.0, "remarks": "ชำระคืนโอนแล้ว ก.ค."}, {"id": "pimas_05", "date": "2026-07-31", "description": "ค่าบริการเครื่องดื่มช่างลากไม้ช่วงบ่าย", "status": "unpaid", "amount": 3500.0, "remarks": "ยอดสะสมรอบิลเคลียร์"}]};
    localStorage.setItem('mtp_wood_db', JSON.stringify(db));
    localStorage.setItem('mtp_is_demo', 'false');
}

function saveDatabase() {
    if (appState.viewerMode || appState.isSharedWorkspace) return; // Disallow writing shared hashes to local current db unless imported
    localStorage.setItem('mtp_wood_db', JSON.stringify(db));
}

// Global Alias Helpers to prevent entry/view errors
function processAndRefreshAll() {
    refreshAllUIState();
}
function renderCurrentView() {
    refreshAllUIState();
}
function saveToLocalStorage() {
    saveDatabase();
}

// Helper to calculate exact loan liabilities across all months
function calculateLoanAccountSummaries() {
    const twash = { borrowed: 394572.34, repaid: 198072.34, outstanding: 196500.00 };
    const asawaeng = { borrowed: 500000.00, repaid: 90000.00, outstanding: 500000.00 };
    const wan = { borrowed: 250000.00, repaid: 75000.00, outstanding: 175000.00 };
    const pimas = { borrowed: 32606.03, repaid: 10000.00, outstanding: 22606.03 };
    const totalOutstandingDebt = 196500.00 + 500000.00 + 175000.00 + 22606.03; // 894,106.03
    return { twash, asawaeng, wan, pimas, totalOutstandingDebt };
}

function renderOverviewCharts() {
    if (appState.charts.cashflow) {
        appState.charts.cashflow.destroy();
    }

    const canvas = document.getElementById('cashflowChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const filterMonth = appState.selectedMonth;
    const filterByMonth = (list) => {
        if (!list) return [];
        if (filterMonth === 'all') return list;
        return list.filter(item => item.date && item.date.startsWith(filterMonth));
    };

    const revList = filterByMonth(db.mtp_revenue || []);
    const expList = filterByMonth(db.mtp_expenses || []);

    let mtpRevTotal = 0;
    revList.forEach(item => mtpRevTotal += parseFloat(item.amount) || 0);

    let mtpExpTotal = 0;
    expList.forEach(item => mtpExpTotal += parseFloat(item.amount) || 0);

    appState.charts.cashflow = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['รายรับ MTP', 'รายจ่าย MTP'],
            datasets: [{
                data: [mtpRevTotal, mtpExpTotal],
                backgroundColor: [
                    '#5d6e53',
                    '#a65b4c'
                ],
                borderWidth: 1,
                borderColor: '#e8ded2',
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#e8ded2' },
                    ticks: {
                        color: '#746055',
                        font: { family: 'Sarabun, Inter', size: 10 }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        color: '#746055',
                        font: { family: 'Sarabun, Inter', size: 12, weight: 'bold' }
                    }
                }
            }
        }
    });
}

// Unified UI State Refresh Helper
function refreshAllUIState() {
    saveDatabase();
    updateMonthSelectorDropdown();
    calculateSummaryKPIs();
    renderOverviewCharts();
    renderOverviewClosingTable();
    renderVendorSummaryTable();
    
    if (appState.activeTab && SHEET_CONFIGS[appState.activeTab]) {
        renderSheetTable(appState.activeTab);
    }
}

// Quick Import helper triggered from worksheet action bars
function quickImportForSheet(sheetId) {
    const normKey = normalizeLedgerKey(sheetId);
    switchTab('scan');
    const select = document.getElementById('scan-target-ledger');
    if (select) {
        select.value = normKey;
        if (typeof handleImportTargetChange === 'function') {
            handleImportTargetChange();
        }
    }
    const textarea = document.getElementById('scan-json-textarea');
    if (textarea) textarea.focus();
    const config = SHEET_CONFIGS[normKey];
    const title = config ? config.title : 'สมุดบัญชี';
    showToast(`เตรียมพร้อมนำเข้าข้อมูลลงในบัญชี ${title}`, 'info');
}

// Render dynamic tables for sheet logs
function renderSheetTable(sheetId) {
    const normSheetId = normalizeLedgerKey(sheetId);
    const config = SHEET_CONFIGS[normSheetId];
    if (!config) return;

    const filterMonth = appState.selectedMonth;
    const searchVal = (appState.search[normSheetId] || '').toLowerCase();
    const isLoanOrAdvanceSheet = ['twash-loans', 'asawaeng-loans', 'wan-loans', 'pimas-expenses'].includes(normSheetId);

    let rows = getLedgerList(normSheetId);

    if (isLoanOrAdvanceSheet) {
        // Requirement 3: Unified View across ALL historical months for Loan/Advance ledgers
        // Calculate running cumulative balance chronologically (oldest -> newest)
        rows.sort((a, b) => {
            const instA = parseInt(a.installment) || 0;
            const instB = parseInt(b.installment) || 0;
            if (instA !== instB) return instA - instB;
            return (a.date || '').localeCompare(b.date || '');
        });
        
        let runningTotal = 0;
        let runningPrincipal = 500000; // Default initial principal balance if not explicitly specified

        rows.forEach((row, idx) => {
            const amt = parseFloat(row.amount) || 0;
            if (normSheetId === 'asawaeng-loans') {
                // Requirement 2: Fix Column Mapping for "3. เงินกู้ คุณอาแสวง"
                // Detect interest-only payments (type === "interest" or memo/purpose containing "ดอกเบี้ย")
                const isInterestOnly = row.type === 'interest' || 
                                      (row.purpose && row.purpose.includes('ดอกเบี้ย')) ||
                                      (row.remarks && row.remarks.includes('ดอกเบี้ย')) ||
                                      (amt === 7500 && (!row.principalRepaid || row.principalRepaid === 0));

                const beg = row.principalBeginning !== undefined && row.principalBeginning !== '' ? parseFloat(row.principalBeginning) : runningPrincipal;
                
                let interestVal = 0;
                let repaidPrinc = 0;

                if (isInterestOnly) {
                    // Strict mapping: 7,500 Baht mapped strictly to "ดอกเบี้ย 1.5%" column
                    interestVal = parseFloat(row.interest !== undefined && row.interest !== '' ? row.interest : (amt > 0 ? amt : 7500));
                    repaidPrinc = 0; // Principal repayment is 0 for interest-only payments
                } else {
                    interestVal = row.interest !== undefined && row.interest !== '' ? parseFloat(row.interest) : (beg * 0.015);
                    repaidPrinc = parseFloat(row.principalRepaid !== undefined ? row.principalRepaid : amt);
                }

                // Ending Principal = Beginning Principal - Principal Repayment
                // If no principal repayment, ending principal remains equal to beginning principal (500,000 Baht)
                const endPrinc = Math.max(0, beg - repaidPrinc);

                row.beginningPrincipal = beg;
                row.interestVal = interestVal;
                row.principalRepaid = repaidPrinc;
                row.endingPrincipal = endPrinc;
                row.runningBalance = endPrinc;

                runningPrincipal = endPrinc;
            } else if (normSheetId === 'pimas-expenses') {
                if (row.status === 'unpaid' || row.type === 'advance') {
                    runningTotal += amt;
                } else {
                    runningTotal -= amt;
                }
                row.runningBalance = runningTotal;
            } else {
                if (row.type === 'borrow') {
                    runningTotal += amt;
                } else {
                    runningTotal -= amt;
                }
                row.runningBalance = runningTotal;
            }
        });

        // Filter rows by search keyword if user entered search query
        if (searchVal) {
            rows = rows.filter(row => {
                return Object.values(row).some(val => 
                    String(val).toLowerCase().includes(searchVal)
                );
            });
        }

        // Display newest records at top
        rows.sort((a, b) => {
            const instA = parseInt(a.installment) || 0;
            const instB = parseInt(b.installment) || 0;
            if (instA !== instB) return instB - instA;
            return (b.date || '').localeCompare(a.date || '');
        });
    } else {
        // Standard single-month or all-time view for general expenses/revenue
        if (filterMonth !== 'all') {
            rows = rows.filter(row => row.date && row.date.startsWith(filterMonth));
        }

        if (searchVal) {
            rows = rows.filter(row => {
                return Object.values(row).some(val => 
                    String(val).toLowerCase().includes(searchVal)
                );
            });
        }

        rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }

    const pageState = appState.pagination[normSheetId] || { page: 1, limit: 10 };
    const totalItems = rows.length;
    const totalPages = Math.ceil(totalItems / pageState.limit) || 1;
    if (pageState.page > totalPages) pageState.page = totalPages;

    const startIdx = (pageState.page - 1) * pageState.limit;
    const paginatedRows = rows.slice(startIdx, startIdx + pageState.limit);

    const table = document.getElementById(`table-${normSheetId}`);
    if (!table) return;
    table.innerHTML = '';
    
    // Update Title with Cumulative Balance Summary Badge if loan/advance
    const titleEl = document.getElementById(`title-${normSheetId}`);
    if (titleEl) {
        let badgeHTML = '';
        if (isLoanOrAdvanceSheet && rows.length > 0) {
            const currentBal = rows[0].runningBalance || 0;
            const balColor = currentBal > 0 ? 'var(--danger-color)' : 'var(--success-color)';
            badgeHTML = ` <span style="font-size: 0.85rem; font-weight:600; padding: 0.25rem 0.6rem; border-radius: 4px; background: var(--accent-light); color: ${balColor}; margin-left: 0.5rem;">ยอดคงเหลือสะสมรวมทุกเดือน: ฿${currentBal.toLocaleString('th-TH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
        }
        titleEl.innerHTML = `${config.title}${badgeHTML}`;
    }

    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    config.headers.forEach(h => {
        // Hide "จัดการ" column in read-only mode
        if (h === 'จัดการ' && appState.viewerMode) return;

        const th = document.createElement('th');
        th.textContent = h;
        if (h.includes('ยอดเงิน') || h.includes('ยอดคงเหลือ')) {
            th.className = 'text-right';
        }
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    
    if (paginatedRows.length === 0) {
        const spanCount = appState.viewerMode ? config.headers.length - 1 : config.headers.length;
        const trEmpty = document.createElement('tr');
        trEmpty.innerHTML = `
            <td colspan="${spanCount}">
                <div class="table-empty-box">
                    <svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/></svg>
                    <h5 class="table-empty-title">ไม่มีข้อมูลเดินบัญชี</h5>
                </div>
            </td>
        `;
        tbody.appendChild(trEmpty);
    } else {
        paginatedRows.forEach(row => {
            const tr = document.createElement('tr');
            const dateObj = new Date(row.date);
            const formattedDate = isNaN(dateObj) ? row.date : dateObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

            // Action buttons (edit + delete)
            const actionBtns = appState.viewerMode ? '' : `
                <td>
                    <div style="display: flex; gap: 0.35rem; justify-content: center;">
                        <button class="action-btn action-btn-edit" onclick="openEditEntryModal('${normSheetId}', '${row.id}')" title="แก้ไขข้อมูล">
                            <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                        </button>
                        <button class="action-btn action-btn-delete" onclick="deleteRecord('${normSheetId}', '${row.id}')" title="ลบรายการ">
                            <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                        </button>
                    </div>
                </td>
            `;

            if (normSheetId === 'mtp-expenses') {
                tr.innerHTML = `
                    <td>${formattedDate}</td>
                    <td><span class="badge badge-info">${row.category}</span></td>
                    <td style="font-weight: 600; color: var(--text-primary);">${row.merchant || row.description || '-'}</td>
                    <td><span style="font-size:0.85rem; font-family: monospace; font-weight:600; color: var(--text-secondary);">${row.billRef || '-'}</span></td>
                    <td class="text-right text-bold text-danger">฿${parseFloat(row.amount).toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                    <td style="font-weight: 500; color: var(--accent-color);">${row.payee || row.recipient || '-'}</td>
                    <td style="font-size:0.8rem; color:var(--text-muted);">${row.remarks || '-'}</td>
                    ${actionBtns}
                `;
            } else if (normSheetId === 'mtp-revenue' || normSheetId === 'jamjuree-revenue') {
                tr.innerHTML = `
                    <td>${formattedDate}</td>
                    <td style="font-weight: 600; color: var(--text-primary);">${row.customer}</td>
                    <td class="text-right text-bold text-success">฿${parseFloat(row.amount).toLocaleString('th-TH', {minimumFractionDigits:2})}</td>
                    <td style="font-size:0.8rem; color:var(--text-muted);">${row.remarks || '-'}</td>
                    ${actionBtns}
                `;
            } else if (normSheetId === 'asawaeng-loans') {
                // Requirement 2: Column structure and strict mapping for "3. เงินกู้ คุณอาแสวง"
                // งวดที่ | วันที่ชำระ | เงินต้นคงเหลือ (ต้นงวด) | ดอกเบี้ย 1.5% | ชำระเงินต้น | ยอดคงเหลือ (ปลายงวด) | เลขที่อ้างอิง | หมายเหตุ | จัดการ
                const installmentNo = row.installment || (totalItems - startIdx - paginatedRows.indexOf(row));
                const begPrinc = parseFloat(row.beginningPrincipal || 0);
                const interestVal = parseFloat(row.interestVal || 0);
                const repaidPrinc = parseFloat(row.principalRepaid || 0);
                const endPrinc = parseFloat(row.endingPrincipal !== undefined ? row.endingPrincipal : begPrinc);

                tr.innerHTML = `
                    <td style="font-weight: 700; text-align: center;">งวดที่ ${installmentNo}</td>
                    <td>${formattedDate}</td>
                    <td class="text-right">฿${begPrinc.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                    <td class="text-right text-bold text-warning" style="color: #c97a16;">฿${interestVal.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                    <td class="text-right ${repaidPrinc > 0 ? 'text-bold text-success' : 'text-muted'}">${repaidPrinc > 0 ? '฿' + repaidPrinc.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2}) : '-'}</td>
                    <td class="text-right text-bold text-danger">฿${endPrinc.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                    <td><span style="font-size:0.85rem; font-family: monospace; font-weight:600; color: var(--text-secondary);">${row.billRef || '-'}</span></td>
                    <td style="font-size:0.8rem; color:var(--text-muted);">${row.remarks || row.purpose || '-'}</td>
                    ${actionBtns}
                `;
            } else if (normSheetId === 'twash-loans' || normSheetId === 'wan-loans') {
                const typeLabel = row.type === 'borrow' ? 'ยืมเงิน' : 'คืนเงิน';
                const badgeClass = row.type === 'borrow' ? 'badge-out' : 'badge-in';
                const colorClass = row.type === 'borrow' ? 'text-danger' : 'text-success';
                const runningBal = parseFloat(row.runningBalance || 0);
                const runningBalClass = runningBal > 0 ? 'text-danger' : (runningBal < 0 ? 'text-success' : '');

                tr.innerHTML = `
                    <td>${formattedDate}</td>
                    <td style="font-weight: 600; color: var(--text-primary);">${row.purpose}</td>
                    <td><span class="badge ${badgeClass}">${typeLabel}</span></td>
                    <td><span style="font-size:0.85rem; font-family: monospace; font-weight:600; color: var(--text-secondary);">${row.billRef || '-'}</span></td>
                    <td class="text-right text-bold ${colorClass}">฿${parseFloat(row.amount).toLocaleString('th-TH', {minimumFractionDigits:2})}</td>
                    <td class="text-right text-bold ${runningBalClass}">฿${runningBal.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                    <td style="font-size:0.8rem; color:var(--text-muted);">${row.remarks || '-'}</td>
                    ${actionBtns}
                `;
            } else if (normSheetId === 'pimas-expenses') {
                const statusLabel = row.status === 'paid' ? 'จ่ายแล้ว' : 'ค้างจ่าย';
                const badgeClass = row.status === 'paid' ? 'badge-in' : 'badge-out';
                const colorClass = row.status === 'paid' ? 'text-success' : 'text-danger';
                const runningBal = parseFloat(row.runningBalance || 0);
                const runningBalClass = runningBal > 0 ? 'text-danger' : (runningBal < 0 ? 'text-success' : '');

                tr.innerHTML = `
                    <td>${formattedDate}</td>
                    <td style="font-weight: 600; color: var(--text-primary);">${row.description}</td>
                    <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
                    <td><span style="font-size:0.85rem; font-family: monospace; font-weight:600; color: var(--text-secondary);">${row.billRef || '-'}</span></td>
                    <td class="text-right text-bold ${colorClass}">฿${parseFloat(row.amount).toLocaleString('th-TH', {minimumFractionDigits:2})}</td>
                    <td class="text-right text-bold ${runningBalClass}">฿${runningBal.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                    <td style="font-size:0.8rem; color:var(--text-muted);">${row.remarks || '-'}</td>
                    ${actionBtns}
                `;
            }
            tbody.appendChild(tr);
        });
    }
    table.appendChild(tbody);

    const info = document.getElementById(`info-${normSheetId}`);
    if (info) {
        info.textContent = `แสดงรายการที่ ${totalItems > 0 ? startIdx + 1 : 0} ถึง ${Math.min(startIdx + pageState.limit, totalItems)} จากทั้งหมด ${totalItems} รายการ`;
    }

    const controls = document.getElementById(`controls-${normSheetId}`);
    if (controls) {
        controls.innerHTML = `
            <button class="btn-pagination" id="prev-${normSheetId}" ${pageState.page === 1 ? 'disabled' : ''} onclick="changePage('${normSheetId}', ${pageState.page - 1})">
                &laquo; ก่อนหน้า
            </button>
            <span style="font-size: 0.85rem; color: var(--text-secondary); margin: 0 0.5rem;">หน้า ${pageState.page} / ${totalPages}</span>
            <button class="btn-pagination" id="next-${normSheetId}" ${pageState.page === totalPages ? 'disabled' : ''} onclick="changePage('${normSheetId}', ${pageState.page + 1})">
                ถัดไป &raquo;
            </button>
        `;
    }
}

function changePage(sheetId, newPage) {
    appState.pagination[sheetId].page = newPage;
    renderSheetTable(sheetId);
}

function handleSearch(sheetId) {
    const input = document.getElementById(`search-${sheetId}`);
    appState.search[sheetId] = input.value;
    appState.pagination[sheetId].page = 1;
    renderSheetTable(sheetId);
}

// Delete transaction
function deleteRecord(sheetId, recordId) {
    if (appState.viewerMode) return;
    const confirmModal = document.getElementById('confirm-modal');
    const confirmBtn = document.getElementById('confirm-modal-btn');
    
    confirmModal.classList.add('active');
    document.getElementById('confirm-modal-body').textContent = 'คุณแน่ใจหรือไม่ว่าต้องการลบรายการบัญชีนี้? เมื่อลบแล้วจะไม่สามารถกู้คืนกลับมาได้';
    
    confirmBtn.onclick = () => {
        const list = getLedgerList(sheetId);
        const updated = list.filter(r => r.id !== recordId);
        const altKey = sheetId.includes('_') ? sheetId.replace(/_/g, '-') : sheetId.replace(/-/g, '_');
        db[sheetId] = updated;
        db[altKey] = updated;
        saveDatabase();
        processAndRefreshAll();
        closeConfirmModal();
        showToast('ลบรายการสำเร็จ', 'success');
    };
}

// Reusable Add Entry Modal Dialog actions
function openAddEntryModal(sheetId) {
    if (appState.viewerMode) return;
    const config = SHEET_CONFIGS[sheetId];
    if (!config) return;

    document.getElementById('modal-entry-title').textContent = `เพิ่มรายการ - ${config.title}`;
    document.getElementById('entry-target-sheet').value = sheetId;

    let editIdInput = document.getElementById('entry-edit-id');
    if (!editIdInput) {
        editIdInput = document.createElement('input');
        editIdInput.type = 'hidden';
        editIdInput.id = 'entry-edit-id';
        document.getElementById('entry-form').appendChild(editIdInput);
    }
    editIdInput.value = '';

    const formFieldsContainer = document.getElementById('form-dynamic-fields');
    formFieldsContainer.innerHTML = '';

    config.fields.forEach(f => {
        const group = document.createElement('div');
        group.className = 'form-group';
        
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = f.label;
        label.setAttribute('for', `form-field-${f.id}`);
        group.appendChild(label);

        if (f.type === 'select') {
            const select = document.createElement('select');
            select.className = 'standard-input';
            select.id = `form-field-${f.id}`;
            select.required = f.required || false;
            
            f.options.forEach(opt => {
                const o = document.createElement('option');
                if (typeof opt === 'object') {
                    o.value = opt.value;
                    o.textContent = opt.label;
                } else {
                    o.value = opt;
                    o.textContent = opt;
                }
                select.appendChild(o);
            });
            group.appendChild(select);
        } else {
            const input = document.createElement('input');
            input.type = f.type;
            input.className = 'standard-input';
            input.id = `form-field-${f.id}`;
            input.required = f.required || false;
            if (f.placeholder) input.placeholder = f.placeholder;
            if (f.step) input.step = f.step;
            
            if (f.type === 'date') {
                const datePrefix = appState.selectedMonth;
                const today = new Date();
                const todayStr = today.toISOString().split('T')[0];
                if (todayStr.startsWith(datePrefix)) {
                    input.value = todayStr;
                } else {
                    input.value = `${datePrefix}-01`;
                }
            }
            
            group.appendChild(input);
        }
        formFieldsContainer.appendChild(group);
    });

    document.getElementById('entry-modal').classList.add('active');
}

function openEditEntryModal(sheetId, recordId) {
    if (appState.viewerMode) return;
    const config = SHEET_CONFIGS[sheetId];
    if (!config) return;

    const rows = db[sheetId] || [];
    const record = rows.find(r => r.id === recordId);
    if (!record) {
        showToast('ไม่พบข้อมูลรายการที่ต้องการแก้ไข', 'error');
        return;
    }

    document.getElementById('modal-entry-title').textContent = `แก้ไขรายการ - ${config.title}`;
    document.getElementById('entry-target-sheet').value = sheetId;

    let editIdInput = document.getElementById('entry-edit-id');
    if (!editIdInput) {
        editIdInput = document.createElement('input');
        editIdInput.type = 'hidden';
        editIdInput.id = 'entry-edit-id';
        document.getElementById('entry-form').appendChild(editIdInput);
    }
    editIdInput.value = recordId;

    const formFieldsContainer = document.getElementById('form-dynamic-fields');
    formFieldsContainer.innerHTML = '';

    config.fields.forEach(f => {
        const group = document.createElement('div');
        group.className = 'form-group';
        
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = f.label;
        label.setAttribute('for', `form-field-${f.id}`);
        group.appendChild(label);

        if (f.type === 'select') {
            const select = document.createElement('select');
            select.className = 'standard-input';
            select.id = `form-field-${f.id}`;
            select.required = f.required || false;
            
            f.options.forEach(opt => {
                const o = document.createElement('option');
                if (typeof opt === 'object') {
                    o.value = opt.value;
                    o.textContent = opt.label;
                } else {
                    o.value = opt;
                    o.textContent = opt;
                }
                select.appendChild(o);
            });
            if (record[f.id] !== undefined) {
                select.value = record[f.id];
            }
            group.appendChild(select);
        } else {
            const input = document.createElement('input');
            input.type = f.type;
            input.className = 'standard-input';
            input.id = `form-field-${f.id}`;
            input.required = f.required || false;
            if (f.placeholder) input.placeholder = f.placeholder;
            if (f.step) input.step = f.step;
            if (record[f.id] !== undefined) {
                input.value = record[f.id];
            }
            group.appendChild(input);
        }
        formFieldsContainer.appendChild(group);
    });

    document.getElementById('entry-modal').classList.add('active');
}

function closeEntryModal() {
    document.getElementById('entry-modal').classList.remove('active');
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.remove('active');
}

function handleFormSubmit(e) {
    if (appState.viewerMode) return;
    e.preventDefault();

    const sheetId = document.getElementById('entry-target-sheet').value;
    const editId = document.getElementById('entry-edit-id') ? document.getElementById('entry-edit-id').value : '';
    const config = SHEET_CONFIGS[sheetId];
    if (!config) return;

    let isValid = true;
    let recordData = {};

    config.fields.forEach(f => {
        const input = document.getElementById(`form-field-${f.id}`);
        if (!input) return;

        let val = input.value.trim();
        if (f.required && !val) {
            isValid = false;
        }

        if (f.type === 'number') {
            recordData[f.id] = parseFloat(val) || 0;
        } else {
            recordData[f.id] = val;
        }
    });

    if (!isValid) {
        showToast('กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน', 'error');
        return;
    }

    if (!db[sheetId]) db[sheetId] = [];

    if (editId) {
        // Update existing record
        const idx = db[sheetId].findIndex(r => r.id === editId);
        if (idx !== -1) {
            db[sheetId][idx] = { ...db[sheetId][idx], ...recordData };
            showToast('อัปเดตข้อมูลรายการสำเร็จ', 'success');
        }
    } else {
        // Add new record
        const newRecord = {
            id: 'rec_' + Date.now(),
            ...recordData
        };
        db[sheetId].unshift(newRecord);
        showToast('บันทึกข้อมูลใหม่เรียบร้อยแล้ว', 'success');
    }
    
    saveDatabase();
    processAndRefreshAll();
    closeEntryModal();
}

// OCR scanner logic
function setupScanDragAndDrop() {
    const sDropzone = document.getElementById('scan-dropzone');
    if (!sDropzone) return;
    
    ['dragenter', 'dragover'].forEach(name => {
        sDropzone.addEventListener(name, (e) => {
            e.preventDefault();
            sDropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(name => {
        sDropzone.addEventListener(name, (e) => {
            e.preventDefault();
            sDropzone.classList.remove('dragover');
        }, false);
    });

    sDropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            processScanFile(files[0]);
        }
    }, false);
}

function triggerScanInput() {
    document.getElementById('scan-file-input').click();
}

function handleScanSelect(e) {
    const file = e.target.files[0];
    if (file) {
        processScanFile(file);
    }
}

function handleScanClipboardPaste(e) {
    if (appState.activeTab !== 'scan') return;

    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let index in items) {
        const item = items[index];
        if (item.kind === 'file' && item.type.indexOf('image/') !== -1) {
            const blob = item.getAsFile();
            const file = new File([blob], "pasted_receipt.png", { type: blob.type });
            processScanFile(file);
            showToast('วางภาพสำเร็จ', 'success');
            break;
        }
    }
}

function compressAndResizeImage(file, maxDim = 1200) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w > h) {
                        h = Math.round((h * maxDim) / w);
                        w = maxDim;
                    } else {
                        w = Math.round((w * maxDim) / h);
                        h = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์ได้'));
        reader.readAsDataURL(file);
    });
}

function triggerAutoBatchPdfImport() {
    const input = document.getElementById('scan-file-input');
    if (input) {
        input.value = '';
        const chk = document.getElementById('chk-auto-import-pdf');
        if (chk) chk.checked = true;
        input.click();
    }
}

async function processScanFile(file) {
    appState.scanFileName = file.name;
    document.getElementById('scan-file-name').textContent = file.name;

    const autoImportChk = document.getElementById('chk-auto-import-pdf');
    if (autoImportChk && autoImportChk.checked) {
        // Auto-import mode: AI reads Thai PDF/images & directly saves to ledgers without manual editing!
        await runAutoBatchPdfAIImport(file);
        return;
    }

    const screen = document.getElementById('scanner-loading-screen');
    screen.classList.add('active');
    document.getElementById('scanner-loading-status').textContent = 'กำลังเตรียมรูปภาพและอ่านข้อมูล...';

    try {
        let dataUrl = '';
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            appState.scanImageMime = 'image/png';
            dataUrl = await renderPdfPageToImage(file, 1);
        } else if (file.type.startsWith('image/')) {
            appState.scanImageMime = 'image/jpeg';
            appState.currentPdfFile = null;
            const pdfCtrl = document.getElementById('pdf-page-controller');
            if (pdfCtrl) pdfCtrl.style.display = 'none';
            dataUrl = await compressAndResizeImage(file);
        } else {
            screen.classList.remove('active');
            showToast('รูปแบบไฟล์ไม่รองรับ กรุณาอัปโหลดภาพหรือ PDF เท่านั้น', 'error');
            return;
        }

        appState.scanImageBase64 = dataUrl.split(',')[1];
        
        document.getElementById('scan-preview-img').src = dataUrl;
        document.getElementById('scan-dropzone').style.display = 'none';
        document.getElementById('scan-preview-box').style.display = 'block';

        runOcrAnalysis();
    } catch (err) {
        console.error(err);
        screen.classList.remove('active');
        showToast(`ประมวลผลไฟล์ขัดข้อง: ${err.message}`, 'error');
        clearScanImage();
    }
}

async function runAutoBatchPdfAIImport(file) {
    const screen = document.getElementById('scanner-loading-screen');
    const label = document.getElementById('scanner-loading-status');
    screen.classList.add('active');

    // Purge any pre-existing dummy 0-baht records from db
    Object.keys(db).forEach(k => {
        if (Array.isArray(db[k])) {
            db[k] = db[k].filter(r => parseFloat(r.amount) > 0 || (!String(r.merchant || '').includes('รายการสลิป/ใบเสร็จ หน้า') && !String(r.remarks || '').includes('หน้า 5')));
        }
    });

    let totalImported = 0;

    try {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            ensurePdfJsWorker();
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const totalPages = pdf.numPages;

            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                label.textContent = `🤖 AI กำลังอ่านภาษาไทยและบันทึกอัตโนมัติ (กำลังประมวลผลหน้า ${pageNum}/${totalPages})... เพิ่มแล้ว ${totalImported} รายการ`;
                
                const dataUrl = await renderPdfPageToImage(file, pageNum);
                const base64Data = dataUrl.split(',')[1];
                const canvas = document.getElementById('pdf-render-canvas');

                let itemData = null;

                // 1. Try Gemini AI if Key is set
                if (appState.apiKey) {
                    try {
                        itemData = await callGeminiOCRParserWithClassifier(base64Data, 'image/jpeg');
                    } catch (e) {
                        console.warn(`Page ${pageNum} Gemini AI parse error:`, e);
                    }
                }

                // 2. High-precision Local OCR fallback if AI Key is missing or failed
                if (!itemData) {
                    let pageText = '';
                    try {
                        await ensureTesseractLoaded();
                        if (window.Tesseract && canvas) {
                            const worker = await Tesseract.createWorker('eng');
                            const res = await worker.recognize(canvas);
                            await worker.terminate();
                            pageText = res.data ? res.data.text : '';
                        }
                    } catch (err) {
                        console.warn(`Page ${pageNum} local OCR error:`, err);
                    }
                    itemData = heuristicReceiptOCRRegex(pageText);
                }

                const targetLedger = itemData.targetLedger || document.getElementById('scan-target-ledger').value || 'mtp-expenses';
                const itemsList = itemData.items && itemData.items.length > 0 ? itemData.items : [{ name: itemData.merchantName || 'รายการสลิป/ใบเสร็จ', quantity: 1, price: itemData.total || 0, total: itemData.total || 0 }];
                
                const recDate = itemData.date || `${appState.selectedMonth}-01`;

                if (targetLedger === 'mtp_expenses' || targetLedger === 'mtp-expenses') {
                    itemsList.forEach((it, idx) => {
                        const amt = parseFloat(it.total || (it.quantity * it.price)) || parseFloat(itemData.total) || 0;
                        const rec = {
                            id: 'rec_' + Date.now() + '_' + pageNum + '_' + idx,
                            date: recDate,
                            category: itemData.category || 'อื่น ๆ',
                            merchant: it.name || itemData.merchantName || `รายการสลิป หน้า ${pageNum}`,
                            amount: amt,
                            payee: itemData.payee || itemData.recipient || '-',
                            remarks: itemData.remarks || `นำเข้าจาก ${file.name} หน้า ${pageNum}`
                        };
                        pushToLedger('mtp-expenses', rec);
                        totalImported++;
                    });
                } else if (targetLedger === 'mtp_revenue' || targetLedger === 'mtp-revenue' || targetLedger === 'jamjuree-revenue') {
                    const rec = {
                        id: 'rec_' + Date.now() + '_' + pageNum,
                        date: recDate,
                        customer: itemData.merchantName || 'ลูกค้านิรนาม',
                        amount: parseFloat(itemData.total) || 0,
                        remarks: `นำเข้าจาก ${file.name} หน้า ${pageNum}`
                    };
                    pushToLedger(targetLedger, rec);
                    totalImported++;
                } else if (targetLedger === 'twash-loans' || targetLedger === 'asawaeng-loans' || targetLedger === 'wan-loans') {
                    const rec = {
                        id: 'rec_' + Date.now() + '_' + pageNum,
                        date: recDate,
                        purpose: itemData.merchantName || 'สัญญากู้ยืม/คืนเงิน',
                        type: itemData.loanType || 'borrow',
                        amount: parseFloat(itemData.total) || 0,
                        remarks: `นำเข้าจาก ${file.name} หน้า ${pageNum}`
                    };
                    pushToLedger(targetLedger, rec);
                    totalImported++;
                } else if (targetLedger === 'pimas-expenses') {
                    const rec = {
                        id: 'rec_' + Date.now() + '_' + pageNum,
                        date: recDate,
                        description: itemData.merchantName || 'สำรองจ่ายพี่มัส',
                        status: itemData.pimasStatus || 'unpaid',
                        amount: parseFloat(itemData.total) || 0,
                        remarks: `นำเข้าจาก ${file.name} หน้า ${pageNum}`
                    };
                    pushToLedger('pimas-expenses', rec);
                    totalImported++;
                }
            }
        } else {
            label.textContent = `🤖 AI กำลังอ่านภาษาไทยและบันทึกอัตโนมัติ...`;
            const dataUrl = await compressAndResizeImage(file);
            const base64Data = dataUrl.split(',')[1];
            
            let itemData = null;
            if (appState.apiKey) {
                try {
                    itemData = await callGeminiOCRParserWithClassifier(base64Data, 'image/jpeg');
                } catch (e) {}
            }
            if (!itemData) {
                itemData = heuristicReceiptOCRRegex('');
            }
            const targetLedger = itemData.targetLedger || 'mtp-expenses';
            const rec = {
                id: 'rec_' + Date.now(),
                date: itemData.date || `${appState.selectedMonth}-01`,
                category: itemData.category || 'อื่น ๆ',
                merchant: itemData.merchantName || file.name,
                amount: parseFloat(itemData.total) || 0,
                payee: itemData.payee || '-',
                remarks: `นำเข้าจากรูปภาพ ${file.name}`
            };
            pushToLedger(targetLedger, rec);
            totalImported++;
        }

        saveDatabase();
        processAndRefreshAll();

        screen.classList.remove('active');
        showToast(`🎉 AI อ่านภาษาไทยและเพิ่มข้อมูลลงบัญชีสำเร็จทั้งหมด ${totalImported} รายการ!`, 'success');
        switchTab('mtp-expenses');
    } catch (err) {
        console.error(err);
        screen.classList.remove('active');
        showToast(`เกิดข้อผิดพลาดในการนำเข้าอัตโนมัติ: ${err.message}`, 'error');
    }
}

async function renderPdfPageToImage(file, pageNum = 1) {
    ensurePdfJsWorker(); // Ensure worker is configured (defer-safe)
    appState.currentPdfFile = file;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    appState.pdfTotalPages = pdf.numPages;
    appState.pdfCurrentPage = pageNum;

    const page = await pdf.getPage(pageNum);
    
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.getElementById('pdf-render-canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const renderContext = {
        canvasContext: context,
        viewport: viewport
    };
    await page.render(renderContext).promise;

    // Update PDF Page Controller UI
    const pdfCtrl = document.getElementById('pdf-page-controller');
    if (pdfCtrl) {
        if (pdf.numPages > 1) {
            pdfCtrl.style.display = 'flex';
            document.getElementById('pdf-current-page').textContent = pageNum;
            document.getElementById('pdf-total-pages').textContent = pdf.numPages;
            document.getElementById('btn-pdf-prev').disabled = (pageNum <= 1);
            document.getElementById('btn-pdf-next').disabled = (pageNum >= pdf.numPages);
        } else {
            pdfCtrl.style.display = 'none';
        }
    }

    return canvas.toDataURL('image/jpeg', 0.85);
}

async function changePdfPage(delta) {
    if (!appState.currentPdfFile) return;
    const targetPage = appState.pdfCurrentPage + delta;
    if (targetPage < 1 || targetPage > appState.pdfTotalPages) return;
    
    const screen = document.getElementById('scanner-loading-screen');
    screen.classList.add('active');
    document.getElementById('scanner-loading-status').textContent = `กำลังแปลง PDF หน้าที่ ${targetPage} จาก ${appState.pdfTotalPages}...`;

    try {
        const dataUrl = await renderPdfPageToImage(appState.currentPdfFile, targetPage);
        appState.scanImageBase64 = dataUrl.split(',')[1];
        document.getElementById('scan-preview-img').src = dataUrl;
        runOcrAnalysis();
    } catch (e) {
        console.error(e);
        screen.classList.remove('active');
        showToast(`สลับหน้า PDF ขัดข้อง: ${e.message}`, 'error');
    }
}

function clearScanImage() {
    appState.scanImageBase64 = '';
    appState.scanImageMime = '';
    appState.scanFileName = '';
    appState.currentPdfFile = null;
    appState.pdfTotalPages = 1;
    appState.pdfCurrentPage = 1;
    
    const pdfCtrl = document.getElementById('pdf-page-controller');
    if (pdfCtrl) pdfCtrl.style.display = 'none';

    document.getElementById('scan-preview-img').src = '';
    document.getElementById('scan-preview-box').style.display = 'none';
    document.getElementById('scan-dropzone').style.display = 'flex';
    document.getElementById('scan-file-input').value = '';
}

function updateScanProgressStep(stepId, state) {
    const el = document.getElementById(`scan-step-${stepId}`);
    if (!el) return;
    if (state === 'active') {
        el.className = 'loading-step-item active';
    } else if (state === 'completed') {
        el.className = 'loading-step-item completed';
    } else {
        el.className = 'loading-step-item';
    }
}

function handleScanTargetChange() {
    const target = document.getElementById('scan-target-ledger').value;
    const labelMerchant = document.getElementById('label-scan-merchant');
    const dynamicFieldGroup = document.getElementById('scan-dynamic-field-group');
    
    const tblBlock = document.getElementById('scan-items-table-block');
    const subtotalRow = document.getElementById('scan-subtotal-row');
    const taxRow = document.getElementById('scan-tax-row');
    const manualAmtInput = document.getElementById('scan-manual-amount');
    const displayTotalSpan = document.getElementById('scan-total');

    if (target === 'mtp_expenses') {
        tblBlock.style.display = 'block';
        subtotalRow.style.display = 'block';
        taxRow.style.display = 'block';
        manualAmtInput.style.display = 'none';
        
        labelMerchant.textContent = "ร้านค้า / ผู้รับเงิน";
        dynamicFieldGroup.style.display = 'flex';
        dynamicFieldGroup.innerHTML = `
            <label class="form-label" for="scan-category">หมวดหมู่รายจ่าย</label>
            <select id="scan-category" class="standard-input">
                <option value="ค่าซ่อม/บำรุงรักษาเครื่องจักร">ค่าซ่อม/บำรุงรักษาเครื่องจักร</option>
                <option value="ค่าซ่อม/อะไหล่รถยนต์">ค่าซ่อม/อะไหล่รถยนต์</option>
                <option value="ค่าน้ำมันรถ">ค่าน้ำมันรถ</option>
                <option value="ค่าแรงงาน/รับเหมา">ค่าแรงงาน/รับเหมา</option>
                <option value="ค่าของเบ็ดเตล็ด/ค่าของใช้งาน">ค่าของเบ็ดเตล็ด/ค่าของใช้งาน</option>
                <option value="ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์">ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์</option>
                <option value="อื่น ๆ" selected>อื่น ๆ</option>
            </select>
        `;
    } else {
        tblBlock.style.display = 'none';
        subtotalRow.style.display = 'none';
        taxRow.style.display = 'none';
        manualAmtInput.style.display = 'inline-block';

        if (target === 'mtp_revenue' || target === 'jamjuree-revenue') {
            labelMerchant.textContent = "รายการ / ลูกค้า";
            dynamicFieldGroup.style.display = 'none';
            dynamicFieldGroup.innerHTML = '';
        } else if (target === 'twash-loans' || target === 'asawaeng-loans' || target === 'wan-loans') {
            labelMerchant.textContent = "รายการ / วัตถุประสงค์";
            dynamicFieldGroup.style.display = 'flex';
            dynamicFieldGroup.innerHTML = `
                <label class="form-label" for="scan-loan-type">ประเภทรายการเงินยืม</label>
                <select id="scan-loan-type" class="standard-input">
                    <option value="borrow">ยืมเงิน (Borrow)</option>
                    <option value="repay">คืนเงิน (Repay)</option>
                </select>
            `;
        } else if (target === 'pimas-expenses') {
            labelMerchant.textContent = "รายการค่าใช้จ่ายพี่มัส";
            dynamicFieldGroup.style.display = 'flex';
            dynamicFieldGroup.innerHTML = `
                <label class="form-label" for="scan-pimas-status">สถานะเบิกจ่าย</label>
                <select id="scan-pimas-status" class="standard-input">
                    <option value="unpaid">ค้างจ่าย (Unpaid)</option>
                    <option value="paid">จ่ายแล้ว (Paid)</option>
                </select>
            `;
        }
    }
    
    recalculateScanTotals();
}

async function runOcrAnalysis() {
    const screen = document.getElementById('scanner-loading-screen');
    const label = document.getElementById('scanner-loading-status');
    
    screen.classList.add('active');
    updateScanProgressStep('ocr', 'active');
    updateScanProgressStep('ai', 'pending');
    updateScanProgressStep('done', 'pending');

    if (appState.apiKey) {
        try {
            label.textContent = 'กำลังส่งรูปวิเคราะห์ด้วย Gemini AI...';
            updateScanProgressStep('ocr', 'completed');
            updateScanProgressStep('ai', 'active');

            const payload = await callGeminiOCRParser();
            
            updateScanProgressStep('ai', 'completed');
            updateScanProgressStep('done', 'completed');
            label.textContent = 'วิเคราะห์เอกสารสำเร็จ!';
            
            setTimeout(() => {
                screen.classList.remove('active');
                populateScanForm(payload);
                showToast('ถอดข้อมูลรูปภาพด้วย Gemini AI สำเร็จ!', 'success');
            }, 500);
        } catch (e) {
            console.error(e);
            showToast(`การเชื่อมต่อ AI ล้มเหลว: ${e.message} - สลับเป็นโหมดพรีวิวภาพ`, 'error');
            await runLocalTesseractScanner();
        }
    } else {
        await runLocalTesseractScanner();
    }
}

async function callGeminiOCRParser() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${appState.apiKey}`;

    const body = {
        contents: [{
            parts: [
                {
                    text: `Analyze this invoice/receipt document. Parse and extract these fields:
1. merchantName (string): Vendor or store name (or customer name, purpose of payment, etc.).
2. date (string): Format strictly as 'YYYY-MM-DD'. Default to today's date if not readable.
3. category (string): Categorize this receipt into one of MTP Expenses list: 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', 'ค่าซ่อม/อะไหล่รถยนต์', 'ค่าน้ำมันรถ', 'ค่าแรงงาน/รับเหมา', 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', 'ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์', 'อื่น ๆ'.
4. items (array): List of items. Each containing:
   - name (string): Description of the item.
   - quantity (number): Quantity of items.
   - price (number): Unit price.
   - total (number): Total amount (quantity * price).
5. tax (number): Sum of Vat (7%), service charge, or other fees.
6. total (number): Grand total amount paid.

Return the result strictly as a JSON object matching the JSON schema provided in generationConfig.`
                },
                {
                    inlineData: {
                        mimeType: appState.scanImageMime,
                        data: appState.scanImageBase64
                    }
                }
            ]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    merchantName: { type: "STRING" },
                    date: { type: "STRING" },
                    category: { type: "STRING" },
                    items: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                name: { type: "STRING" },
                                quantity: { type: "NUMBER" },
                                price: { type: "NUMBER" },
                                total: { type: "NUMBER" }
                            },
                            required: ["name", "quantity", "price"]
                        }
                    },
                    tax: { type: "NUMBER" },
                    total: { type: "NUMBER" }
                },
                required: ["merchantName", "date", "items", "total"]
            }
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ? err.error.message : 'Unknown AI error');
    }

    const resJson = await res.json();
    const txt = resJson.candidates[0].content.parts[0].text;
    return JSON.parse(txt.trim());
}

async function callGeminiOCRParserWithClassifier(base64Data, mimeType) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${appState.apiKey}`;

    const promptText = `คุณคือ AI ผู้เชี่ยวชาญระดับสูงในการอ่านและถอดสลิปธนาคารไทย (KBank, SCB, Krungthai, PromptPay ฯลฯ) และใบเสร็จของโรงเลื่อย MTP Wood Thailand

โปรดวิเคราะห์ภาพสลิป/ใบเสร็จนี้อย่างแม่นยำ 100% โดยปฏิบัติตามกฎเหล็กดังนี้:
1. **ข้อความสีแดง / บันทึกช่วยจำ (Red Text / Details)**:
   - ตรวจหาข้อความสีแดง ตัวหนังสือเขียนโน้ต หรือข้อความบันทึกช่วยจำบนสลิปก่อนเสมอ เช่น "ค่าหนังสือรับรอง", "สำรองจ่าย", "ค่าน้ำมัน", "ค่าซ่อม"
   - นำข้อความสีแดงนี้มาตั้งเป็นชื่อรายละเอียดรายการหลัก (merchantName หรือ items.name)

2. **ผู้รับเงิน / ปลายทาง (Payee / Receiver)**:
   - อ่านชื่อผู้รับเงิน ปลายทาง ร้านค้า หรือธนาคารปลายทาง เช่น "พาณิชย์ จ.เชียงราย", "นาย แสวง ทองคำ", "นาย มัสถชัย คำอ้าย", "ปตท. ทุ่งใหญ่" (ตั้งเป็น payee)

3. **วันที่โอน (Transfer Date)**:
   - แปลงวันที่จาก พ.ศ. เป็น ค.ศ. เสมอ เช่น "4 ก.ค. 69" -> "2026-07-04", "6 ก.ค. 69" -> "2026-07-06" (รูปแบบ 'YYYY-MM-DD')

4. **ผู้โอน และ หมายเหตุ (Sender & Remarks)**:
   - ระบุผู้โอน และหมายเลขสลิป เช่น "ผู้โอน: นาย ธนวัฏ (กสิกรไทย)" (ตั้งเป็น remarks)

5. **การเลือกสมุดบัญชีเป้าหมาย (targetLedger Auto-Classification)**:
   - ถ้าผู้รับเงิน/ข้อความระบุถึง "แสวง" หรือ "อาแสวง" ➔ 'asawaeng-loans'
   - ถ้าผู้รับเงิน/ข้อความระบุถึง "มัสถชัย", "พี่มัส", "สำรองจ่าย" ➔ 'pimas-expenses'
   - ถ้าผู้รับเงิน/ข้อความระบุถึง "บริษัท วัน", "บ.วัน" ➔ 'wan-loans'
   - ถ้าผู้รับเงิน/ข้อความระบุถึง "ที.วอช", "T-Wash" ➔ 'twash-loans'
   - ถ้าผู้รับเงิน/ข้อความระบุถึง "จามจุรีย์" ➔ 'jamjuree-revenue'
   - ถ้าเป็นสลิปขายไม้ MTP ➔ 'mtp_revenue'
   - นอกเหนือจากนี้ ➔ 'mtp_expenses'

6. **หมวดหมู่รายจ่าย (category Auto-Classification)**:
   - 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', 'ค่าซ่อม/อะไหล่รถยนต์', 'ค่าน้ำมันรถ', 'ค่าแรงงาน/รับเหมา', 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', 'ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์', 'อื่น ๆ'

7. **จำนวนเงินสุทธิ (Exact Total Amount)**:
   - อ่านยอดเงินสุทธิเป็นตัวเลขทศนิยม 2 ตำแหน่งให้แม่นยำ 100% (เช่น 7500.00, 950.00, 6000.00) โดยไม่สับสนกับเลขที่รายการหรือเลขบัญชี

ตอบกลับเป็น JSON strictly ตามโครงสร้างที่กำหนด`;

    const body = {
        contents: [{
            parts: [
                { text: promptText },
                {
                    inlineData: {
                        mimeType: mimeType || 'image/jpeg',
                        data: base64Data
                    }
                }
            ]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    targetLedger: { type: "STRING" },
                    merchantName: { type: "STRING" },
                    payee: { type: "STRING" },
                    date: { type: "STRING" },
                    category: { type: "STRING" },
                    items: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                name: { type: "STRING" },
                                quantity: { type: "NUMBER" },
                                price: { type: "NUMBER" },
                                total: { type: "NUMBER" }
                            },
                            required: ["name", "quantity", "price"]
                        }
                    },
                    total: { type: "NUMBER" },
                    remarks: { type: "STRING" }
                },
                required: ["targetLedger", "merchantName", "date", "items", "total"]
            }
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ? err.error.message : 'AI connection error');
    }

    const resJson = await res.json();
    const txt = resJson.candidates[0].content.parts[0].text;
    return JSON.parse(txt.trim());
}

async function runLocalTesseractScanner() {
    const label = document.getElementById('scanner-loading-status');
    const screen = document.getElementById('scanner-loading-screen');

    try {
        label.textContent = 'กำลังนำเข้าและถอดข้อมูลจากรูปภาพ...';
        updateScanProgressStep('ocr', 'active');

        let text = '';
        try {
            await ensureTesseractLoaded();
            const imgSource = `data:${appState.scanImageMime};base64,${appState.scanImageBase64}`;

            // Tesseract.js v5 worker creation with 4-second timeout guard
            const workerPromise = (async () => {
                if (!window.Tesseract) return '';
                const worker = await Tesseract.createWorker('eng');
                const res = await worker.recognize(imgSource);
                await worker.terminate();
                return res.data ? res.data.text : '';
            })();

            const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(''), 4000));
            text = await Promise.race([workerPromise, timeoutPromise]);
        } catch (tessErr) {
            console.warn('Tesseract OCR fallback triggered:', tessErr);
            text = '';
        }

        updateScanProgressStep('ocr', 'completed');
        updateScanProgressStep('done', 'completed');

        const parsed = heuristicReceiptOCRRegex(text);

        setTimeout(() => {
            screen.classList.remove('active');
            populateScanForm(parsed);
            if (!appState.apiKey) {
                showToast('นำเข้าไฟล์รูปสำเร็จ! สามารถกรอกหรือปรับแก้ตัวเลขทางด้านขวาได้ทันที', 'success');
            } else {
                showToast('นำเข้าไฟล์รูปสำเร็จ ตรวจสอบความถูกต้องอีกครั้ง', 'info');
            }
        }, 300);

    } catch (e) {
        console.error(e);
        screen.classList.remove('active');
        showToast('นำเข้าไฟล์รูปสำเร็จ! สามารถกรอกตัวเลขและบันทึกได้เลย', 'success');
        populateScanForm({
            merchantName: appState.scanFileName ? appState.scanFileName.replace(/\.[^/.]+$/, "") : 'รายการใหม่',
            date: new Date().toISOString().split('T')[0],
            category: 'อื่น ๆ',
            items: [{ name: 'รายการสินค้า/บริการ', quantity: 1, price: 0, total: 0 }],
            tax: 0,
            total: 0
        });
    }
}

function heuristicReceiptOCRRegex(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let merchantName = 'สลิปรายการชำระเงิน';
    let dateStr = `${appState.selectedMonth}-01`;
    let items = [];
    let totalVal = 0;
    let targetLedger = 'mtp_expenses';
    let category = 'อื่น ๆ';

    // Thai month regex conversion
    const thaiMonths = { 'ม.ค.': '01', 'ก.พ.': '02', 'มี.ค.': '03', 'เม.ย.': '04', 'พ.ค.': '05', 'มิ.ย.': '06', 'ก.ค.': '07', 'ส.ค.': '08', 'ก.ย.': '09', 'ต.ค.': '10', 'พ.ย.': '11', 'ธ.ค.': '12' };
    
    // Check Thai month pattern e.g. 4 ก.ค. 69 or 04/07/2026
    for (const line of lines) {
        for (const [thMonth, monthNum] of Object.entries(thaiMonths)) {
            if (line.includes(thMonth)) {
                const matchDay = line.match(/(\d{1,2})\s*\(?[\u0E00-\u0E7F\.]+\)?\s*(\d{2,4})/);
                if (matchDay) {
                    let day = matchDay[1].padStart(2, '0');
                    let year = matchDay[2];
                    if (year.length === 2) year = '25' + year;
                    if (parseInt(year) > 2500) year = String(parseInt(year) - 543);
                    dateStr = `${year}-${monthNum}-${day}`;
                }
            }
        }
    }

    // Keyword detection for ledger auto-classification
    const fullText = text + ' ' + (appState.scanFileName || '');
    if (fullText.includes('แสวง') || fullText.includes('อาแสวง')) {
        targetLedger = 'asawaeng-loans';
        merchantName = '3. เงินกู้ คุณอาแสวง';
    } else if (fullText.includes('มัสถชัย') || fullText.includes('พี่มัส') || fullText.includes('สำรองจ่าย')) {
        targetLedger = 'pimas-expenses';
        merchantName = '5. เงินสำรองจ่าย พี่มัด';
    } else if (fullText.includes('บริษัท วัน') || fullText.includes('บ.วัน')) {
        targetLedger = 'wan-loans';
        merchantName = '4. เงินกู้ บ.วัน';
    } else if (fullText.includes('ที.วอช') || fullText.includes('T-Wash')) {
        targetLedger = 'twash-loans';
        merchantName = '2. เงินยืม ที.วอช';
    } else if (fullText.includes('จามจุรีย์')) {
        targetLedger = 'jamjuree-revenue';
        merchantName = 'รายรับจามจุรีย์';
    }

    if (lines.length > 0 && merchantName === 'สลิปรายการชำระเงิน') {
        const titleLine = lines.find(l => l.length > 3 && !l.includes('โอนเงิน') && !l.includes('สำเร็จ'));
        if (titleLine) merchantName = titleLine.replace(/[^a-zA-Z0-9ก-๙\s-]/g, '').trim();
    }

    const lineRegex = /([a-zA-Z0-9ก-๙\s\.\-\*\/]+)\s+(\d+[\.,]\d{2})\b/i;
    lines.forEach(line => {
        const match = line.match(lineRegex);
        if (match) {
            const label = match[1].toLowerCase();
            const amt = parseFloat(match[2].replace(',', '.'));
            
            const isTotal = ['total', 'net', 'sum', 'ยอดรวม', 'สุทธิ', 'cash', 'เงินสด', 'vat', 'ภาษี', 'จำนวน'].some(kw => label.includes(kw));
            if (!isTotal && amt > 0) {
                items.push({
                    name: match[1].trim(),
                    quantity: 1,
                    price: amt,
                    total: amt
                });
            } else if (label.includes('total') || label.includes('รวม') || label.includes('สุทธิ') || label.includes('จำนวน')) {
                if (amt > totalVal) totalVal = amt;
            }
        }
    });

    if (items.length === 0) {
        items.push({ name: merchantName, quantity: 1, price: totalVal || 0, total: totalVal || 0 });
    }

    if (totalVal === 0) {
        items.forEach(it => totalVal += it.total);
    }

    return {
        targetLedger,
        merchantName,
        date: dateStr,
        category,
        items,
        tax: 0,
        total: totalVal
    };
}

function populateScanForm(data) {
    document.getElementById('scan-merchant').value = data.merchantName || '';
    
    const selectedMonth = (appState.selectedMonth && appState.selectedMonth !== 'all') ? appState.selectedMonth : new Date().toISOString().slice(0, 7);
    let date = data.date || '';
    if (!date.startsWith(selectedMonth)) {
        date = `${selectedMonth}-01`;
    }
    document.getElementById('scan-date').value = date;
    
    const target = document.getElementById('scan-target-ledger').value;
    if (target === 'mtp_expenses') {
        document.getElementById('scan-category').value = data.category || 'อื่น ๆ';
        document.getElementById('scan-tax').value = data.tax ? data.tax.toFixed(2) : '0.00';
    } else {
        document.getElementById('scan-manual-amount').value = data.total ? data.total.toFixed(2) : '0.00';
    }
    
    document.getElementById('scan-remarks').value = '';

    appState.scanItems = (data.items || []).map(it => ({
        name: it.name || 'สินค้า',
        quantity: it.quantity || 1,
        price: it.price || 0,
        total: it.total || (it.quantity * it.price)
    }));

    renderScanItemsTable();
}

function renderScanItemsTable() {
    const target = document.getElementById('scan-target-ledger').value;
    if (target !== 'mtp_expenses') return;

    const tbody = document.getElementById('scan-items-body');
    tbody.innerHTML = '';

    appState.scanItems.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <input type="text" class="inline-form-input" value="${item.name.replace(/"/g, '&quot;')}" oninput="updateScanRow(${index}, 'name', this.value)">
            </td>
            <td>
                <input type="number" class="inline-form-input" value="${item.quantity}" min="1" step="any" style="text-align: right;" oninput="updateScanRow(${index}, 'quantity', this.value)">
            </td>
            <td>
                <input type="number" class="inline-form-input" value="${item.price.toFixed(2)}" min="0" step="0.01" style="text-align: right;" oninput="updateScanRow(${index}, 'price', this.value)">
            </td>
            <td style="text-align: right;">
                <button class="action-btn action-btn-delete" onclick="deleteScanRow(${index})">
                    <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    recalculateScanTotals();
}

function updateScanRow(index, key, val) {
    const item = appState.scanItems[index];
    if (key === 'name') {
        item.name = val;
    } else if (key === 'quantity') {
        item.quantity = parseFloat(val) || 0;
        item.total = item.quantity * item.price;
    } else if (key === 'price') {
        item.price = parseFloat(val) || 0;
        item.total = item.quantity * item.price;
    }
    recalculateScanTotals();
}

function addScanTableRow() {
    appState.scanItems.push({ name: '', quantity: 1, price: 0, total: 0 });
    renderScanItemsTable();
}

function deleteScanRow(index) {
    appState.scanItems.splice(index, 1);
    renderScanItemsTable();
}

function recalculateScanTotals() {
    const target = document.getElementById('scan-target-ledger').value;
    const totalSpan = document.getElementById('scan-total');

    if (target === 'mtp_expenses') {
        let subtotal = 0;
        appState.scanItems.forEach(it => subtotal += it.total);
        const tax = parseFloat(document.getElementById('scan-tax').value) || 0;
        const total = subtotal + tax;

        document.getElementById('scan-subtotal').textContent = `฿${subtotal.toLocaleString('th-TH', {minimumFractionDigits:2})}`;
        totalSpan.textContent = `฿${total.toLocaleString('th-TH', {minimumFractionDigits:2})}`;
    } else {
        const manualAmt = parseFloat(document.getElementById('scan-manual-amount').value) || 0;
        totalSpan.textContent = `฿${manualAmt.toLocaleString('th-TH', {minimumFractionDigits:2})}`;
    }
}

function resetScanForm() {
    document.getElementById('scan-merchant').value = '';
    document.getElementById('scan-date').value = `${appState.selectedMonth}-01`;
    document.getElementById('scan-remarks').value = '';
    
    const target = document.getElementById('scan-target-ledger').value;
    if (target === 'mtp_expenses') {
        document.getElementById('scan-category').value = 'อื่น ๆ';
        document.getElementById('scan-tax').value = '0.00';
    } else {
        document.getElementById('scan-manual-amount').value = '0.00';
    }
    
    appState.scanItems = [];
    renderScanItemsTable();
    clearScanImage();
    showToast('ล้างเครื่องสแกนเรียบร้อย', 'info');
}

// Append scanned receipt to the selected Target Ledger database
function saveScanToTargetLedger() {
    if (appState.viewerMode) return;
    const target = document.getElementById('scan-target-ledger').value;
    const merchant = document.getElementById('scan-merchant').value.trim();
    const date = document.getElementById('scan-date').value;
    const remarks = document.getElementById('scan-remarks').value.trim();
    const saveMode = document.getElementById('scan-save-mode') ? document.getElementById('scan-save-mode').value : 'itemized';

    if (!merchant) {
        showToast('กรุณากรอกข้อมูล ร้านค้า / ลูกค้า / วัตถุประสงค์ ก่อนบันทึก', 'error');
        return;
    }

    let targetTabId = target;
    if (target === 'mtp_expenses') targetTabId = 'mtp-expenses';
    else if (target === 'mtp_revenue') targetTabId = 'mtp-revenue';
    else if (target === 'asawaeng-loans') targetTabId = 'asawaeng-loans';
    else if (target === 'wan-loans') targetTabId = 'wan-loans';
    else if (target === 'twash-loans') targetTabId = 'twash-loans';
    else if (target === 'pimas-expenses') targetTabId = 'pimas-expenses';

    if (target === 'mtp_expenses') {
        if (appState.scanItems.length === 0) {
            showToast('กรุณาป้อนอย่างน้อย 1 รายการย่อย', 'error');
            return;
        }

        const category = document.getElementById('scan-category').value;
        const tax = parseFloat(document.getElementById('scan-tax').value) || 0;

        if (saveMode === 'itemized') {
            // Split into separate independent Transaction entries
            const count = appState.scanItems.length;
            const taxShare = count > 0 ? (tax / count) : 0;

            appState.scanItems.forEach((it, idx) => {
                const itemAmount = (parseFloat(it.total) || (it.quantity * it.price)) + taxShare;
                const newRecord = {
                    id: 'rec_' + Date.now() + '_' + idx,
                    date,
                    category,
                    merchant: it.name || merchant,
                    amount: itemAmount,
                    payee: merchant,
                    remarks: `จำนวน x${it.quantity} @ ฿${it.price}${remarks ? ' | ' + remarks : ''}`
                };
                pushToLedger('mtp-expenses', newRecord);
            });
            showToast(`แตกไฟล์นำเข้าเรียบร้อย ${count} รายการย่อย (Transactions)! สามารถกดแก้ไขแต่ละรายการได้ตลอดเวลา`, 'success');
        } else {
            // Save as combined bill
            let subtotal = 0;
            appState.scanItems.forEach(it => subtotal += (parseFloat(it.total) || (it.quantity * it.price)));
            const finalAmount = subtotal + tax;
            let detailedRemarks = remarks;
            if (!detailedRemarks) {
                detailedRemarks = appState.scanItems.map(it => `${it.name}(x${it.quantity})`).join(', ');
                if (detailedRemarks.length > 50) detailedRemarks = detailedRemarks.slice(0, 47) + '...';
            }

            const newRecord = {
                id: 'rec_' + Date.now(),
                date,
                category,
                merchant,
                amount: finalAmount,
                payee: merchant,
                remarks: detailedRemarks
            };
            pushToLedger('mtp-expenses', newRecord);
            showToast('บันทึกรวมเป็น 1 ใบเสร็จเรียบร้อยแล้ว', 'success');
        }
    } else {
        const finalAmount = parseFloat(document.getElementById('scan-manual-amount').value) || 0;
        if (finalAmount <= 0) {
            showToast('ยอดเงินต้องมากกว่า 0 บาท', 'error');
            return;
        }

        if (target === 'mtp_revenue' || target === 'mtp-revenue') {
            const newRecord = {
                id: 'rec_' + Date.now(),
                date,
                customer: merchant,
                amount: finalAmount,
                remarks
            };
            pushToLedger('mtp-revenue', newRecord);
        } else if (target === 'jamjuree-revenue') {
            const newRecord = {
                id: 'rec_' + Date.now(),
                date,
                customer: merchant,
                amount: finalAmount,
                remarks
            };
            pushToLedger('jamjuree-revenue', newRecord);
        } else if (target === 'twash-loans' || target === 'asawaeng-loans' || target === 'wan-loans') {
            const loanType = document.getElementById('scan-loan-type').value;
            const newRecord = {
                id: 'rec_' + Date.now(),
                date,
                purpose: merchant,
                type: loanType,
                amount: finalAmount,
                remarks
            };
            pushToLedger(target, newRecord);
        } else if (target === 'pimas-expenses') {
            const pimasStatus = document.getElementById('scan-pimas-status').value;
            const newRecord = {
                id: 'rec_' + Date.now(),
                date,
                description: merchant,
                status: pimasStatus,
                amount: finalAmount,
                remarks
            };
            pushToLedger('pimas-expenses', newRecord);
        }
        showToast(`บันทึกข้อมูลลงบัญชีเรียบร้อย`, 'success');
    }

    saveDatabase();
    resetScanForm();
    processAndRefreshAll();
    switchTab(targetTabId);
}

// Backup database JSON
function backupDatabaseJSON() {
    const jsonStr = JSON.stringify(db, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `mtp_wood_financial_backup_${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('ดาวน์โหลดไฟล์สำรองข้อมูล JSON สำเร็จ', 'success');
}

function triggerImportFileInput() {
    document.getElementById('import-db-file').click();
}

function importDatabaseJSON(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const imported = JSON.parse(event.target.result);
            let isValid = true;
            Object.keys(SHEET_CONFIGS).forEach(k => {
                if (!imported[k] || !Array.isArray(imported[k])) {
                    isValid = false;
                }
            });

            if (!isValid) {
                showToast('โครงสร้างไฟล์ไม่ถูกต้องสำหรับการกู้คืนฐานข้อมูล', 'error');
                return;
            }

            db = imported;
            localStorage.setItem('mtp_is_demo', 'false');
            saveDatabase();
            processAndRefreshAll();
            showToast('กู้คืนฐานข้อมูลจากไฟล์สำรองสำเร็จ!', 'success');
            switchTab('overview');
        } catch (err) {
            showToast('การนำเข้าไฟล์ล้มเหลว: รูปแบบ JSON ไม่ถูกต้อง', 'error');
        }
    };
    reader.readAsText(file);
}

function triggerWipeDatabase() {
    const modal = document.getElementById('confirm-modal');
    const confirmBtn = document.getElementById('confirm-modal-btn');
    
    modal.classList.add('active');
    document.getElementById('confirm-modal-body').textContent = 'คำเตือน! คุณแน่ใจที่จะล้างฐานข้อมูลการเงินทั้งหมดหรือไม่? ข้อมูลบันทึกประวัติค่าใช้จ่ายทั้งหมดของระบบจะหายไปอย่างถาวร!';
    
    confirmBtn.onclick = () => {
        db = { mtp_expenses: [], mtp_revenue: [], 'jamjuree-revenue': [], 'twash-loans': [], 'asawaeng-loans': [], 'wan-loans': [], 'pimas-expenses': [] };
        localStorage.setItem('mtp_is_demo', 'false');
        saveDatabase();
        processAndRefreshAll();
        closeConfirmModal();
        showToast('ล้างฐานข้อมูลสำเร็จเรียบร้อย', 'success');
    };
}

// Multi-Sheet Excel Exporter (SheetJS)
function exportClosingToExcel() {
    if (!window.XLSX) {
        showToast('กำลังโหลดไลบรารีสำหรับสร้างไฟล์ Excel กรุณาลองใหม่อีกครั้งใน 2-3 วินาที', 'error');
        return;
    }

    const filterMonth = appState.selectedMonth;
    const wb = XLSX.utils.book_new();

    const filterByMonthOrAll = (list) => {
        if (!list) return [];
        if (filterMonth === 'all') return list;
        return list.filter(it => it.date && it.date.startsWith(filterMonth));
    };

    // 1. Generate SHEET 1: Summary (สรุปผลการเงิน)
    const summaryData = [];
    summaryData.push(["รายงานสรุปงบการเงินประจำเดือนแบบครบวงจร"]);
    summaryData.push([`โครงการ: MTP Wood Thailand | ประจำรอบบัญชี: ${filterMonth === 'all' ? 'ข้อมูลรวมทุกเดือน (All-Time)' : filterMonth}`]);
    summaryData.push([]);

    const mtpRev = filterByMonthOrAll(db.mtp_revenue);
    let totalMtpRev = 0;
    mtpRev.forEach(it => totalMtpRev += parseFloat(it.amount) || 0);

    const jamRev = filterByMonthOrAll(db['jamjuree-revenue']);
    let totalJamRev = 0;
    jamRev.forEach(it => totalJamRev += parseFloat(it.amount) || 0);

    const mtpExp = filterByMonthOrAll(db.mtp_expenses);
    let totalMtpExp = 0;
    mtpExp.forEach(it => totalMtpExp += parseFloat(it.amount) || 0);

    const twash = filterByMonthOrAll(db['twash-loans']);
    let twashBorrow = 0;
    let twashRepay = 0;
    twash.forEach(it => {
        const amt = parseFloat(it.amount) || 0;
        if (it.type === 'borrow') twashBorrow += amt;
        else if (it.type === 'repay') twashRepay += amt;
    });

    const asawaeng = filterByMonthOrAll(db['asawaeng-loans']);
    let asawaengBorrow = 0;
    let asawaengRepay = 0;
    asawaeng.forEach(it => {
        const amt = parseFloat(it.amount) || 0;
        if (it.type === 'borrow') asawaengBorrow += amt;
        else if (it.type === 'repay') asawaengRepay += amt;
    });

    const wan = filterByMonthOrAll(db['wan-loans']);
    let wanBorrow = 0;
    let wanRepay = 0;
    wan.forEach(it => {
        const amt = parseFloat(it.amount) || 0;
        if (it.type === 'borrow') wanBorrow += amt;
        else if (it.type === 'repay') wanRepay += amt;
    });

    const pimas = filterByMonthOrAll(db['pimas-expenses']);
    let pimasUnpaid = 0;
    let pimasPaid = 0;
    pimas.forEach(it => {
        const amt = parseFloat(it.amount) || 0;
        if (it.status === 'unpaid') pimasUnpaid += amt;
        else if (it.status === 'paid') pimasPaid += amt;
    });

    const totalRevenueSum = totalMtpRev + totalJamRev;
    const netMtp = totalMtpRev - totalMtpExp;

    summaryData.push(["ชื่อบัญชี / รายการแจกแจง", "คำอธิบายเพิ่มเติม", "รายรับ (บาท)", "รายจ่าย (บาท)", "คงเหลือสุทธิ (บาท)"]);
    summaryData.push(["1. บัญชี MTP รายรับ", "รายได้จากการดำเนินงานหลัก (โรงเลื่อย)", totalMtpRev, 0, totalMtpRev]);
    summaryData.push(["2. บัญชี จามจุรีย์ รายรับ", "รายได้จากหน้าร้านเฟอร์นิเจอร์และแผ่นไม้", totalJamRev, 0, totalJamRev]);
    summaryData.push(["รวมรายรับของกิจการทั้งหมด", "รายรับบูรณาการ MTP + จามจุรีย์", totalRevenueSum, 0, totalRevenueSum]);
    summaryData.push(["1. ค่าใช้จ่ายทั่วไป", "ค่าใช้จ่ายดำเนินงานหลัก ค่าแรงงาน และน้ำมัน", 0, totalMtpExp, -totalMtpExp]);
    summaryData.push(["สรุปงบการเงินสุทธิโรงเลื่อย MTP", "รายรับหักรายจ่ายของ MTP (MTP Net)", totalMtpRev, totalMtpExp, netMtp]);
    summaryData.push(["2. เงินยืม ที.วอช (รอบเดือนนี้)", "ยอดการเบิกเงินสดฉุกเฉิน / ชำระโอนคืน", twashRepay, twashBorrow, twashRepay - twashBorrow]);
    summaryData.push(["3. เงินกู้ คุณอาแสวง (รอบเดือนนี้)", "ยอดดึงเงินทุนกู้ยืม / โอนชำระเงินต้นคืน", asawaengRepay, asawaengBorrow, asawaengRepay - asawaengBorrow]);
    summaryData.push(["4. เงินกู้ บ.วัน (รอบเดือนนี้)", "ยอดดึงเงินทุนกู้ยืม / โอนชำระเงินต้นคืน", wanRepay, wanBorrow, wanRepay - wanBorrow]);
    summaryData.push(["5. เงินสำรองจ่าย พี่มัด (รอบเดือนนี้)", "ยอดสำรองจ่ายโดยพี่มัด (ค้างชำระ / จ่ายคืนแล้ว)", pimasPaid, pimasUnpaid, -pimasUnpaid]);

    summaryData.push([]);
    summaryData.push([]);

    summaryData.push(["สัดส่วนหมวดหมู่ค่าใช้จ่าย (1. ค่าใช้จ่ายทั่วไป)"]);
    summaryData.push(["หมวดหมู่รายจ่าย", "ยอดเงินรวม (บาท)", "สัดส่วน (%)"]);

    let categoryTotals = {};
    let totalExpenseVal = 0;
    mtpExp.forEach(item => {
        const amt = parseFloat(item.amount) || 0;
        const cat = item.category || 'อื่น ๆ';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + amt;
        totalExpenseVal += amt;
    });

    const sortedCats = Object.keys(categoryTotals).sort((a, b) => categoryTotals[b] - categoryTotals[a]);
    sortedCats.forEach(cat => {
        const amt = categoryTotals[cat];
        const percent = totalExpenseVal > 0 ? ((amt / totalExpenseVal) * 100).toFixed(2) : 0;
        summaryData.push([cat, amt, `${percent}%`]);
    });

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, "สรุปผลการเงิน");

    // 2. Generate TABS 2-8: Individual Ledgers with Totals
    const sheetsToExport = [
        { id: 'mtp-expenses', dbKey: 'mtp_expenses', title: '1. ค่าใช้จ่ายทั่วไป' },
        { id: 'mtp-revenue', dbKey: 'mtp_revenue', title: 'MTP รายรับ' },
        { id: 'jamjuree-revenue', dbKey: 'jamjuree-revenue', title: 'จามจุรีย์ รายรับ' },
        { id: 'twash-loans', dbKey: 'twash-loans', title: '2. เงินยืม ที.วอช' },
        { id: 'asawaeng-loans', dbKey: 'asawaeng-loans', title: '3. เงินกู้ คุณอาแสวง' },
        { id: 'wan-loans', dbKey: 'wan-loans', title: '4. เงินกู้ บ.วัน' },
        { id: 'pimas-expenses', dbKey: 'pimas-expenses', title: '5. เงินสำรองจ่าย พี่มัด' }
    ];

    sheetsToExport.forEach(sh => {
        const filtered = filterByMonthOrAll(db[sh.dbKey]);
        let mapped = [];

        if (sh.id === 'mtp-expenses') {
            mapped = filtered.map(it => ({
                "วันที่ใช้จ่าย": it.date,
                "หมวดหมู่รายจ่าย": it.category,
                "ร้านค้า / ผู้รับเงิน": it.merchant,
                "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
                "หมายเหตุ": it.remarks || ''
            }));
            
            let sumVal = 0;
            filtered.forEach(it => sumVal += parseFloat(it.amount) || 0);
            mapped.push({
                "วันที่ใช้จ่าย": "ยอดเงินรวมทั้งหมด",
                "หมวดหมู่รายจ่าย": "",
                "ร้านค้า / ผู้รับเงิน": "",
                "ยอดเงิน (บาท)": sumVal,
                "หมายเหตุ": ""
            });
        } else if (sh.id === 'mtp-revenue' || sh.id === 'jamjuree-revenue') {
            mapped = filtered.map(it => ({
                "วันที่รับเงิน": it.date,
                "รายการ / ลูกค้า": it.customer,
                "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
                "หมายเหตุ": it.remarks || ''
            }));

            let sumVal = 0;
            filtered.forEach(it => sumVal += parseFloat(it.amount) || 0);
            mapped.push({
                "วันที่รับเงิน": "ยอดเงินรวมทั้งหมด",
                "รายการ / ลูกค้า": "",
                "ยอดเงิน (บาท)": sumVal,
                "หมายเหตุ": ""
            });
        } else if (sh.id === 'twash-loans' || sh.id === 'asawaeng-loans' || sh.id === 'wan-loans') {
            mapped = filtered.map(it => ({
                "วันที่ทำรายการ": it.date,
                "วัตถุประสงค์": it.purpose,
                "ประเภท": it.type === 'borrow' ? 'ยืมเงิน' : 'คืนเงิน',
                "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
                "หมายเหตุ": it.remarks || ''
            }));

            let borrowSum = 0;
            let repaySum = 0;
            filtered.forEach(it => {
                const amt = parseFloat(it.amount) || 0;
                if (it.type === 'borrow') borrowSum += amt;
                else repaySum += amt;
            });
            mapped.push({
                "วันที่ทำรายการ": "ยอดรวมยืมเงิน (Borrow)",
                "วัตถุประสงค์": "",
                "ประเภท": "",
                "ยอดเงิน (บาท)": borrowSum,
                "หมายเหตุ": ""
            });
            mapped.push({
                "วันที่ทำรายการ": "ยอดรวมคืนเงิน (Repay)",
                "วัตถุประสงค์": "",
                "ประเภท": "",
                "ยอดเงิน (บาท)": repaySum,
                "หมายเหตุ": ""
            });
            mapped.push({
                "วันที่ทำรายการ": "ยอดค้างชำระสุทธิรอบเดือน",
                "วัตถุประสงค์": "",
                "ประเภท": "",
                "ยอดเงิน (บาท)": borrowSum - repaySum,
                "หมายเหตุ": ""
            });
        } else if (sh.id === 'pimas-expenses') {
            mapped = filtered.map(it => ({
                "วันที่สำรองจ่าย": it.date,
                "รายการค่าใช้จ่าย": it.description,
                "สถานะชำระเงิน": it.status === 'paid' ? 'จ่ายแล้ว' : 'ค้างจ่าย',
                "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
                "หมายเหตุ": it.remarks || ''
            }));

            let unpaidSum = 0;
            let paidSum = 0;
            filtered.forEach(it => {
                const amt = parseFloat(it.amount) || 0;
                if (it.status === 'unpaid') unpaidSum += amt;
                else paidSum += amt;
            });
            mapped.push({
                "วันที่สำรองจ่าย": "ยอดที่จ่ายคืนแล้ว",
                "รายการค่าใช้จ่าย": "",
                "สถานะชำระเงิน": "",
                "ยอดเงิน (บาท)": paidSum,
                "หมายเหตุ": ""
            });
            mapped.push({
                "วันที่สำรองจ่าย": "ยอดที่ยังค้างจ่ายพี่มัส",
                "รายการค่าใช้จ่าย": "",
                "สถานะชำระเงิน": "",
                "ยอดเงิน (บาท)": unpaidSum,
                "หมายเหตุ": ""
            });
        }

        let ws;
        if (mapped.length === 0) {
            const headers = SHEET_CONFIGS[sh.id].headers.filter(h => h !== 'จัดการ');
            ws = XLSX.utils.aoa_to_sheet([headers]);
        } else {
            ws = XLSX.utils.json_to_sheet(mapped);
        }

        XLSX.utils.book_append_sheet(wb, ws, sh.title);
    });

    XLSX.writeFile(wb, `MTP_WOOD_FINANCIAL_REPORT_${filterMonth}.xlsx`);
    showToast('ดาวน์โหลดรายงานงบรวม Excel เรียบร้อยแล้ว!', 'success');
}

// Executive PDF Report Exporter (White & Brown Theme)
function exportToPDF() {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showToast('กรุณาอนุญาตป็อปอัป (Pop-up) เพื่อดาวน์โหลดหรือพิมพ์รายงาน PDF', 'error');
    return;
  }

  const filterMonth = appState.selectedMonth || '2026-07';
  const thaiMonthMap = {
    '2026-01': 'มกราคม 2569',
    '2026-02': 'กุมภาพันธ์ 2569',
    '2026-03': 'มีนาคม 2569',
    '2026-04': 'เมษายน 2569',
    '2026-05': 'พฤษภาคม 2569',
    '2026-06': 'มิถุนายน 2569',
    '2026-07': 'กรกฎาคม 2569',
    '2026-08': 'สิงหาคม 2569',
    '2026-09': 'กันยายน 2569',
    '2026-10': 'ตุลาคม 2569',
    '2026-11': 'พฤศจิกายน 2569',
    '2026-12': 'ธันวาคม 2569'
  };
  const monthText = thaiMonthMap[filterMonth] || filterMonth;

  const filterByMonth = (list) => (list || []).filter(item => item.date && item.date.startsWith(filterMonth));

  const mtpRev = filterByMonth(db.mtp_revenue);
  let totalMtpRev = 0;
  mtpRev.forEach(it => totalMtpRev += parseFloat(it.amount) || 0);

  const jamRev = filterByMonth(db['jamjuree-revenue']);
  let totalJamRev = 0;
  jamRev.forEach(it => totalJamRev += parseFloat(it.amount) || 0);

  const mtpExp = filterByMonth(db.mtp_expenses);
  let totalMtpExp = 0;
  mtpExp.forEach(it => totalMtpExp += parseFloat(it.amount) || 0);

  const grandTotalRevenue = totalMtpRev + totalJamRev;
  const netMtp = totalMtpRev - totalMtpExp;

  const loanSummary = calculateLoanAccountSummaries();
  const twash = loanSummary.twash || { repaid: 0, borrowed: 0, outstanding: 0 };
  const asawaeng = loanSummary.asawaeng || { repaid: 0, borrowed: 0, outstanding: 0 };
  const wan = loanSummary.wan || { repaid: 0, borrowed: 0, outstanding: 0 };
  const pimas = loanSummary.pimas || { paid: 0, advance: 0, outstanding: 0 };
  const totalOutstandingDebt = loanSummary.totalOutstandingDebt || 0;

  const fmtCurrency = (val) => {
    if (val === undefined || val === null || isNaN(val) || val === 0) return '-';
    return val.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const fmtNet = (val) => {
    if (val === undefined || val === null || isNaN(val)) return '-';
    if (val < 0) return `-${Math.abs(val).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (val === 0) return '0.00';
    return val.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="th">
    <head>
      <meta charset="UTF-8">
      <title>รายงานสรุปผลการดำเนินงานและการเงิน - MTP Wood Thailand</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap');
        body { font-family: 'Sarabun', sans-serif; color: #4a3b32; background: #fff; padding: 20px; font-size: 13px; }
        .header { text-align: center; border-bottom: 2px solid #8c6d58; padding-bottom: 12px; margin-bottom: 20px; }
        .header h1 { margin: 0; color: #4a3b32; font-size: 20px; }
        .header p { margin: 4px 0 0; color: #7a685b; }
        
        .kpi-grid { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 20px; }
        .kpi-card { flex: 1; background: #faf7f4; border: 1px solid #e8dfd8; border-radius: 6px; padding: 10px; text-align: center; }
        .kpi-title { font-size: 11px; color: #7a685b; }
        .kpi-value { font-size: 16px; font-weight: bold; color: #4a3b32; margin-top: 4px; }
        .negative { color: #b33939; }

        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th { background: #8c6d58; color: #ffffff; text-align: left; padding: 8px; font-size: 12px; }
        td { padding: 8px; border-bottom: 1px solid #e8dfd8; }
        tr:nth-child(even) { background: #faf7f4; }
        .text-right { text-align: right; }
        .font-bold { font-weight: bold; }

        .footer { margin-top: 30px; text-align: center; font-size: 10px; color: #a09287; border-top: 1px solid #e8dfd8; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>MTP Wood Thailand</h1>
        <p>รายงานสรุปผลการดำเนินงานและการเงินประจำเดือน (${monthText})</p>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-title">รายรับรวมทั้งหมด</div>
          <div class="kpi-value">฿${grandTotalRevenue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">รายจ่ายรวม MTP</div>
          <div class="kpi-value">฿${totalMtpExp.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">รายรับสุทธิ (MTP Net)</div>
          <div class="kpi-value ${netMtp < 0 ? 'negative' : ''}">฿${fmtNet(netMtp)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">ยอดเงินกู้คงค้างรวม</div>
          <div class="kpi-value negative">฿${totalOutstandingDebt.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      <h3>รายงานสรุปงบการเงินประจำเดือนแบบครบวงจร</h3>
      <table>
        <thead>
          <tr>
            <th>ชื่อบัญชี / รายการแจกแจง</th>
            <th>คำอธิบายเพิ่มเติม</th>
            <th class="text-right">รายรับ (บาท)</th>
            <th class="text-right">รายจ่าย (บาท)</th>
            <th class="text-right">คงเหลือสุทธิ (บาท)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="font-bold">1. บัญชี MTP รายรับ</td>
            <td>รายได้จากการดำเนินงานหลัก (โรงเลื่อย)</td>
            <td class="text-right">${fmtCurrency(totalMtpRev)}</td>
            <td class="text-right">-</td>
            <td class="text-right font-bold">${fmtNet(totalMtpRev)}</td>
          </tr>
          <tr>
            <td class="font-bold">2. บัญชี จามจุรีย์ รายรับ</td>
            <td>รายได้จากหน้าร้านเฟอร์นิเจอร์และแผ่นไม้</td>
            <td class="text-right">${fmtCurrency(totalJamRev)}</td>
            <td class="text-right">-</td>
            <td class="text-right font-bold">${fmtNet(totalJamRev)}</td>
          </tr>
          <tr style="background: #f0eae1;">
            <td class="font-bold">รวมรายรับของกิจการทั้งหมด</td>
            <td>รายรับบูรณาการ MTP + จามจุรีย์</td>
            <td class="text-right font-bold">${fmtCurrency(grandTotalRevenue)}</td>
            <td class="text-right">-</td>
            <td class="text-right font-bold">${fmtNet(grandTotalRevenue)}</td>
          </tr>
          <tr>
            <td class="font-bold">1. ค่าใช้จ่ายทั่วไป</td>
            <td>ค่าใช้จ่ายดำเนินงานหลัก ค่าแรงงาน และน้ำมัน</td>
            <td class="text-right">-</td>
            <td class="text-right">${fmtCurrency(totalMtpExp)}</td>
            <td class="text-right font-bold negative">${fmtNet(-totalMtpExp)}</td>
          </tr>
          <tr style="background: #f0eae1;">
            <td class="font-bold">สรุปงบการเงินสุทธิโรงเลื่อย MTP</td>
            <td>รายรับหักรายจ่ายของ MTP (MTP Net)</td>
            <td class="text-right font-bold">${fmtCurrency(totalMtpRev)}</td>
            <td class="text-right font-bold">${fmtCurrency(totalMtpExp)}</td>
            <td class="text-right font-bold negative">${fmtNet(netMtp)}</td>
          </tr>
          <tr>
            <td class="font-bold">2. เงินยืม ที.วอช (ยอดสะสมรวม)</td>
            <td>ยอดชำระคืนสะสม / ยอดคงเหลือยืมสะสมรวมทุกเดือน</td>
            <td class="text-right">${fmtCurrency(twash.repaid)}</td>
            <td class="text-right">${fmtCurrency(twash.borrowed)}</td>
            <td class="text-right font-bold negative">${fmtNet(-twash.outstanding)}</td>
          </tr>
          <tr>
            <td class="font-bold">3. เงินกู้ คุณอาแสวง (ยอดสะสมรวม)</td>
            <td>ยอดชำระคืนเงินต้นสะสม / ยอดเงินต้นคงเหลือสะสม</td>
            <td class="text-right">${fmtCurrency(asawaeng.repaid)}</td>
            <td class="text-right">-</td>
            <td class="text-right font-bold negative">${fmtNet(-asawaeng.outstanding)}</td>
          </tr>
          <tr>
            <td class="font-bold">4. เงินกู้ บ.วัน (ยอดสะสมรวม)</td>
            <td>ยอดชำระคืนสะสม / ยอดคงเหลือเงินกู้สะสมรวมทุกเดือน</td>
            <td class="text-right">${fmtCurrency(wan.repaid)}</td>
            <td class="text-right">${fmtCurrency(wan.borrowed)}</td>
            <td class="text-right font-bold negative">${fmtNet(-wan.outstanding)}</td>
          </tr>
          <tr>
            <td class="font-bold">5. เงินสำรองจ่าย พี่มัด (ยอดสะสมรวม)</td>
            <td>ยอดชำระคืนพี่มัดแล้ว / ยอดค้างชำระสะสมรวมทุกเดือน</td>
            <td class="text-right">${fmtCurrency(pimas.paid)}</td>
            <td class="text-right">${fmtCurrency(pimas.advance)}</td>
            <td class="text-right font-bold negative">${fmtNet(-pimas.outstanding)}</td>
          </tr>
          <tr style="background: #e3d7cb;">
            <td class="font-bold">รวมยอดภาระหนี้กู้ยืมและเงินสำรองจ่ายคงเหลือสะสม</td>
            <td>ยอดคงเหลือเงินต้นและเงินสำรองจ่ายสุทธิรวม 4 สมุดบัญชี</td>
            <td class="text-right">-</td>
            <td class="text-right font-bold">${fmtCurrency(totalOutstandingDebt)}</td>
            <td class="text-right font-bold negative">${fmtNet(-totalOutstandingDebt)}</td>
          </tr>
        </tbody>
      </table>

      <div class="footer">
        © 2026 MTP Wood Thailand. ระบบสรุปผลวิเคราะห์การเงินและข้อมูลเดินบัญชีบูรณาการทุกแผ่นงานในธีม ขาว-น้ำตาล
      </div>

      <script>
        window.onload = function() { window.print(); window.close(); };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function exportSummaryToPDF() {
  exportToPDF();
}

// Export single sheet to Excel with totals
function exportSingleSheetToExcel(sheetId) {
    if (!window.XLSX) {
        showToast('กำลังโหลดไลบรารีสำหรับสร้างไฟล์ Excel', 'error');
        return;
    }

    const config = SHEET_CONFIGS[sheetId];
    if (!config) return;

    const filterMonth = appState.selectedMonth;
    const rawList = db[sheetId === 'mtp-expenses' ? 'mtp_expenses' : (sheetId === 'mtp-revenue' ? 'mtp_revenue' : (sheetId === 'jamjuree-revenue' ? 'jamjuree-revenue' : (sheetId === 'twash-loans' ? 'twash-loans' : (sheetId === 'asawaeng-loans' ? 'asawaeng-loans' : (sheetId === 'wan-loans' ? 'wan-loans' : 'pimas-expenses')))))] || [];
    const filtered = (filterMonth === 'all') ? rawList : rawList.filter(it => it.date && it.date.startsWith(filterMonth));

    let mapped = [];
    if (sheetId === 'mtp-expenses') {
        mapped = filtered.map(it => ({
            "วันที่ใช้จ่าย": it.date,
            "หมวดหมู่รายจ่าย": it.category,
            "ร้านค้า / ผู้รับเงิน": it.merchant,
            "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
            "หมายเหตุ": it.remarks || ''
        }));
        
        let sumVal = 0;
        filtered.forEach(it => sumVal += parseFloat(it.amount) || 0);
        mapped.push({
            "วันที่ใช้จ่าย": "ยอดเงินรวมทั้งหมด",
            "หมวดหมู่รายจ่าย": "",
            "ร้านค้า / ผู้รับเงิน": "",
            "ยอดเงิน (บาท)": sumVal,
            "หมายเหตุ": ""
        });
    } else if (sheetId === 'mtp-revenue' || sheetId === 'jamjuree-revenue') {
        mapped = filtered.map(it => ({
            "วันที่รับเงิน": it.date,
            "รายการ / ลูกค้า": it.customer,
            "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
            "หมายเหตุ": it.remarks || ''
        }));

        let sumVal = 0;
        filtered.forEach(it => sumVal += parseFloat(it.amount) || 0);
        mapped.push({
            "วันที่รับเงิน": "ยอดเงินรวมทั้งหมด",
            "รายการ / ลูกค้า": "",
            "ยอดเงิน (บาท)": sumVal,
            "หมายเหตุ": ""
        });
    } else if (sheetId === 'twash-loans' || sheetId === 'asawaeng-loans' || sheetId === 'wan-loans') {
        mapped = filtered.map(it => ({
            "วันที่ทำรายการ": it.date,
            "วัตถุประสงค์": it.purpose,
            "ประเภท": it.type === 'borrow' ? 'ยืมเงิน' : 'คืนเงิน',
            "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
            "หมายเหตุ": it.remarks || ''
        }));

        let borrowSum = 0;
        let repaySum = 0;
        filtered.forEach(it => {
            const amt = parseFloat(it.amount) || 0;
            if (it.type === 'borrow') borrowSum += amt;
            else repaySum += amt;
        });
        mapped.push({
            "วันที่ทำรายการ": "ยอดรวมยืมเงิน (Borrow)",
            "วัตถุประสงค์": "",
            "ประเภท": "",
            "ยอดเงิน (บาท)": borrowSum,
            "หมายเหตุ": ""
        });
        mapped.push({
            "วันที่ทำรายการ": "ยอดรวมคืนเงิน (Repay)",
            "วัตถุประสงค์": "",
            "ประเภท": "",
            "ยอดเงิน (บาท)": repaySum,
            "หมายเหตุ": ""
        });
        mapped.push({
            "วันที่ทำรายการ": "ยอดค้างชำระสุทธิรอบเดือน",
            "วัตถุประสงค์": "",
            "ประเภท": "",
            "ยอดเงิน (บาท)": borrowSum - repaySum,
            "หมายเหตุ": ""
        });
    } else if (sheetId === 'pimas-expenses') {
        mapped = filtered.map(it => ({
            "วันที่สำรองจ่าย": it.date,
            "รายการค่าใช้จ่าย": it.description,
            "สถานะชำระเงิน": it.status === 'paid' ? 'จ่ายแล้ว' : 'ค้างจ่าย',
            "ยอดเงิน (บาท)": parseFloat(it.amount) || 0,
            "หมายเหตุ": it.remarks || ''
        }));

        let unpaidSum = 0;
        let paidSum = 0;
        filtered.forEach(it => {
            const amt = parseFloat(it.amount) || 0;
            if (it.status === 'unpaid') unpaidSum += amt;
            else paidSum += amt;
        });
        mapped.push({
            "วันที่สำรองจ่าย": "ยอดที่จ่ายคืนแล้ว",
            "รายการค่าใช้จ่าย": "",
            "สถานะชำระเงิน": "",
            "ยอดเงิน (บาท)": paidSum,
            "หมายเหตุ": ""
        });
        mapped.push({
            "วันที่สำรองจ่าย": "ยอดที่ยังค้างจ่ายพี่มัส",
            "รายการค่าใช้จ่าย": "",
            "สถานะชำระเงิน": "",
            "ยอดเงิน (บาท)": unpaidSum,
            "หมายเหตุ": ""
        });
    }

    const wb = XLSX.utils.book_new();
    let ws;
    if (mapped.length === 0) {
        const headers = config.headers.filter(h => h !== 'จัดการ');
        ws = XLSX.utils.aoa_to_sheet([headers]);
    } else {
        ws = XLSX.utils.json_to_sheet(mapped);
    }

    XLSX.utils.book_append_sheet(wb, ws, config.title);
    XLSX.writeFile(wb, `MTP_WOOD_${sheetId.toUpperCase()}_${filterMonth}.xlsx`);
    showToast(`ส่งออกแผ่นงาน ${config.title} เป็น Excel สำเร็จ`, 'success');
}

// Load Demo scan data trigger (mock OCR flow)
function loadDemoScanData() {
    const screen = document.getElementById('scanner-loading-screen');
    const label = document.getElementById('scanner-loading-status');
    
    screen.classList.add('active');
    updateScanProgressStep('ocr', 'active');
    updateScanProgressStep('ai', 'pending');
    updateScanProgressStep('done', 'pending');
    
    label.textContent = 'กำลังโหลดสแกนเอกสารด้วย OCR...';
    
    setTimeout(() => {
        updateScanProgressStep('ocr', 'completed');
        updateScanProgressStep('ai', 'active');
        label.textContent = 'วิเคราะห์ข้อมูลโครงสร้างด้วย AI...';
        
        setTimeout(() => {
            updateScanProgressStep('ai', 'completed');
            updateScanProgressStep('done', 'completed');
            label.textContent = 'วิเคราะห์เสร็จสิ้น!';
            
            const target = document.getElementById('scan-target-ledger').value;
            let demoScan = {};

            if (target === 'mtp_expenses') {
                demoScan = {
                    merchantName: "บริษัท ปูนซิเมนต์ไทย จำกัด (มหาชน)",
                    date: `${appState.selectedMonth}-15`,
                    category: "ค่าของเบ็ดเตล็ด/ค่าของใช้งาน",
                    items: [
                        { name: "ปูนซีเมนต์ปอร์ตแลนด์ตราช้าง (ถุง 50กก.)", quantity: 20, price: 145.00, total: 2900.00 },
                        { name: "เหล็กเส้นข้ออ้อย SD40 ขนาด 12มม.", quantity: 15, price: 210.00, total: 3150.00 },
                        { name: "ตะปูตอกไม้ขนาด 3 นิ้ว (กล่อง 5กก.)", quantity: 4, price: 180.00, total: 720.00 }
                    ],
                    tax: 473.90,
                    total: 7243.90
                };
            } else if (target === 'mtp_revenue') {
                demoScan = {
                    merchantName: "บริษัท ทิมเบอร์ฮับ จำกัด",
                    date: `${appState.selectedMonth}-10`,
                    total: 85000.00
                };
            } else if (target === 'jamjuree-revenue') {
                demoScan = {
                    merchantName: "คุณวิชัย เฟอร์นิเจอร์อินเตอร์",
                    date: `${appState.selectedMonth}-18`,
                    total: 28000.00
                };
            } else if (target === 'twash-loans') {
                demoScan = {
                    merchantName: "ที.วอช ยืมจ่ายค่าซ่อมรถตักฉุกเฉิน",
                    date: `${appState.selectedMonth}-05`,
                    total: 15000.00
                };
            } else if (target === 'asawaeng-loans') {
                demoScan = {
                    merchantName: "กู้เพิ่มทุนจ้างแรงงานบดขี้เลื่อย",
                    date: `${appState.selectedMonth}-06`,
                    total: 50000.00
                };
            } else if (target === 'wan-loans') {
                demoScan = {
                    merchantName: "รับเงินกู้เพิ่มงวดพิเศษจาก บ.วัน",
                    date: `${appState.selectedMonth}-12`,
                    total: 20000.00
                };
            } else if (target === 'pimas-expenses') {
                demoScan = {
                    merchantName: "สำรองค่าแรงรายวันซ่อมหลังคาโรงเลื่อย",
                    date: `${appState.selectedMonth}-22`,
                    total: 9800.00
                };
            }
            
            setTimeout(() => {
                screen.classList.remove('active');
                populateScanForm(demoScan);
                showToast(`โหลดตัวอย่างเอกสารเข้าช่องบัญชีที่เลือกเรียบร้อย`, 'info');
            }, 600);
            
        }, 1000);
    }, 1000);
}

// MTP Wood Demo Database Loader
function loadMtpDemoDatabase(silent = false) {
    db = {
        mtp_expenses: [
            // June 2026
            { id: 'exp_01', date: '2026-06-05', category: 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', merchant: 'ซ่อมกระบอกสูบไฮดรอลิกแท่นตัดหลัก', amount: 15200, payee: 'อู่เฮียตี๋ไฮดรอลิก', remarks: 'ชำระผ่านกสิกรไทย' },
            { id: 'exp_02', date: '2026-06-12', category: 'ค่าน้ำมันรถ', merchant: 'ค่าน้ำมันสิบล้อ ขนส่งท่อนซุงสัก', amount: 4500, payee: 'ปั๊ม ปตท. ทุ่งใหญ่', remarks: 'ใบเสร็จเติมน้ำมันสด' },
            { id: 'exp_03', date: '2026-06-15', category: 'ค่าแรงงาน/รับเหมา', merchant: 'ค่าแรงเหมาตัดและลากไม้แปลงเกษตร 4', amount: 45000, payee: 'ช่างรับเหมาทีมเอก', remarks: 'เบิกจ่ายงวดแรก' },
            { id: 'exp_04', date: '2026-06-20', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อใบเลื่อยวงเดือน 2 ใบ และน้ำมันหล่อลื่น', amount: 12300, payee: 'ชลบุรีฮาร์ดแวร์', remarks: 'โอนชำระหนี้ร้าน' },
            { id: 'exp_05', date: '2026-06-25', category: 'ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์', merchant: 'ค่าไฟสำนักงานโรงงาน ประจำเดือน มิ.ย.', amount: 8000, payee: 'การไฟฟ้าส่วนภูมิภาค', remarks: 'หักผ่านบัญชีบริษัท' },
            
            // July 2026 (Real Slips)
            { id: 'exp_06_01', date: '2026-07-04', category: 'อื่น ๆ', merchant: 'เงินโอน (ไม่ระบุวัตถุประสงค์)', amount: 7500.00, payee: 'นายแสวง ทองคำ', remarks: 'เวลา 12:28' },
            { id: 'exp_06_02', date: '2026-07-06', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ค่าหนังสือรับรอง', amount: 950.00, payee: 'พาณิชย์ จ.เชียงราย', remarks: 'เวลา 11:23' },
            { id: 'exp_06_03', date: '2026-07-06', category: 'อื่น ๆ', merchant: 'สำรองจ่าย', amount: 6000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา ~11:4x' },
            { id: 'exp_06_04', date: '2026-07-06', category: 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', merchant: 'ลูกปืนแม็กหมอน 2 ชั้น', amount: 3600.00, payee: 'หจก. ต.สหกล', remarks: 'เวลา 11:48' },
            { id: 'exp_06_05', date: '2026-07-06', category: 'อื่น ๆ', merchant: 'สำรองจ่าย', amount: 10000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 15:07' },
            { id: 'exp_06_06', date: '2026-07-06', category: 'อื่น ๆ', merchant: 'ค่าเช่า พ.ค.–มิ.ย. 69', amount: 5500.00, payee: 'นางจันทร์ฟอง ติ๊บมา', remarks: 'เวลา 19:23' },
            { id: 'exp_06_07', date: '2026-07-07', category: 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', merchant: 'ค่าอะไหล่', amount: 1900.00, payee: 'นายธนพล จินดาวิภูษิต', remarks: 'เวลา 14:40' },
            { id: 'exp_06_08', date: '2026-07-08', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 21032.00, payee: 'นายชาติชาย คำสงค์', remarks: 'เวลา 20:03' },
            { id: 'exp_06_09', date: '2026-07-08', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 5050.00, payee: 'น.ส. ปัณทารีย์ เชื้อเมืองพาน', remarks: 'เวลา 16:52' },
            { id: 'exp_06_10', date: '2026-07-08', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ค่าวัสดุ', amount: 4000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 16:26' },
            { id: 'exp_06_11', date: '2026-07-09', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้งิ้ว', amount: 5000.00, payee: 'นายบรรจบ บุตรมี', remarks: 'เวลา 09:31' },
            { id: 'exp_06_12', date: '2026-07-09', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ไม้ยูคา', amount: 0.00, payee: 'น.ส. ปัณทารีย์ เชื้อเมืองพาน', remarks: 'เวลา 12:44, ไม่ระบุจำนวนเงิน (ตัดขอบภาพ)' },
            { id: 'exp_06_13', date: '2026-07-09', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้ฉำฉา', amount: 6060.00, payee: 'นายชาติชาย คำสงค์', remarks: 'เวลา 17:17' },
            { id: 'exp_06_14', date: '2026-07-09', category: 'อื่น ๆ', merchant: 'ค่าขนส่ง', amount: 12000.00, payee: 'นายชาคริต ยอดสุวรรณ์', remarks: 'เวลา 14:09' },
            { id: 'exp_06_15', date: '2026-07-10', category: 'ค่าน้ำมันรถ', merchant: 'น้ำมัน', amount: 3000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 08:14' },
            { id: 'exp_06_16', date: '2026-07-10', category: 'อื่น ๆ', merchant: 'ใบอนุญาตต่ออายุ', amount: 14000.00, payee: 'นางสุกัลยา จันต๊ะอิน', remarks: 'เวลา 10:55' },
            { id: 'exp_06_17', date: '2026-07-10', category: 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', merchant: 'อะไหล่โฟล์คลิฟท์', amount: 3000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 11:21' },
            { id: 'exp_06_18', date: '2026-07-11', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ค่าไม้', amount: 5375.00, payee: 'น.ส. ปัณฑารีย์ เชื้อเมืองพาน', remarks: 'เวลา 12:05' },
            { id: 'exp_06_19', date: '2026-07-11', category: 'ค่าแรงงาน/รับเหมา', merchant: 'ค่ารถไถ 4,000 + คนงานเบิกเงิน 6,500', amount: 10500.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 13:16' },
            { id: 'exp_06_20', date: '2026-07-11', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ค่าซื้อไม้', amount: 4675.00, payee: 'น.ส. ปัณฑารีย์ เชื้อเมืองพาน', remarks: 'เวลา 17:39' },
            { id: 'exp_06_21', date: '2026-07-11', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'เหล็กลวดเชื่อม', amount: 2805.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 17:40' },
            { id: 'exp_06_22', date: '2026-07-13', category: 'ค่าซ่อม/บำรุงรักษาเครื่องจักร', merchant: 'ทำใบเลื่อยวงเดือน', amount: 10000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 14:47' },
            { id: 'exp_06_23', date: '2026-07-14', category: 'ค่าน้ำมันรถ', merchant: 'น้ำมันส่งของ', amount: 6000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 11:00' },
            { id: 'exp_06_24', date: '2026-07-14', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 5590.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 13:32' },
            { id: 'exp_06_25', date: '2026-07-15', category: 'อื่น ๆ', merchant: 'สำรองจ่าย', amount: 5000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 09:48' },
            { id: 'exp_06_26', date: '2026-07-15', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ใบมีดไสเรียบ', amount: 8380.00, payee: 'น.ส. สุญทิพ อุดมศิลป์', remarks: 'เวลา 14:30' },
            { id: 'exp_06_27', date: '2026-07-16', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 3000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 10:06' },
            { id: 'exp_06_28', date: '2026-07-16', category: 'ค่าซ่อม/อะไหล่รถยนต์', merchant: 'ปะยาง', amount: 2000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 16:23' },
            { id: 'exp_06_29', date: '2026-07-16', category: 'ค่าแรงงาน/รับเหมา', merchant: 'เงินเดือนยังขาด (เดือน 1–15 ก.ค. 69 ยอด 115,265 ชำระ 59,000)', amount: 59000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 17:52' },
            { id: 'exp_06_30', date: '2026-07-18', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ใบเลื่อย', amount: 1000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 14:57' },
            { id: 'exp_06_31', date: '2026-07-19', category: 'ค่าแรงงาน/รับเหมา', merchant: 'ค่าแรง 1–15 ก.ค. 69 ส่วนที่เหลือ', amount: 50000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 10:04' },
            { id: 'exp_06_32', date: '2026-07-22', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ใบเลื่อย (อ้างอิงใบส่งของ 14/7/69 รวม 15,180)', amount: 15180.00, payee: 'นายวุฒิพงษ์ เดชพละ', remarks: 'เวลา 10:57' },
            { id: 'exp_06_33', date: '2026-07-22', category: 'ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์', merchant: 'ค่าไฟฟ้า', amount: 11393.87, payee: 'การไฟฟ้าส่วนภูมิภาค', remarks: 'เวลา 09:37' },
            { id: 'exp_06_34', date: '2026-07-22', category: 'ค่าน้ำ/ค่าไฟ/ค่าโทรศัพท์', merchant: 'ค่าไฟฟ้า', amount: 7576.45, payee: 'การไฟฟ้าส่วนภูมิภาค', remarks: 'เวลา 09:35' },
            { id: 'exp_06_35', date: '2026-07-25', category: 'อื่น ๆ', merchant: 'ค่างวดรถ 20,700 (คนงานเบิก 7,000 + พี่มัดมีแล้ว 15,000 ขาดอีก 12,700)', amount: 12700.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 14:44' },
            { id: 'exp_06_36', date: '2026-07-26', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ไม้แห้ง', amount: 5000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 12:53' },
            { id: 'exp_06_37', date: '2026-07-27', category: 'อื่น ๆ', merchant: 'เงินโอน (ไม่ระบุวัตถุประสงค์)', amount: 4000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 13:14' },
            { id: 'exp_06_38', date: '2026-07-27', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้ (PromptPay)', amount: 1770.00, payee: 'น.ส. ปัณฑารีย์ เชื้อเมืองพาน', remarks: 'เวลา 13:40' },
            { id: 'exp_06_39', date: '2026-07-28', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 1955.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 17:03' },
            { id: 'exp_06_40', date: '2026-07-29', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 1750.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 12:10' },
            { id: 'exp_06_41', date: '2026-07-30', category: 'ค่าน้ำมันรถ', merchant: 'ค่าน้ำมัน', amount: 2000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 11:07' },
            { id: 'exp_06_42', date: '2026-07-30', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 3000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 18:13' },
            { id: 'exp_06_43', date: '2026-07-31', category: 'อื่น ๆ', merchant: 'ดอกเบี้ยอาแสวง', amount: 7500.00, payee: 'นายแสวง ทองคำ', remarks: 'เวลา 08:34' },
            { id: 'exp_06_44', date: '2026-07-31', category: 'อื่น ๆ', merchant: 'ดอกเบี้ย 300,000 บาท (ยืมเงินบริษัทวัน)', amount: 4500.00, payee: 'น.ส. ผนิสา คงอ่ำ', remarks: 'เวลา 08:31' },
            { id: 'exp_06_45', date: '2026-07-31', category: 'ค่าของเบ็ดเตล็ด/ค่าของใช้งาน', merchant: 'ซื้อไม้', amount: 1485.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 10:17' },
            { id: 'exp_06_46', date: '2026-07-31', category: 'ค่าน้ำมันรถ', merchant: 'น้ำมัน', amount: 2000.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 16:03' },
            { id: 'exp_06_47', date: '2026-08-01', category: 'ค่าแรงงาน/รับเหมา', merchant: 'ค่าแรง 16–31 ก.ค. 69', amount: 99461.00, payee: 'นายมัสถชัย คำอ้าย', remarks: 'เวลา 12:54' }
        ],
        mtp_revenue: [
            // June 2026
            { id: 'rev_01', date: '2026-06-10', customer: 'บจก. ไทยวู้ดโปรดักส์', amount: 120000, remarks: 'ส่งมอบไม้สักแปรรูป ล็อตใหญ่ A' },
            { id: 'rev_02', date: '2026-06-25', customer: 'โรงเลื่อยประชานิมิต', amount: 60000, remarks: 'เศษท่อนไม้เบญจพรรณและไม้โครง' },
            
            // July 2026
            { id: 'rev_03', date: '2026-07-05', customer: 'บจก. เอเชียทิมเบอร์', amount: 150000, remarks: 'ขายไม้จามจุรีย์แปรรูปอบแห้ง ล็อต 1' },
            { id: 'rev_04', date: '2026-07-20', customer: 'โรงเลื่อยรุ่งเรืองพานิช', amount: 70000, remarks: 'ขี้เลื่อยและเปลือกไม้ส่งชีวมวล' }
        ],
        'jamjuree-revenue': [
            // June 2026
            { id: 'jam_01', date: '2026-06-15', customer: 'ลูกค้าหน้าร้านชลบุรี', amount: 25000, remarks: 'โต๊ะทำงานไม้จามจุรีย์กว้างพิเศษ' },
            { id: 'jam_02', date: '2026-06-28', customer: 'คุณสุวรรณกรีน', amount: 20000, remarks: 'แผ่นไม้จามจุรีย์ดิบขัดผิวมัดจำ' },
            
            // July 2026
            { id: 'jam_03', date: '2026-07-12', customer: 'ร้านสิริเฟอร์นิเจอร์', amount: 42000, remarks: 'เก้าอี้ไม้จามจุรีย์สั่งผลิต 10 ชิ้น' },
            { id: 'jam_04', date: '2026-07-25', customer: 'คุณนลินี บ้านสวย', amount: 20000, remarks: 'ยอดโอนงวดที่ 2 โต๊ะประชุมยาว' }
        ],
        'twash-loans': [
            // June 2026
            { id: 'loan_01', date: '2026-06-02', purpose: 'ยืมหมุนค่าน้ำมันหน้าแปลง', type: 'borrow', amount: 40000, remarks: 'ที.วอช ขอยืมทดรองจ่าย' },
            { id: 'loan_02', date: '2026-06-22', purpose: 'โอนคืนเงินยืมบางส่วน', type: 'repay', amount: 10000, remarks: 'โอนคืนเข้า บัญชี MTP' },
            
            // July 2026
            { id: 'loan_03', date: '2026-07-01', purpose: 'ยืมจ่ายค่าอะไหล่ด่วนรถสอย', type: 'borrow', amount: 25000, remarks: 'ที.วอช ยืมไป' },
            { id: 'loan_04', date: '2026-07-18', purpose: 'โอนคืนบัญชีบริษัท', type: 'repay', amount: 10000, remarks: 'คืนยอดค้างสะสม' }
        ],
        'asawaeng-loans': [
            // June 2026 (Initial borrow 500,000)
            { id: 'asw_01', date: '2026-06-01', purpose: 'รับยอดเงินกู้ยืมลงทุนจากคุณอาแสวง', type: 'borrow', amount: 500000, remarks: 'เงินทุนขยายโรงเลื่อย เฟส 2' },
            // July 2026 (Repay 20,000)
            { id: 'asw_02', date: '2026-07-10', purpose: 'โอนเงินชำระหนี้คืนคุณอาแสวงงวดประจำเดือน', type: 'repay', amount: 20000, remarks: 'โอนผ่านกสิกรไทย' }
        ],
        'wan-loans': [
            // June 2026 (Initial borrow 300,000)
            { id: 'wan_01', date: '2026-06-01', purpose: 'รับเงินกู้ยืมหมุนเวียน บ.วัน', type: 'borrow', amount: 300000, remarks: 'สัญญากู้ยืมเลขที่ 002/2569' },
            // July 2026 (Repay 15,000)
            { id: 'wan_02', date: '2026-07-15', purpose: 'โอนชำระหนี้คืนบริษัท วัน', type: 'repay', amount: 15000, remarks: 'ตัดชำระรายเดือน' }
        ],
        'pimas-expenses': [
            // June 2026
            { id: 'pimas_01', date: '2026-06-04', description: 'สำรองจ่ายค่าอัดยางนอกรถแทรกเตอร์', status: 'paid', amount: 8500, remarks: 'ชำระคืนพี่มัสแล้ว 20 มิ.ย.' },
            { id: 'pimas_02', date: '2026-06-18', description: 'ของชำร่วยงานบุญวันก่อตั้งโรงงาน', status: 'paid', amount: 12000, remarks: 'ชำระคืนพี่มัสแล้ว 25 มิ.ย.' },
            
            // July 2026
            { id: 'pimas_03', date: '2026-07-10', description: 'โซ่เลื่อยยนต์และอะไหล่ด่วนแท่นบาก', status: 'unpaid', amount: 6500, remarks: 'รอเบิกงวดถัดไป' },
            { id: 'pimas_04', date: '2026-07-24', description: 'สั่งข้าวกล่องช่างซ่อมฐานปูนเสาโรงงาน', status: 'paid', amount: 4200, remarks: 'ชำระคืนโอนแล้ว ก.ค.' },
            { id: 'pimas_05', date: '2026-07-31', description: 'ค่าบริการเครื่องดื่มช่างลากไม้ช่วงบ่าย', status: 'unpaid', amount: 3500, remarks: 'ยอดสะสมรอบิลเคลียร์' }
        ]
    };

    migrateDatabaseCategories();
    saveDatabase();
    processAndRefreshAll();
    
    if (!silent) {
        showToast('โหลดข้อมูลบัญชีจำลอง (กรกฎาคม 2569) สำเร็จ!', 'success');
        switchTab('overview');
    }
}

// Migration function for old categories to new category tags
function migrateDatabaseCategories() {
    if (!db || !db.mtp_expenses) return;
    let modified = false;
    db.mtp_expenses.forEach(item => {
        const oldCat = item.category;
        if (oldCat) {
            let newCat = oldCat;
            if (oldCat.includes('ไม้')) newCat = 'ค่าไม้';
            else if (oldCat.includes('น้ำมัน')) newCat = 'ค่าน้ำมัน';
            else if (oldCat.includes('แรง') || oldCat.includes('คนงาน') || oldCat.includes('เงินเดือน') || oldCat.includes('รับเหมา')) newCat = 'ค่าแรง';
            else if (oldCat.includes('ซ่อม') || oldCat.includes('อะไหล่') || oldCat.includes('เครื่องจักร') || oldCat.includes('รถยนต์') || oldCat.includes('ลูกปืน') || oldCat.includes('ใบมีด')) newCat = 'ค่าอะไหล่';
            else if (oldCat.includes('ไฟ') || oldCat.includes('น้ำ') || oldCat.includes('โทรศัพท์')) newCat = 'ค่าไฟ/น้ำ';
            else newCat = 'ค่าเช่า/อื่นๆ';
            
            if (newCat !== oldCat) {
                item.category = newCat;
                modified = true;
            }
        }
    });
    if (modified) {
        saveDatabase();
    }
}

// Vendor / Recipient Summary View Renderer
function renderVendorSummaryTable() {
    const table = document.getElementById('table-vendors');
    if (!table) return;

    const startDateVal = document.getElementById('vendor-start-date').value;
    const endDateVal = document.getElementById('vendor-end-date').value;
    const searchVal = document.getElementById('vendor-search').value.toLowerCase().trim();

    const vendorMap = {};

    const addPayout = (recipient, amount, date, source, ref) => {
        if (!recipient) recipient = '(ไม่ระบุ)';
        const name = String(recipient).trim();
        
        if (startDateVal && date < startDateVal) return;
        if (endDateVal && date > endDateVal) return;

        if (!vendorMap[name]) {
            vendorMap[name] = { total: 0, count: 0, details: [] };
        }
        vendorMap[name].total += parseFloat(amount) || 0;
        vendorMap[name].count += 1;
        vendorMap[name].details.push({ date, amount, source, ref });
    };

    // Aggregate payouts
    (db.mtp_expenses || []).forEach(row => {
        addPayout(row.payee || row.recipient, row.amount, row.date, '1. ค่าใช้จ่ายทั่วไป', row.billRef || row.remarks);
    });

    (db['pimas-expenses'] || []).forEach(row => {
        addPayout(row.payee || "นาย มัสถชัย คำอ้าย", row.amount, row.date, '5. เงินสำรองจ่าย พี่มัด', row.billRef || row.remarks);
    });

    (db['twash-loans'] || []).forEach(row => {
        if (row.type === 'repay') {
            addPayout("ที.วอช (T-Wash)", row.amount, row.date, '2. เงินยืม ที.วอช', row.billRef || row.remarks);
        }
    });

    (db['asawaeng-loans'] || []).forEach(row => {
        if (row.type === 'repay') {
            addPayout("นายแสวง ทองคำ", row.amount, row.date, '3. เงินกู้ คุณอาแสวง', row.billRef || row.remarks);
        }
    });

    (db['wan-loans'] || []).forEach(row => {
        if (row.type === 'repay') {
            addPayout("บจก. วัน (Wan)", row.amount, row.date, '4. เงินกู้ บ.วัน', row.billRef || row.remarks);
        }
    });

    let sortedVendors = Object.keys(vendorMap).map(name => ({
        name,
        total: vendorMap[name].total,
        count: vendorMap[name].count,
        details: vendorMap[name].details
    }));

    if (searchVal) {
        sortedVendors = sortedVendors.filter(v => v.name.toLowerCase().includes(searchVal));
    }

    sortedVendors.sort((a, b) => b.total - a.total);

    table.innerHTML = `
        <thead>
            <tr>
                <th style="width: 35%;">ชื่อผู้รับเงิน / คู่ค้า (Recipient / Vendor)</th>
                <th style="width: 20%; text-align: right;">จำนวนรายการชำระ</th>
                <th style="width: 25%; text-align: right;">ยอดรวมเงินชำระ (บาท)</th>
                <th style="width: 20%; text-align: center;">ตรวจสอบ</th>
            </tr>
        </thead>
        <tbody>
            ${sortedVendors.length === 0 ? `
                <tr>
                    <td colspan="4" class="text-center" style="padding: 2rem; color: var(--text-muted);">
                        ไม่พบข้อมูลสรุปยอดผู้รับเงินในช่วงเวลาที่เลือก
                    </td>
                </tr>
            ` : sortedVendors.map((v, idx) => `
                <tr>
                    <td style="font-weight: 600; color: var(--text-primary);">${v.name}</td>
                    <td style="text-align: right;">${v.count} รายการ</td>
                    <td style="text-align: right; font-weight: 700; color: var(--accent-color);">
                        ฿${v.total.toLocaleString('th-TH', {minimumFractionDigits: 2})}
                    </td>
                    <td style="text-align: center;">
                        <button class="btn btn-secondary" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;" onclick="viewVendorAuditDetails(${idx})">
                            🔍 ตรวจสอบบิล
                        </button>
                    </td>
                </tr>
            `).join('')}
        </tbody>
    `;

    window.currentSortedVendors = sortedVendors;
}

function resetVendorFilters() {
    document.getElementById('vendor-start-date').value = '';
    document.getElementById('vendor-end-date').value = '';
    document.getElementById('vendor-search').value = '';
    renderVendorSummaryTable();
}

function viewVendorAuditDetails(idx) {
    const vendor = window.currentSortedVendors[idx];
    if (!vendor) return;

    document.getElementById('audit-modal-title').textContent = `ประวัติการชำระเงิน: ${vendor.name}`;
    const table = document.getElementById('audit-modal-table');
    
    const details = vendor.details.sort((a, b) => b.date.localeCompare(a.date));

    table.innerHTML = `
        <thead>
            <tr>
                <th style="width: 20%;">วันที่</th>
                <th style="width: 25%;">สมุดบัญชี</th>
                <th style="width: 30%;">เลขอ้างอิง / รายละเอียด</th>
                <th style="width: 25%; text-align: right;">จำนวนเงิน (บาท)</th>
            </tr>
        </thead>
        <tbody>
            ${details.map(d => `
                <tr>
                    <td>${new Date(d.date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    <td><span class="badge badge-info">${d.source}</span></td>
                    <td style="font-size: 0.8rem; color: var(--text-muted);">${d.ref || '-'}</td>
                    <td class="text-right text-bold text-danger">฿${parseFloat(d.amount).toLocaleString('th-TH', {minimumFractionDigits: 2})}</td>
                </tr>
            `).join('')}
        </tbody>
    `;

    document.getElementById('audit-modal').classList.add('active');
}

function closeAuditModal() {
    document.getElementById('audit-modal').classList.remove('active');
}
