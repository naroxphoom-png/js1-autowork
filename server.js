const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const multer = require('multer'); // เพิ่มไลบรารีจัดการไฟล์อัปโหลด
const app = express();
const server = http.createServer(app);
const io = new Server(server);
// ตั้งค่า Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // เปิดให้เข้าถึงโฟลเดอร์รูปภาพได้ผ่าน URL /uploads/...
// ตั้งค่าการเก็บไฟล์อัปโหลด (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        const fs = require('fs');
        if (!fs.existsSync(uploadDir)){
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'slip-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
// 1. ระบบฐานข้อมูล (Database Setup)
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error("Database connection error:", err.message);
    else console.log("Connected to the SQLite database.");
});
db.serialize(() => {
    // ตารางหลัก Jobs (เพิ่ม spare_details และ spare_eta)
    db.run(`CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        car_model TEXT,
        license_plate TEXT,
        phone_number TEXT,
        phone_number2 TEXT,
        receiver TEXT,
        time_in TEXT,
        promised_date TEXT,
        promised_time TEXT,
        delay_count INTEGER DEFAULT 0,
        team TEXT DEFAULT '0',
        service_details TEXT,
        waiting_status TEXT,
        remarks TEXT,
        payment_status TEXT DEFAULT 'รอชำระ',
        cashier_name TEXT,
        postpone_until TEXT,
        is_cancelled INTEGER DEFAULT 0,
        is_delivered INTEGER DEFAULT 0,
        key_status INTEGER DEFAULT 0,
        job_status INTEGER DEFAULT 0,
        created_date TEXT,
        delivered_at TEXT,
        custom_status TEXT,
        spare_details TEXT,
        spare_eta TEXT
    )`);
    // ตารางรายงานลูกค้าใหม่ (New Customers)
    db.run(`CREATE TABLE IF NOT EXISTS new_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        receiver TEXT,
        car_model TEXT,
        license_plate TEXT,
        channel TEXT
    )`);
    // ตารางรายงานงานแก้ (Rework Jobs) - เพิ่มคอลัมน์ team
    db.run(`CREATE TABLE IF NOT EXISTS rework_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        receiver TEXT,
        team TEXT,
        car_model TEXT,
        license_plate TEXT,
        details TEXT
    )`);
    // ตารางเก็บชื่อลูกค้าค้าส่ง
    db.run(`CREATE TABLE IF NOT EXISTS wholesale_customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE
    )`);
    // ตารางเก็บออเดอร์ลูกค้าค้าส่ง
    db.run(`CREATE TABLE IF NOT EXISTS wholesale_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receiver TEXT,
        customer_name TEXT,
        order_details TEXT,
        pickup_time TEXT,
        created_date TEXT,
        created_time TEXT,
        status TEXT DEFAULT 'รอ',
        cashier_name TEXT
    )`);
    // ตารางเก็บประวัติการแก้ไขรายการค้าส่ง
    db.run(`CREATE TABLE IF NOT EXISTS wholesale_edit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        editor TEXT,
        details TEXT,
        edited_at TEXT
    )`);
    // ตารางเก็บประวัติ Tracking สถานะค้าส่ง
    db.run(`CREATE TABLE IF NOT EXISTS wholesale_status_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        status TEXT,
        person TEXT,
        timestamp TEXT
    )`);
    // ตารางเก็บประวัติการลบรายการค้าส่ง
    db.run(`CREATE TABLE IF NOT EXISTS wholesale_delete_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT,
        order_details TEXT,
        reason TEXT,
        deleted_at TEXT
    )`);
    const alterQueries = [
        "ALTER TABLE jobs ADD COLUMN key_status INTEGER DEFAULT 0",
        "ALTER TABLE jobs ADD COLUMN job_status INTEGER DEFAULT 0",
        "ALTER TABLE jobs ADD COLUMN is_delivered INTEGER DEFAULT 0",
        "ALTER TABLE jobs ADD COLUMN delivered_at TEXT",
        "ALTER TABLE jobs ADD COLUMN is_cancelled INTEGER DEFAULT 0",
        "ALTER TABLE jobs ADD COLUMN payment_status TEXT DEFAULT 'รอชำระ'",
        "ALTER TABLE jobs ADD COLUMN cashier_name TEXT",
        "ALTER TABLE jobs ADD COLUMN postpone_until TEXT",
        "ALTER TABLE jobs ADD COLUMN delay_count INTEGER DEFAULT 0",
        "ALTER TABLE jobs ADD COLUMN created_date TEXT",
        "ALTER TABLE jobs ADD COLUMN phone_number TEXT",
        "ALTER TABLE jobs ADD COLUMN phone_number2 TEXT",
        "ALTER TABLE jobs ADD COLUMN custom_status TEXT",
        "ALTER TABLE jobs ADD COLUMN spare_details TEXT",
        "ALTER TABLE jobs ADD COLUMN spare_eta TEXT",
        "ALTER TABLE rework_jobs ADD COLUMN team TEXT",
        "ALTER TABLE wholesale_jobs ADD COLUMN pickup_time TEXT",
        "ALTER TABLE wholesale_jobs ADD COLUMN created_time TEXT",
        "ALTER TABLE wholesale_jobs ADD COLUMN cashier_name TEXT"
    ];
    alterQueries.forEach(query => {
        db.run(query, (err) => {});
    });
});
// 2. API Endpoints - Jobs หลัก
app.get('/api/jobs', (req, res) => {
    const queryDate = req.query.date;
    let query = 'SELECT * FROM jobs ORDER BY id DESC';
    let params = [];
    if (queryDate) {
        query = `SELECT * FROM jobs 
                 WHERE created_date = ? 
                    OR promised_date = ? 
                    OR date(delivered_at) = ?
                    OR (is_delivered = 0 AND (payment_status != 'ชำระเงินแล้ว' OR payment_status IS NULL) AND is_cancelled = 0)
                 ORDER BY id DESC`;
        params = [queryDate, queryDate, queryDate];
    }
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ jobs: rows });
    });
});
app.get('/api/jobs/track/:id', (req, res) => {
    const jobId = req.params.id;
    db.get('SELECT * FROM jobs WHERE id = ?', [jobId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูลรถคันนี้' });
        res.json({ job: row });
    });
});
app.get('/api/jobs/check-duplicate', (req, res) => {
    const plate = req.query.plate;
    if (!plate) return res.json({ exists: false });
    const query = `SELECT COUNT(*) as count FROM jobs 
                   WHERE license_plate = ? 
                      AND is_delivered = 0 
                      AND payment_status != 'ชำระเงินแล้ว' 
                      AND is_cancelled = 0`;
    db.get(query, [plate], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ exists: row.count > 0 });
    });
});
app.post('/api/jobs', (req, res) => {
    const {
        car_model, license_plate, phone_number, phone_number2, receiver, time_in,
        created_date, service_details, waiting_status,
        remarks, team, promised_date, promised_time,
        vip_status, new_customer_channel
    } = req.body;
    const todayStr = created_date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    
    const insertJobQuery = `INSERT INTO jobs (
        car_model, license_plate, phone_number, phone_number2, receiver, time_in,
        created_date, service_details, waiting_status,
        remarks, team, promised_date, promised_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(insertJobQuery, [
        car_model, license_plate, phone_number || '', phone_number2 || '', receiver, time_in,
        todayStr, service_details, waiting_status,
        remarks, team || '0', promised_date || null, promised_time || null
    ], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const jobId = this.lastID;
        
        if (vip_status === 'ลูกค้าใหม่' && new_customer_channel) {
            db.run(`INSERT INTO new_customers (date, receiver, car_model, license_plate, channel) VALUES (?, ?, ?, ?, ?)`,
                [todayStr, receiver, car_model, license_plate, new_customer_channel]);
        }
        
        if (service_details && service_details.includes('[งานแก้]')) {
            db.run(`INSERT INTO rework_jobs (date, receiver, team, car_model, license_plate, details) VALUES (?, ?, ?, ?, ?, ?)`,
                [todayStr, receiver, team || '0', car_model, license_plate, service_details]);
        }
        
        io.emit('data_updated');
        res.json({ id: jobId, success: true });
    });
});
// Wholesale API
app.get('/api/wholesale/customers', (req, res) => {
    db.all('SELECT name FROM wholesale_customers ORDER BY name ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ customers: rows.map(r => r.name) });
    });
});
app.post('/api/wholesale/customers', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    db.run('INSERT OR IGNORE INTO wholesale_customers (name) VALUES (?)', [name], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});
app.get('/api/wholesale/jobs', (req, res) => {
    const queryDate = req.query.date;
    let query = 'SELECT * FROM wholesale_jobs ORDER BY id DESC';
    let params = [];
    if (queryDate) {
        query = `SELECT * FROM wholesale_jobs 
                 WHERE created_date = ? 
                    OR date(pickup_time) = ? 
                    OR (status NOT LIKE 'ปิดงาน%' AND created_date < ?) 
                 ORDER BY id DESC`;
        params = [queryDate, queryDate, queryDate];
    }
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ jobs: rows });
    });
});
app.post('/api/wholesale/jobs', (req, res) => {
    const { receiver, customer_name, order_details, pickup_time, created_date, created_time } = req.body;
    const initialStatus = 'รอ';
    db.run(`INSERT INTO wholesale_jobs (receiver, customer_name, order_details, pickup_time, created_date, created_time, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`, 
    [receiver, customer_name, order_details, pickup_time, created_date, created_time, initialStatus], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        const newJobId = this.lastID;
        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        db.run(`INSERT INTO wholesale_status_tracking (job_id, status, person, timestamp) VALUES (?, ?, ?, ?)`,
            [newJobId, 'สร้างรายการสั่งค้าส่ง (รอ)', receiver || '-', nowStr]);
        io.emit('data_updated');
        res.json({ id: newJobId, success: true });
    });
});
app.put('/api/wholesale/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    const { order_details, editor } = req.body;
    if (!editor) {
        return res.status(400).json({ success: false, error: 'กรุณาระบุชื่อผู้บันทึกการแก้ไข' });
    }
    db.run(`UPDATE wholesale_jobs SET order_details = ? WHERE id = ?`,
        [order_details, jobId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
            db.run(`INSERT INTO wholesale_edit_logs (job_id, editor, details, edited_at) VALUES (?, ?, ?, ?)`,
                [jobId, editor, `แก้ไขรายการสั่งเป็น: ${order_details}`, nowStr], (logErr) => {
                    if (logErr) console.error("Error inserting edit log:", logErr.message);
                    io.emit('data_updated');
                    res.json({ success: true });
                });
        });
});
app.put('/api/wholesale/jobs/:id/status', (req, res) => {
    const jobId = req.params.id;
    const { status, person } = req.body;
    if (status === 'ปิดงานแล้ว' || status === 'ปิดงาน') {
        return res.status(403).json({ success: false, error: 'ไม่สามารถเปลี่ยนสถานะเป็นปิดงานได้จากส่วนนี้ ต้องปิดงานจากแผนกการเงินเท่านั้น' });
    }
    db.run(`UPDATE wholesale_jobs SET status = ? WHERE id = ?`, [status, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        db.run(`INSERT INTO wholesale_status_tracking (job_id, status, person, timestamp) VALUES (?, ?, ?, ?)`,
            [jobId, status, person || '-', nowStr], (trackErr) => {
                if (trackErr) console.error("Error inserting tracking log:", trackErr.message);
                io.emit('data_updated');
                res.json({ success: true });
            });
    });
});
app.put('/api/wholesale/jobs/:id/close', (req, res) => {
    const jobId = req.params.id;
    const { cashier_name } = req.body;
    if (!cashier_name) {
        return res.status(400).json({ success: false, error: 'กรุณาระบุชื่อพนักงานการเงิน' });
    }
    db.get(`SELECT status FROM wholesale_jobs WHERE id = ?`, [jobId], (err, row) => {
        if (err || !row) {
            return res.status(500).json({ success: false, error: 'ไม่พบรายการค้าส่งนี้' });
        }
        const currentStatus = row.status || '';
        const isReadyToClose = currentStatus.startsWith('จัดเสร็จแล้ว พร้อมส่งหน้าร้าน') || 
                               currentStatus.startsWith('จัดเสร็จแล้ว พร้อมส่งขนส่ง');
        if (!isReadyToClose) {
            return res.status(400).json({ 
                success: false, 
                error: `รายการนี้ยังอยู่ในสถานะที่ไม่พร้อมปิดงาน (สถานะปัจจุบัน: ${currentStatus})` 
            });
        }
        const newStatus = `ปิดงานแล้ว (การเงิน: ${cashier_name})`;
        const timestamp = new Date().toLocaleString('th-TH');
        db.run(
            `UPDATE wholesale_jobs SET status = ? WHERE id = ?`,
            [newStatus, jobId],
            function(updateErr) {
                if (updateErr) {
                    return res.status(500).json({ success: false, error: 'Failed to update status' });
                }
                db.run(`UPDATE wholesale_jobs SET cashier_name = ? WHERE id = ?`, [cashier_name, jobId], () => {});
                db.run(
                    `INSERT INTO wholesale_status_tracking (job_id, status, person, timestamp) VALUES (?, ?, ?, ?)`,
                    [jobId, newStatus, cashier_name, timestamp],
                    (trackingErr) => {
                        if (typeof io !== 'undefined') {
                            io.emit('data_updated');
                        }
                        return res.json({ success: true, message: 'ปิดงานสำเร็จเรียบร้อย' });
                    }
                );
            }
        );
    });
});
app.get('/api/wholesale/jobs/:id/tracking', (req, res) => {
    const jobId = req.params.id;
    db.all(`SELECT status, person, timestamp FROM wholesale_status_tracking WHERE job_id = ? ORDER BY id ASC`, [jobId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message, tracking: [] });
        res.json({ tracking: rows });
    });
});
app.get('/api/wholesale/jobs/:id/edit-logs', (req, res) => {
    const jobId = req.params.id;
    db.all(`SELECT editor, details, edited_at FROM wholesale_edit_logs WHERE job_id = ? ORDER BY id DESC`, [jobId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message, logs: [] });
        res.json({ logs: rows });
    });
});
app.delete('/api/wholesale/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    const { password, reason } = req.body;
    if (password !== 'SPP1234' && password !== 'SPAPA1234') {
        return res.status(401).json({ success: false, error: 'รหัสผ่านไม่ถูกต้อง!' });
    }
    if (!reason || reason.trim() === '') {
        return res.status(400).json({ success: false, error: 'กรุณาระบุเหตุผลในการลบ' });
    }
    db.get('SELECT * FROM wholesale_jobs WHERE id = ?', [jobId], (err, job) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!job) return res.status(404).json({ error: 'ไม่พบรายการที่ต้องการลบ' });
        
        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        
        db.run(`INSERT INTO wholesale_delete_logs (customer_name, order_details, reason, deleted_at) VALUES (?, ?, ?, ?)`,
            [job.customer_name, job.order_details, reason, nowStr], (logErr) => {
                if (logErr) console.error("Error saving delete log:", logErr.message);
                db.run('DELETE FROM wholesale_jobs WHERE id = ?', [jobId], function(delErr) {
                    if (delErr) return res.status(500).json({ error: delErr.message });
                    io.emit('data_updated');
                    res.json({ success: true });
                });
            });
    });
});
app.get('/api/wholesale/delete-logs', (req, res) => {
    db.all('SELECT * FROM wholesale_delete_logs ORDER BY id DESC LIMIT 50', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ logs: rows });
    });
});
// Update API ต่างๆ ของ Jobs หลัก
app.put('/api/jobs/:id/promised', (req, res) => {
    const jobId = req.params.id;
    const { promised_date, promised_time } = req.body;
    const query = `UPDATE jobs SET promised_date = ?, promised_time = ? WHERE id = ?`;
    db.run(query, [promised_date, promised_time, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true, message: "อัปเดตเวลานัดส่งเรียบร้อยแล้ว" });
    });
});
app.put('/api/jobs/:id/receiver', (req, res) => {
    const jobId = req.params.id;
    const { receiver } = req.body;
    db.run(`UPDATE jobs SET receiver = ? WHERE id = ?`, [receiver, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/model', (req, res) => {
    const jobId = req.params.id;
    const { car_model } = req.body;
    db.run(`UPDATE jobs SET car_model = ? WHERE id = ?`, [car_model, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/plate', (req, res) => {
    const jobId = req.params.id;
    const { license_plate } = req.body;
    db.run(`UPDATE jobs SET license_plate = ? WHERE id = ?`, [license_plate, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/service', (req, res) => {
    const jobId = req.params.id;
    const { service_details } = req.body;
    db.run(`UPDATE jobs SET service_details = ? WHERE id = ?`, [service_details, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/waiting', (req, res) => {
    const jobId = req.params.id;
    const { waiting_status } = req.body;
    db.run(`UPDATE jobs SET waiting_status = ? WHERE id = ?`, [waiting_status, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/remarks', (req, res) => {
    const jobId = req.params.id;
    const { remarks } = req.body;
    db.run(`UPDATE jobs SET remarks = ? WHERE id = ?`, [remarks, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/team', (req, res) => {
    const jobId = req.params.id;
    const { team } = req.body;
    db.run(`UPDATE jobs SET team = ? WHERE id = ?`, [team, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
// API อัปเดตสถานะและรายละเอียดอะไหล่
app.put('/api/jobs/:id/custom_status', (req, res) => {
    const jobId = req.params.id;
    const { custom_status, spare_details, spare_eta } = req.body;
    const sql = `UPDATE jobs 
                 SET custom_status = ?, spare_details = ?, spare_eta = ? 
                 WHERE id = ?`;
    db.run(sql, [custom_status, spare_details, spare_eta, jobId], function(err) {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).json({ error: err.message });
        }
        io.emit('data_updated');
        res.json({ success: true, message: "อัปเดตข้อมูลสถานะอะไหล่เรียบร้อย" });
    });
});
app.put('/api/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    const { receiver, car_model, license_plate, remarks } = req.body;
    let query = `UPDATE jobs SET `;
    let fields = [];
    let params = [];
    if (receiver !== undefined) { fields.push("receiver = ?"); params.push(receiver); }
    if (car_model !== undefined) { fields.push("car_model = ?"); params.push(car_model); }
    if (license_plate !== undefined) { fields.push("license_plate = ?"); params.push(license_plate); }
    if (remarks !== undefined) { fields.push("remarks = ?"); params.push(remarks); }
    if (fields.length === 0) return res.json({ success: true });
    query += fields.join(", ") + ` WHERE id = ?`;
    params.push(jobId);
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.delete('/api/jobs/:id', (req, res) => {
    const jobId = req.params.id;
    db.run(`DELETE FROM jobs WHERE id = ?`, [jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
// รายงานลูกค้าใหม่
app.get('/api/reports/new-customers', (req, res) => {
    const queryDate = req.query.date;
    let query = 'SELECT * FROM new_customers ORDER BY id DESC';
    let params = [];
    if (queryDate) {
        query = 'SELECT * FROM new_customers WHERE date = ? ORDER BY id DESC';
        params = [queryDate];
    }
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ records: rows });
    });
});
// รายงานงานแก้ (Rework Jobs Report)
app.get('/api/reports/rework', (req, res) => {
    const queryDate = req.query.date;
    let query = 'SELECT * FROM rework_jobs ORDER BY id DESC';
    let params = [];
    if (queryDate) {
        query = 'SELECT * FROM rework_jobs WHERE date = ? ORDER BY id DESC';
        params = [queryDate];
    }
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ records: rows });
    });
});
app.put('/api/jobs/:id/deliver-status', (req, res) => {
    const jobId = req.params.id;
    const { key_status, job_status, is_delivered } = req.body;
    const deliveredAt = is_delivered === 1 ? new Date().toISOString() : null;
    const query = `UPDATE jobs 
                   SET key_status = ?, job_status = ?, is_delivered = ?, delivered_at = COALESCE(?, delivered_at) 
                   WHERE id = ?`;
    db.run(query, [key_status, job_status, is_delivered, deliveredAt, jobId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/undeliver', (req, res) => {
    db.run(`UPDATE jobs SET key_status = 0, job_status = 0, is_delivered = 0 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/cancel', (req, res) => {
    db.run('UPDATE jobs SET is_cancelled = 1 WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
app.put('/api/jobs/:id/payment', (req, res) => {
    const { payment_status, cashier_name } = req.body;
    db.run('UPDATE jobs SET payment_status = ?, cashier_name = ? WHERE id = ?', [payment_status, cashier_name || null, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('data_updated');
        res.json({ success: true });
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is successfully running on port ${PORT}`);
});