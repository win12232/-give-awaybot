// ================= [ طبقة قاعدة البيانات SQLite ] =================
// تحل محل database.json و points.json القديمة. تدعم القراءة/الكتابة المتزامنة
// من البوت ومن سيرفر لوحة التحكم الويب بنفس الوقت بدون تلف بيانات.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// لو مستخدم Railway Volume، حط مسار الفولوم بمتغير البيئة DB_PATH
// (مثال: /data/database.sqlite). إذا ما محدد، يستخدم ملف محلي بجذر المشروع.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // يسمح بقراءة وكتابة متزامنة بأمان (مهم جداً لوجود بوت + موقع)

// ================= [ إنشاء الجداول لو ما كانت موجودة ] =================
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS config (
        guild_id TEXT PRIMARY KEY,
        leveling_channel_id TEXT,
        welcome_channel_id TEXT,
        welcome_enabled INTEGER NOT NULL DEFAULT 1,
        goodbye_channel_id TEXT,
        goodbye_enabled INTEGER NOT NULL DEFAULT 1,
        antispam_enabled INTEGER NOT NULL DEFAULT 0,
        antilink_enabled INTEGER NOT NULL DEFAULT 0,
        profanity_filter_enabled INTEGER NOT NULL DEFAULT 0,
        shop_channel_id TEXT,
        game_channel_id TEXT,
        stats_channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS points (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS giveaways (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        data TEXT NOT NULL,      -- بقية بيانات الجيف أواي بصيغة JSON (الجائزة، الشروط، الخ)
        entries TEXT NOT NULL,   -- مصفوفة user IDs بصيغة JSON
        ended INTEGER NOT NULL DEFAULT 0,
        end_time INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_claims (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_claim INTEGER NOT NULL DEFAULT 0,
        streak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        category TEXT NOT NULL,      -- 'admin' | 'security' | 'game' | 'error' | 'giveaway' | 'system' | 'shop'
        actor_id TEXT,                -- من نفذ الحدث (أدمن، عضو، أو NULL لو النظام نفسه)
        action TEXT NOT NULL,         -- وصف مختصر للحدث
        details TEXT,                 -- JSON اختياري لتفاصيل إضافية
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vip_purchases (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tier_key TEXT NOT NULL,     -- 'bronze' | 'silver' | 'gold' | 'diamond'
        purchased_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, tier_key)
    );
`);

// ================= [ ترقية آمنة لجداول قديمة (تضيف أعمدة جديدة لقاعدة بيانات موجودة مسبقاً) ] =================
// لو قاعدة البيانات كانت موجودة قبل إضافة عمود welcome_channel_id/welcome_enabled،
// CREATE TABLE IF NOT EXISTS فوق ما يضيفهم لأن الجدول أصلاً موجود. نحاول نضيفهم يدوياً،
// ونتجاهل الخطأ لو كانوا مضافين من قبل (يعني التشغيل الثاني وما بعده).
function safelyAddColumn(table, columnDef) {
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    } catch (e) {
        // العمود موجود مسبقاً غالباً — نتجاهل بهدوء
    }
}
safelyAddColumn('config', 'welcome_channel_id TEXT');
safelyAddColumn('config', 'welcome_enabled INTEGER NOT NULL DEFAULT 1');
safelyAddColumn('config', 'goodbye_channel_id TEXT');
safelyAddColumn('config', 'goodbye_enabled INTEGER NOT NULL DEFAULT 1');
safelyAddColumn('config', 'antispam_enabled INTEGER NOT NULL DEFAULT 0');
safelyAddColumn('config', 'antilink_enabled INTEGER NOT NULL DEFAULT 0');
safelyAddColumn('config', 'profanity_filter_enabled INTEGER NOT NULL DEFAULT 0');
safelyAddColumn('config', 'shop_channel_id TEXT');
safelyAddColumn('config', 'game_channel_id TEXT');
safelyAddColumn('config', 'stats_channel_id TEXT');

// ================= [ هجرة تلقائية من الملفات القديمة (مرة وحدة بس) ] =================
function migrateFromOldFiles() {
    const alreadyMigrated = db.prepare(`SELECT value FROM meta WHERE key = 'migrated_v1'`).get();
    if (alreadyMigrated) return; // تمت الهجرة قبل كذا، ما نكررها

    const oldDbPath = path.join(__dirname, 'database.json');
    const oldPointsPath = path.join(__dirname, 'points.json');
    let migratedSomething = false;

    // --- هجرة database.json القديم (ليفلات + إعدادات + جيف أواي) ---
    if (fs.existsSync(oldDbPath)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(oldDbPath, 'utf8'));

            // الليفلات (كانت مخزنة كـ "guildId_userId": {xp, level})
            if (oldData.users) {
                const insertUser = db.prepare(`
                    INSERT OR REPLACE INTO users (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)
                `);
                for (const [key, val] of Object.entries(oldData.users)) {
                    const sepIndex = key.indexOf('_');
                    if (sepIndex === -1) continue;
                    const guildId = key.slice(0, sepIndex);
                    const userId = key.slice(sepIndex + 1);
                    insertUser.run(guildId, userId, val.xp || 0, val.level || 0);
                }
            }

            // الإعدادات (كانت عامة لكل البوت، بنطبقها كإعداد افتراضي لأي سيرفر نشوفه لاحقاً)
            if (oldData.config && oldData.config.levelingChannelId) {
                db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_leveling_channel', ?)`)
                    .run(oldData.config.levelingChannelId);
            }

            // الجيف أواي
            if (oldData.giveaways) {
                const insertGiveaway = db.prepare(`
                    INSERT OR REPLACE INTO giveaways (message_id, guild_id, channel_id, data, entries, ended, end_time)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                for (const [messageId, g] of Object.entries(oldData.giveaways)) {
                    const { entries, channelId, ended, endTime, ...rest } = g;
                    insertGiveaway.run(
                        messageId,
                        rest.guildId || 'unknown', // الملف القديم ما كان يخزن guildId صراحة بكل جيف أواي
                        channelId,
                        JSON.stringify(rest),
                        JSON.stringify(entries || []),
                        ended ? 1 : 0,
                        endTime
                    );
                }
            }

            migratedSomething = true;
            console.log('✅ [Migration] تمت هجرة database.json بنجاح إلى SQLite.');
        } catch (e) {
            console.error('❌ [Migration] خطأ أثناء هجرة database.json:', e);
        }
    }

    // --- هجرة points.json القديم (كانت النقاط عامة بدون guild_id، نحطها بـ guild خاص "legacy") ---
    if (fs.existsSync(oldPointsPath)) {
        try {
            const oldPoints = JSON.parse(fs.readFileSync(oldPointsPath, 'utf8'));
            const insertPoints = db.prepare(`
                INSERT OR REPLACE INTO points (guild_id, user_id, points) VALUES ('legacy', ?, ?)
            `);
            for (const [userId, pts] of Object.entries(oldPoints)) {
                insertPoints.run(userId, pts);
            }
            migratedSomething = true;
            console.log('✅ [Migration] تمت هجرة points.json بنجاح إلى SQLite (تحت مفتاح guild "legacy").');
        } catch (e) {
            console.error('❌ [Migration] خطأ أثناء هجرة points.json:', e);
        }
    }

    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_v1', '1')`).run();

    if (migratedSomething) {
        console.log('📦 [Migration] انتهت الهجرة. ملاحظة: الملفات القديمة (database.json / points.json) لم تُحذف تلقائياً — احتفظ بها كنسخة احتياطية أو احذفها يدوياً بعد التأكد.');
    }
}

migrateFromOldFiles();

// ================= [ دوال الليفلات ] =================
function getUserLevel(guildId, userId) {
    const row = db.prepare(`SELECT xp, level FROM users WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
    return row || { xp: 0, level: 0 };
}

function setUserLevel(guildId, userId, xp, level) {
    db.prepare(`
        INSERT INTO users (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level
    `).run(guildId, userId, xp, level);
}

function getLeaderboard(guildId, limit = 10) {
    return db.prepare(`
        SELECT user_id, xp, level FROM users WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT ?
    `).all(guildId, limit);
}

// ================= [ دوال الإعدادات ] =================
function getConfig(guildId) {
    const row = db.prepare(`
        SELECT leveling_channel_id, welcome_channel_id, welcome_enabled,
               goodbye_channel_id, goodbye_enabled, antispam_enabled,
               antilink_enabled, profanity_filter_enabled, shop_channel_id,
               game_channel_id, stats_channel_id
        FROM config WHERE guild_id = ?
    `).get(guildId);
    return row || {
        leveling_channel_id: null, welcome_channel_id: null, welcome_enabled: 1,
        goodbye_channel_id: null, goodbye_enabled: 1, antispam_enabled: 0,
        antilink_enabled: 0, profanity_filter_enabled: 0, shop_channel_id: null,
        game_channel_id: null, stats_channel_id: null
    };
}

function setLevelingChannel(guildId, channelId) {
    db.prepare(`
        INSERT INTO config (guild_id, leveling_channel_id) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET leveling_channel_id = excluded.leveling_channel_id
    `).run(guildId, channelId);
}

function setWelcomeChannel(guildId, channelId) {
    db.prepare(`
        INSERT INTO config (guild_id, welcome_channel_id) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET welcome_channel_id = excluded.welcome_channel_id
    `).run(guildId, channelId);
}

function setGoodbyeChannel(guildId, channelId) {
    db.prepare(`
        INSERT INTO config (guild_id, goodbye_channel_id) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET goodbye_channel_id = excluded.goodbye_channel_id
    `).run(guildId, channelId);
}

function setShopChannel(guildId, channelId) {
    db.prepare(`
        INSERT INTO config (guild_id, shop_channel_id) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET shop_channel_id = excluded.shop_channel_id
    `).run(guildId, channelId);
}

function setGameChannel(guildId, channelId) {
    db.prepare(`
        INSERT INTO config (guild_id, game_channel_id) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET game_channel_id = excluded.game_channel_id
    `).run(guildId, channelId);
}

function setStatsChannel(guildId, channelId) {
    db.prepare(`
        INSERT INTO config (guild_id, stats_channel_id) VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET stats_channel_id = excluded.stats_channel_id
    `).run(guildId, channelId);
}

// feature: 'antispam' | 'antilink' | 'profanity_filter' | 'welcome' | 'goodbye'
const SECURITY_FEATURE_COLUMNS = {
    antispam: 'antispam_enabled',
    antilink: 'antilink_enabled',
    profanity_filter: 'profanity_filter_enabled',
    welcome: 'welcome_enabled',
    goodbye: 'goodbye_enabled'
};

function setSecurityFeature(guildId, feature, enabled) {
    const column = SECURITY_FEATURE_COLUMNS[feature];
    if (!column) throw new Error(`Unknown security feature: ${feature}`);
    // نتأكد فيه صف بالجدول أول شي (لو أول مرة نتعامل مع هالسيرفر)
    db.prepare(`INSERT OR IGNORE INTO config (guild_id) VALUES (?)`).run(guildId);
    db.prepare(`UPDATE config SET ${column} = ? WHERE guild_id = ?`).run(enabled ? 1 : 0, guildId);
}

// ================= [ دوال النقاط ] =================
function getPoints(guildId, userId) {
    const row = db.prepare(`SELECT points FROM points WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
    return row ? row.points : 0;
}

function addPoints(guildId, userId, amount) {
    const current = db.prepare(`SELECT points FROM points WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
    const newTotal = (current ? current.points : 0) + amount;
    db.prepare(`
        INSERT INTO points (guild_id, user_id, points) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET points = excluded.points
    `).run(guildId, userId, newTotal);
    return newTotal;
}

function getPointsLeaderboard(guildId, limit = 10) {
    return db.prepare(`
        SELECT user_id, points FROM points WHERE guild_id = ? ORDER BY points DESC LIMIT ?
    `).all(guildId, limit);
}

// ================= [ دوال الجيف أواي ] =================
function saveGiveaway(messageId, guildId, channelId, dataObj, entriesArray, ended, endTime) {
    db.prepare(`
        INSERT INTO giveaways (message_id, guild_id, channel_id, data, entries, ended, end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
            data = excluded.data,
            entries = excluded.entries,
            ended = excluded.ended,
            end_time = excluded.end_time
    `).run(messageId, guildId, channelId, JSON.stringify(dataObj), JSON.stringify(entriesArray), ended ? 1 : 0, endTime);
}

function deleteGiveaway(messageId) {
    db.prepare(`DELETE FROM giveaways WHERE message_id = ?`).run(messageId);
}

function getAllGiveaways() {
    const rows = db.prepare(`SELECT * FROM giveaways`).all();
    return rows.map(r => ({
        messageId: r.message_id,
        guildId: r.guild_id,
        channelId: r.channel_id,
        ...JSON.parse(r.data),
        entries: JSON.parse(r.entries),
        ended: !!r.ended,
        endTime: r.end_time
    }));
}

function getGiveawaysByGuild(guildId) {
    return getAllGiveaways().filter(g => g.guildId === guildId);
}

// ================= [ دوال المكافأة اليومية /daily ] =================
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 ساعة
const STREAK_GRACE_MS = 48 * 60 * 60 * 1000;   // لو تأخر أكثر من 48 ساعة، السلسلة تنكسر

function getDailyStatus(guildId, userId) {
    const row = db.prepare(`SELECT last_claim, streak FROM daily_claims WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
    if (!row) return { canClaim: true, msRemaining: 0, streak: 0 };

    const elapsed = Date.now() - row.last_claim;
    if (elapsed >= DAILY_COOLDOWN_MS) {
        return { canClaim: true, msRemaining: 0, streak: row.streak };
    }
    return { canClaim: false, msRemaining: DAILY_COOLDOWN_MS - elapsed, streak: row.streak };
}

// يمنح المكافأة اليومية ويرجع {amount, streak, newTotalPoints} أو null لو ما زال بالكولداون
function claimDaily(guildId, userId, baseAmount = 50) {
    const status = getDailyStatus(guildId, userId);
    if (!status.canClaim) return null;

    const row = db.prepare(`SELECT last_claim, streak FROM daily_claims WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
    const brokeStreak = row && (Date.now() - row.last_claim) > STREAK_GRACE_MS;
    const newStreak = (!row || brokeStreak) ? 1 : row.streak + 1;

    // مكافأة إضافية بسيطة كل ما طالت السلسلة (حد أقصى +50 نقطة إضافية عند سلسلة 10 أيام فأكثر)
    const streakBonus = Math.min(newStreak - 1, 10) * 5;
    const totalAmount = baseAmount + streakBonus;

    db.prepare(`
        INSERT INTO daily_claims (guild_id, user_id, last_claim, streak) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET last_claim = excluded.last_claim, streak = excluded.streak
    `).run(guildId, userId, Date.now(), newStreak);

    const newTotalPoints = addPoints(guildId, userId, totalAmount);

    return { amount: totalAmount, streak: newStreak, newTotalPoints };
}

// ================= [ نظام السجلات (Logs) — للأمان والمتابعة ] =================
// كل عملية حساسة (أوامر أدمن، تعديل مستويات، إنشاء/إنهاء جيف أواي، أخطاء) تنسجل هنا
// بشكل دائم بقاعدة البيانات، عشان تقدر تراجعها لاحقاً حتى لو البوت أعيد تشغيله.
function logEvent(guildId, category, actorId, action, details = null) {
    try {
        db.prepare(`
            INSERT INTO logs (guild_id, category, actor_id, action, details, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            guildId || null,
            category,
            actorId || null,
            action,
            details ? JSON.stringify(details) : null,
            Date.now()
        );
    } catch (e) {
        // ما نرمي خطأ لو فشل التسجيل — التسجيل مساعد، مو أساسي، وما نبي نوقف البوت بسببه
        console.error('❌ [Logs] فشل تسجيل الحدث:', e);
    }
}

function getLogs(guildId, category = null, limit = 50) {
    if (category) {
        return db.prepare(`
            SELECT * FROM logs WHERE guild_id = ? AND category = ? ORDER BY created_at DESC LIMIT ?
        `).all(guildId, category, limit);
    }
    return db.prepare(`
        SELECT * FROM logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(guildId, limit);
}

// تنظيف السجلات القديمة (أكثر من 90 يوم) عشان قاعدة البيانات ما تكبر بلا حدود
function pruneOldLogs(maxAgeMs = 90 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const result = db.prepare(`DELETE FROM logs WHERE created_at < ?`).run(cutoff);
    return result.changes;
}

// ================= [ دوال متجر الـ VIP ] =================
function hasVipTier(guildId, userId, tierKey) {
    const row = db.prepare(`
        SELECT 1 FROM vip_purchases WHERE guild_id = ? AND user_id = ? AND tier_key = ?
    `).get(guildId, userId, tierKey);
    return !!row;
}

function getVipPurchases(guildId, userId) {
    return db.prepare(`
        SELECT tier_key, purchased_at FROM vip_purchases WHERE guild_id = ? AND user_id = ?
    `).all(guildId, userId);
}

function recordVipPurchase(guildId, userId, tierKey) {
    db.prepare(`
        INSERT OR IGNORE INTO vip_purchases (guild_id, user_id, tier_key, purchased_at) VALUES (?, ?, ?, ?)
    `).run(guildId, userId, tierKey, Date.now());
}

module.exports = {
    db,
    getUserLevel,
    setUserLevel,
    getLeaderboard,
    getConfig,
    setLevelingChannel,
    setWelcomeChannel,
    setGoodbyeChannel,
    setShopChannel,
    setGameChannel,
    setStatsChannel,
    setSecurityFeature,
    getPoints,
    addPoints,
    getPointsLeaderboard,
    saveGiveaway,
    deleteGiveaway,
    getAllGiveaways,
    getGiveawaysByGuild,
    getDailyStatus,
    claimDaily,
    hasVipTier,
    getVipPurchases,
    recordVipPurchase,
    logEvent,
    getLogs,
    pruneOldLogs
};
