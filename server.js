const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./db.js');

const app = express();
const PORT = process.env.PORT || 3000;

const {
    DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET,
    DISCORD_CALLBACK_URL,
    SESSION_SECRET
} = process.env;

app.use(express.json());

// ================= إعداد الجلسات =================
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 أيام
}));

app.use(passport.initialize());
app.use(passport.session());

// ================= إعداد Passport =================
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: DISCORD_CALLBACK_URL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// ================= الملفات الثابتة =================
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: Date.now() });
});

// ================= مسارات تسجيل الدخول =================
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/dashboard');
    }
);

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// Middleware للتحقق من تسجيل الدخول
function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/auth/discord');
}

// ================= صفحة الداشبورد (ملف حقيقي) =================
app.get('/dashboard', ensureAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ================= API: بيانات المستخدم الحالي =================
app.get('/api/me', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ loggedIn: true, user: req.user });
    } else {
        res.json({ loggedIn: false });
    }
});

// ================= API: سيرفرات المستخدم اللي عنده صلاحية أدمن =================
app.get('/api/guilds', ensureAuth, (req, res) => {
    const ADMINISTRATOR = 0x8;
    const guilds = (req.user.guilds || []).filter(g => {
        const perms = BigInt(g.permissions);
        return (perms & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);
    });
    res.json({ guilds });
});

// ================= API: بيانات سيرفر معيّن =================
app.get('/api/guild/:guildId/data', ensureAuth, (req, res) => {
    const { guildId } = req.params;
    try {
        const leaderboard = db.getLeaderboard(guildId, 10);
        const pointsLeaderboard = db.getPointsLeaderboard(guildId, 10);
        const giveaways = db.getGiveawaysByGuild(guildId);
        const config = db.getConfig(guildId);
        const logs = db.getLogs(guildId, null, 50);

        // نجيب القنوات النصية الحقيقية من البوت نفسه عبر global.mmrClient
        // (المتغيّر هذا يتحدد بملف bot.js — راجع سطر global.mmrClient = client;)
        const guild = global.mmrClient?.guilds.cache.get(guildId);
        const textChannels = guild
            ? guild.channels.cache
                .filter(c => c.type === 0) // 0 = GuildText
                .map(c => ({ id: c.id, name: c.name }))
            : [];

        res.json({
            leaderboard,
            pointsLeaderboard,
            giveaways,
            config,
            logs,
            textChannels
        });
    } catch (e) {
        console.error('❌ [API] خطأ بجلب بيانات السيرفر:', e);
        res.status(500).json({ error: 'server_error' });
    }
});

// ================= API: حفظ قناة الترقيات =================
app.post('/api/guild/:guildId/leveling-channel', ensureAuth, (req, res) => {
    const { guildId } = req.params;
    const { channelId } = req.body;
    try {
        db.setLevelingChannel(guildId, channelId);
        db.logEvent(guildId, 'admin', req.user.id, `تم تغيير قناة الترقيات إلى ${channelId} عبر لوحة التحكم`);
        res.json({ success: true });
    } catch (e) {
        console.error('❌ [API] خطأ بحفظ قناة الترقيات:', e);
        res.status(500).json({ error: 'server_error' });
    }
});

app.listen(PORT, () => {
    console.log(`🌐 [Website] السيرفر شغال على المنفذ ${PORT}`);
});
