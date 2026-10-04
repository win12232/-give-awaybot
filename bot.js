require('./server.js');
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    InteractionType, 
    PermissionFlagsBits, 
    ChannelType, 
    PermissionsBitField,
    AttachmentBuilder 
} = require('discord.js');
const ms = require('ms');
const db = require('./db.js'); // طبقة قاعدة البيانات SQLite (بدل database.json و points.json)
const { generateWelcomeCard } = require('./welcomeCard.js'); // مولّد بطاقة الترحيب المصورة
const { VIP_TIERS, VIP_TIER_ORDER, getVipMultiplier } = require('./shop.js'); // متجر رتب VIP
const { BANNED_WORDS } = require('./badwords.js'); // قائمة فلتر السب

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers 
    ],
    // حماية عامة على مستوى البوت بالكامل: أي رسالة يرسلها البوت (حتى لو كتبها أدمن كـ
    // create-message أو dm-message أو sponsor-text) ما راح تقدر تعمل منشن @everyone أو @here
    // إطلاقاً. منشن الأعضاء والرولات (زي تهنئة الفائز أو رتبة الليفل) يضل شغال طبيعي.
    allowedMentions: { parse: ['users', 'roles'] }
});

// ================= [ التعديل الجديد: مشاركة الـ client مع الموقع (server.js) ] =================
// نستخدم global بدل require('./bot.js') من داخل server.js عشان نتفادى مشكلة
// الـ circular require (بما إن bot.js نفسه يستدعي server.js بأول سطر بالملف).
// هذا يسمح لأي مسار API بـ server.js يوصل لقنوات ورولات أي سيرفر مباشرة من ذاكرة البوت.
global.mmrClient = client;

const config = {
    token: process.env.TOKEN
};

// الجيف أواي تبقى بالذاكرة أثناء التشغيل عشان السرعة، لكن كل تغيير فيها ينحفظ فوراً
// بقاعدة SQLite عبر db.saveGiveaway، فما تضيع لو البوت تعطل أو انسوى redeploy.
const giveaways = new Map();

// ================= [ إعدادات مخصصة ] =================
const PREFIX = '!';
const activeGames = new Set(); // لمنع تداخل الجولات

// ================= [ نظام مكافحة السبام ] =================
// تتبع بالذاكرة (مو بقاعدة البيانات، لأنها بيانات مؤقتة وسريعة الزوال)
// كل مفتاح = guildId_userId، والقيمة = مصفوفة توقيتات آخر رسائله
const spamTracker = new Map();
const SPAM_MAX_MESSAGES = 5;      // أقصى عدد رسائل مسموح
const SPAM_WINDOW_MS = 4000;      // خلال هالمدة (٤ ثواني)
const SPAM_TIMEOUT_MS = 60 * 1000; // مدة الإسكات لو انضبط عضو يسبم (دقيقة وحدة)

// روابط دعوة ديسكورد (discord.gg/xxx أو discord.com/invite/xxx) — تستخدم بنظام Anti-Link
const DISCORD_INVITE_REGEX = /(discord\.gg|discord(app)?\.com\/invite)\/[a-zA-Z0-9-]+/i;

// دالة تنظيف النصوص الاحترافية للألعاب لتجاوز الأخطاء الإملائية للأعضاء (تدعم العربي والإنجليزي)
function normalizeText(text) {
    if (!text) return '';
    return text.trim()
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/\s+/g, ''); // إزالة المسافات لضمان الدقة
}

// دالة التحقق من إجابة العلم (تقبل العربي أو الإنجليزي)
function checkFlagAnswer(userAnswer, flagObject) {
    const normalizedUser = normalizeText(userAnswer);
    const normalizedArabic = normalizeText(flagObject.a);
    const normalizedEnglish = normalizeText(flagObject.en);
    return normalizedUser === normalizedArabic || normalizedUser === normalizedEnglish;
}

// دالة فحص فلتر السب — تتحقق لو النص يحتوي أي كلمة من BANNED_WORDS بعد التطبيع
// (يعني تتجاهل فروقات الأحرف والمسافات، نفس منطق التحقق من إجابات الألعاب)
function containsBannedWord(text) {
    if (!BANNED_WORDS.length) return false; // القائمة فاضية = الفلتر ما يسوي شي حتى لو مفعّل
    const normalized = normalizeText(text);
    return BANNED_WORDS.some(word => normalized.includes(normalizeText(word)));
}

// ================= [ بنك الأسئلة الضخم والمحدث ] =================
const QUESTIONS = [
    { q: "من هو أول الأنبياء؟", a: "آدم" },
    { q: "ما هي أطول سورة في القرآن الكريم؟", a: "البقرة" },
    { q: "من هو النبي الذي ابتلعه الحوت؟", a: "يونس" },
    { q: "كم عدد سور القرآن الكريم؟", a: "114" },
    { q: "في أي شهر نزل القرآن الكريم؟", a: "رمضان" },
    { q: "من هو خاتم الأنبياء والمرسلين؟", a: "محمد" },
    { q: "كم عدد الصلوات المفروضة في اليوم والليلة؟", a: "5" },
    { q: "ما هي السورة التي تعدل ثلث القرآن؟", a: "الاخلاص" },
    { q: "من هو الصحابي الملقب بالفاروق؟", a: "عمر بن الخطاب" },
    { q: "ما هي قبلة المسلمين الأولى؟", a: "المسجد الاقصى" },
    { q: "من هو النبي الذي صام عن الكلام ثلاثة أيام؟", a: "زكريا" },
    { q: "ما هي أعظم آية في القرآن الكريم؟", a: "آية الكرسي" },
    { q: "كم عدد أركان الإسلام؟", a: "5" },
    { q: "كم عدد أركان الإيمان؟", a: "6" },
    { q: "من هو النبي الملقب بكليم الله?", a: "موسى" },
    { q: "ما هي السورة التي تسمى عروس القرآن؟", a: "الرحمن" },
    { q: "من أول من أسلم من الرجال؟", a: "أبو بكر الصديق" },
    { q: "من أول من أسلم من الموالي؟", a: "زيد بن حارثة" },
    { q: "في أي مدينة توفي الرسول محمد صلى الله عليه وسلم؟", a: "المدينة المنورة" },
    { q: "ما هو اسم ناقة الرسول صلى الله عليه وسلم؟", a: "القصواء" },
    { q: "ما هي أقصر سورة في القرآن الكريم؟", a: "الكوثر" },
    { q: "من هو النبي الذي لُقب بذو النون؟", a: "يونس" },
    { q: "كم عدد أجزاء القرآن الكريم؟", a: "30" },
    { q: "ما هي السورة التي تبدأ بدون بسملة؟", a: "التوبة" },
    { q: "ما هي السورة التي تحتوي على بسملتين؟", a: "النمل" },
    { q: "من هو الصحابي الملقب بـ ذي النورين؟", a: "عثمان بن عفان" },
    { q: "من هو الصحابي الملقب بـ أسد الله؟", a: "حمزة بن عبد المطلب" },
    { q: "من هو النبي الذي بنى الكعبة المشرفة مع ابنه؟", a: "ابراهيم" },
    { q: "من هو النبي الذي لُقب بأبي الأنبياء؟", a: "ابراهيم" },
    { q: "ما هي المرضعة التي أرضعت الرسول محمد؟", a: "حليمة السعدية" },
    { q: "ما هي غزوة الفرقان؟", a: "غزوة بدر" },
    { q: "كم عدد التكبيرات في الركعة الأولى لصلاة العيد؟", a: "7" },
    { q: "من هي أولى زوجات الرسول محمد؟", a: "خديجة بنت خويلد" },
    { q: "ما هي سورة المنجية؟", a: "الملك" },
    { q: "من هو الغلام الذي نام في فراش الرسول يوم الهجرة؟", a: "علي بن ابي طالب" },
    { q: "ما اسم ملك الموت؟", a: "عزرائيل" },
    { q: "ما اسم خازن الجنة؟", a: "رضوان" },
    { q: "ما اسم خازن النار؟", a: "مالك" },
    { q: "كم عدد أولي العزم من الرسل؟", a: "5" },
    { q: "ما هي أكبر سورة مكنية في القرآن؟", a: "الشعراء" },
    { q: "من هو النبي الذي أحيا الموتى بإذن الله؟", a: "عيسى" },
    { q: "من هو النبي الذي جعل الله له الجبال تسبح معه؟", a: "داوود" },
    { q: "في أي مدينة ولد الرسول محمد؟", a: "مكة" },
    { q: "كم دام حفر خندق في غزوة الأحزاب؟", a: "6 ايام" },
    { q: "ما هي السورة التي فرضت فيها الصلاة؟", a: "الاسراء" },
    { q: "من هو الصحابي الذي اهتز لوفاته عرش الرحمن؟", a: "سعد بن معاذ" },
    { q: "من هو الصحابي الذي كان يسمى ترجمان القرآن؟", a: "عبدالله بن عباس" },
    { q: "ما هو الشيء المذكور في القرآن كشفاء للناس؟", a: "العسل" },
    { q: "من هو النبي الذي أُرسل إلى قوم عاد؟", a: "هود" },
    { q: "من هو النبي الذي أُرسل إلى قوم ثمود؟", a: "صالح" },

    // --- أسئلة عامة وثقافية ---
    { q: "ما عاصمة المملكة العربية السعودية؟", a: "الرياض" },
    { q: "ما هو أطول نهر في العالم؟", a: "النيل" },
    { q: "كم عدد قارات العالم؟", a: "7" },
    { q: "ما هو الكوكب الأقرب إلى الشمس؟", a: "عطارد" },
    { q: "ما هي عاصمة اليابان؟", a: "طوكيو" },
    { q: "ما هو أسرع حيوان بري في العالم؟", a: "الفهد" },
    { q: "في أي قارة تقع مصر؟", a: "افريقيا" },
    { q: "ما هو العنصر الكيميائي الذي رمزه O؟", a: "الاكسجين" },
    { q: "كم عدد ألوان قوس قزح؟", a: "7" },
    { q: "ما هي عاصمة فرنسا؟", a: "باريس" },
    { q: "ما هو أكبر المحيطات في العالم؟", a: "المحيط الهادئ" },
    { q: "ما هو الحيوان الملقب بسفينة الصحراء؟", a: "الجمل" },
    { q: "ما هو المعدن الأغلى في العالم؟", a: "الروديوم" },
    { q: "كم عدد الأسنان في فم الإنسان البالغ؟", a: "32" },
    { q: "ما هي عاصمة جمهورية مصر العربية؟", a: "القاهرة" },
    { q: "ما هو الطائر الذي يضع أكبر البيوض في العالم؟", a: "النعامة" },
    { q: "ما هو الكوكب الأزرق؟", a: "الارض" },
    { q: "ما هي أصغر دولة في العالم من حيث المساحة؟", a: "الفاتيكان" },
    { q: "في أي سنة اندلعت الحرب العالمية الأولى؟", a: "1914" },
    { q: "ما هو العضو المسؤول عن ضخ الدم في جسم الإنسان؟", a: "القلب" },
    { q: "ما هو أكبر بلد في العالم من حيث المساحة؟", a: "روسيا" },
    { q: "ما هي عاصمة إيطاليا؟", a: "روما" },
    { q: "ما هو الطائر الملقب بالهدهد؟", a: "الهدهد" },
    { q: "ما هو أكبر حيوان على وجه الأرض؟", a: "الحوت الازرق" },
    { q: "من هو مخترع المصباح الكهربائي؟", a: "توماس اديسون" },
    { q: "كم دقيقة في الساعة؟", a: "60" },
    { q: "ما هو لون دم حيوان الكركند (الاستاكوزا)؟", a: "ازرق" },
    { q: "ما هي عاصمة إسبانيا؟", a: "مدريد" },
    { q: "ما هو العنصر الأساسي المكون للماس؟", a: "الكربون" },
    { q: "كم عدد عظام جسم الإنسان البالغ؟", a: "206" },
    { q: "ما هي الدولة التي تشتهر ببرج إيفل؟", a: "فرنسا" },
    { q: "ما هو البحر الأكثر ملوحة في العالم؟", a: "البحر الميت" },
    { q: "كم يبلغ عدد لاعبي فريق كرة القدم في الملعب؟", a: "11" },
    { q: "ما هو العلم الذي يدرس طبقات الأرض؟", a: "الجيولوجيا" },
    { q: "ما هي عاصمة المملكة المتحدة (بريطانيا)؟", a: "لندن" },
    { q: "من الذي رسم لوحة الموناليزا؟", a: "ليوناردو دا فينشي" },
    { q: "ما هو الغاز الذي يتنفسه الإنسان؟", a: "الاكسجين" },
    { q: "ما هو الكوكب الأحمر؟", a: "المريخ" },
    { q: "ما هو الحيوان الذى يموت إذا فتحت فمه بقوة؟", a: "الضفدع" },
    { q: "ما هي عاصمة الإمارات العربية المتحدة؟", a: "ابوظبي" },
    { q: "كم عدد قلوب الأخطبوط؟", a: "3" },
    { q: "ما هو الحيوان الزاحف الذي يغير لونه؟", a: "الحرباء" },
    { q: "ما هي العملة الرسمية للولايات المتحدة الأمريكية؟", a: "الدولار" },
    { q: "ما هي الدولة الأكثر سكاناً في العالم؟", a: "الهند" },
    { q: "ما هو أطول مجمع سكني أو مبنى في العالم حالياً؟", a: "برج خليفة" },
    { q: "من هو مكتشف الجاذبية الأرضية؟", a: "إسحاق نيوتن" },
    { q: "ما هي عاصمة تركيا؟", a: "انقرة" },
    { q: "ما هو غاز المشهور بغاز الضحك؟", a: "أكسيد النيتروز" },
    { q: "كم عدد خطوط الطول الوهمية على الكرة الأرضية؟", a: "360" },
    { q: "ما هو الشيء الذي يتحدث جميع اللغات وليس له لسان؟", a: "الصدى" }
];

let dynamicQuestionsPool = [...QUESTIONS];

function getRandomQuestion() {
    if (dynamicQuestionsPool.length === 0) {
        dynamicQuestionsPool = [...QUESTIONS];
        console.log("🔄 [System] تم إعادة شحن بنك الأسئلة بالكامل!");
    }
    const randomIndex = Math.floor(Math.random() * dynamicQuestionsPool.length);
    const selectedQuestion = dynamicQuestionsPool.splice(randomIndex, 1)[0];
    return selectedQuestion;
}

// بنك الأعلام الضخم مع دعم اللغتين (عربي + إنجليزي)
const FLAGS = [
    { image: "https://flagcdn.com/w640/sa.png", a: "السعودية", en: "saudi arabia" },
    { image: "https://flagcdn.com/w640/ae.png", a: "الامارات", en: "uae" },
    { image: "https://flagcdn.com/w640/qa.png", a: "قطر", en: "qatar" },
    { image: "https://flagcdn.com/w640/kw.png", a: "الكويت", en: "kuwait" },
    { image: "https://flagcdn.com/w640/om.png", a: "عمان", en: "oman" },
    { image: "https://flagcdn.com/w640/bh.png", a: "البحرين", en: "bahrain" },
    { image: "https://flagcdn.com/w640/eg.png", a: "مصر", en: "egypt" },
    { image: "https://flagcdn.com/w640/dz.png", a: "الجزائر", en: "algeria" },
    { image: "https://flagcdn.com/w640/ma.png", a: "المغرب", en: "morocco" },
    { image: "https://flagcdn.com/w640/iq.png", a: "العراق", en: "iraq" },
    { image: "https://flagcdn.com/w640/jo.png", a: "الاردن", en: "jordan" },
    { image: "https://flagcdn.com/w640/sy.png", a: "سوريا", en: "syria" },
    { image: "https://flagcdn.com/w640/lb.png", a: "لبنان", en: "lebanon" },
    { image: "https://flagcdn.com/w640/ye.png", a: "اليمن", en: "yemen" },
    { image: "https://flagcdn.com/w640/ps.png", a: "فلسطين", en: "palestine" },
    { image: "https://flagcdn.com/w640/tn.png", a: "تونس", en: "tunisia" },
    { image: "https://flagcdn.com/w640/sd.png", a: "السودان", en: "sudan" },
    { image: "https://flagcdn.com/w640/ly.png", a: "ليبيا", en: "libya" },
    { image: "https://flagcdn.com/w640/so.png", a: "الصومال", en: "somalia" },
    { image: "https://flagcdn.com/w640/dj.png", a: "جيبوتي", en: "djibouti" },
    { image: "https://flagcdn.com/w640/us.png", a: "امريكا", en: "usa" },
    { image: "https://flagcdn.com/w640/gb.png", a: "بريطانيا", en: "uk" },
    { image: "https://flagcdn.com/w640/fr.png", a: "فرنسا", en: "france" },
    { image: "https://flagcdn.com/w640/de.png", a: "المانيا", en: "germany" },
    { image: "https://flagcdn.com/w640/it.png", a: "ايطاليا", en: "italy" },
    { image: "https://flagcdn.com/w640/es.png", a: "اسبانيا", en: "spain" },
    { image: "https://flagcdn.com/w640/br.png", a: "البرازيل", en: "brazil" },
    { image: "https://flagcdn.com/w640/ar.png", a: "الارجنتين", en: "argentina" },
    { image: "https://flagcdn.com/w640/jp.png", a: "اليابان", en: "japan" },
    { image: "https://flagcdn.com/w640/kr.png", a: "كوريا الجنوبية", en: "south korea" },
    { image: "https://flagcdn.com/w640/cn.png", a: "الصين", en: "china" },
    { image: "https://flagcdn.com/w640/ru.png", a: "روسيا", en: "russia" },
    { image: "https://flagcdn.com/w640/ca.png", a: "كندا", en: "canada" },
    { image: "https://flagcdn.com/w640/au.png", a: "استراليا", en: "australia" },
    { image: "https://flagcdn.com/w640/tr.png", a: "تركيا", en: "turkey" },
    { image: "https://flagcdn.com/w640/in.png", a: "الهند", en: "india" },
    { image: "https://flagcdn.com/w640/mx.png", a: "المكسيك", en: "mexico" },
    { image: "https://flagcdn.com/w640/pt.png", a: "البرتغال", en: "portugal" },
    { image: "https://flagcdn.com/w640/nl.png", a: "هولندا", en: "netherlands" },
    { image: "https://flagcdn.com/w640/ch.png", a: "سويسرا", en: "switzerland" },
    { image: "https://flagcdn.com/w640/za.png", a: "جنوب افريقيا", en: "south africa" },
    { image: "https://flagcdn.com/w640/se.png", a: "السويد", en: "sweden" },
    { image: "https://flagcdn.com/w640/no.png", a: "النرويج", en: "norway" },
    { image: "https://flagcdn.com/w640/fi.png", a: "فنلندا", en: "finland" },
    { image: "https://flagcdn.com/w640/dk.png", a: "الدنمارك", en: "denmark" },
    { image: "https://flagcdn.com/w640/be.png", a: "بلجيكا", en: "belgium" },
    { image: "https://flagcdn.com/w640/at.png", a: "النمسا", en: "austria" },
    { image: "https://flagcdn.com/w640/gr.png", a: "اليونان", en: "greece" },
    { image: "https://flagcdn.com/w640/ua.png", a: "اوكرانيا", en: "ukraine" },
    { image: "https://flagcdn.com/w640/pl.png", a: "بولندا", en: "poland" },
    { image: "https://flagcdn.com/w640/nz.png", a: "نيوزيلندا", en: "new zealand" },
    { image: "https://flagcdn.com/w640/sg.png", a: "سنغافورة", en: "singapore" },
    { image: "https://flagcdn.com/w640/my.png", a: "ماليزيا", en: "malaysia" },
    { image: "https://flagcdn.com/w640/th.png", a: "تايلاند", en: "thailand" },
    { image: "https://flagcdn.com/w640/id.png", a: "اندونيسيا", en: "indonesia" },
    { image: "https://flagcdn.com/w640/pk.png", a: "باكستان", en: "pakistan" },
    { image: "https://flagcdn.com/w640/ir.png", a: "ايران", en: "iran" },
    { image: "https://flagcdn.com/w640/ng.png", a: "نيجيريا", en: "nigeria" },
    { image: "https://flagcdn.com/w640/gh.png", a: "غانا", en: "ghana" },
    { image: "https://flagcdn.com/w640/ke.png", a: "كينيا", en: "kenya" },
    { image: "https://flagcdn.com/w640/cu.png", a: "كوبا", en: "cuba" },
    { image: "https://flagcdn.com/w640/jm.png", a: "جامايكا", en: "jamaica" }
];

let dynamicFlagsPool = [...FLAGS];

function getRandomFlag() {
    if (dynamicFlagsPool.length === 0) {
        dynamicFlagsPool = [...FLAGS];
        console.log("🔄 [System] تم إعادة شحن بنك الأعلام بالكامل!");
    }
    const randomIndex = Math.floor(Math.random() * dynamicFlagsPool.length);
    const selectedFlag = dynamicFlagsPool.splice(randomIndex, 1)[0];
    return selectedFlag;
}

// ================= [ بنك كلمات لعبة "امزح الكلمة" ] =================
const WORDS = [
    "سيارة", "طائرة", "مدرسة", "كتاب", "شمس", "قمر", "بحر", "جبل", "نهر", "شجرة",
    "حاسوب", "هاتف", "ساعة", "مفتاح", "باب", "نافذة", "طاولة", "كرسي", "مطبخ", "حديقة",
    "قهوة", "شاي", "خبز", "تفاح", "برتقال", "موز", "عصير", "حليب", "سكر", "ملح",
    "رياضة", "كرة", "سباحة", "جري", "طبخ", "سفر", "فندق", "مطار", "قطار", "دراجة",
    "صديق", "عائلة", "معلم", "طالب", "طبيب", "مهندس", "شرطي", "طيار", "فنان", "كاتب"
];

function shuffleWord(word) {
    let letters = word.split('');
    let shuffled;
    do {
        for (let i = letters.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [letters[i], letters[j]] = [letters[j], letters[i]];
        }
        shuffled = letters.join('');
    } while (shuffled === word && word.length > 1);
    return shuffled;
}

function getRandomWord() {
    return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function getRequiredXP(level) {
    if (level <= 10) {
        return 5 * (level ** 2) + 50 * level + 100;
    } else {
        let baseXP = 5 * (10 ** 2) + 50 * 10 + 100; 
        let extraLevels = level - 10;
        return Math.floor(baseXP + (extraLevels ** 2.5) * 150);
    }
}

async function addXP(userId, guild, amount, channelToSendLevelUp) {
    let userData = db.getUserLevel(guild.id, userId);
    let xp = userData.xp + amount;
    let level = userData.level;
    let xpNeededForNextLevel = getRequiredXP(level);

    while (xp >= xpNeededForNextLevel) {
        xp -= xpNeededForNextLevel;
        level += 1;
        xpNeededForNextLevel = getRequiredXP(level);

        if (level <= 100) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) {
                const roleName = `ⲯ︰︲𐑖#${level}︲lvl`;
                try {
                    const oldLevelRoles = member.roles.cache.filter(r => r.name.startsWith('ⲯ︰︲𐑖#') && r.name.endsWith('︲lvl'));
                    if (oldLevelRoles.size > 0) {
                        await member.roles.remove(oldLevelRoles).catch(() => null);
                    }

                    let levelRole = guild.roles.cache.find(r => r.name === roleName);
                    if (!levelRole) {
                        levelRole = await guild.roles.create({
                            name: roleName,
                            color: '#2b2d31', 
                            reason: `MMR Persistent Level Auto Reward System`
                        }).catch(() => null);
                    }

                    if (levelRole) {
                        await member.roles.add(levelRole).catch(() => null);
                    }
                } catch (err) {
                    console.error("Role assignment error:", err);
                }
            }
        }

        const user = client.users.cache.get(userId);
        if (user && channelToSendLevelUp) {
            const userAvatar = user.displayAvatarURL({ dynamic: true, size: 512 });
            const levelUpEmbed = new EmbedBuilder()
                .setTitle('✨ **MMR Leveling System** ✨')
                .setDescription(`🎉 كفوو <@${userId}>! لقد ارتفع مستواك في السيرفر إلى **المستوى ${level}**!\n📈 زادت فرص فوزك وتم منحك رتبتك الخاصة تلقائياً! 🚀`)
                .setThumbnail(userAvatar) 
                .setColor('#2b2d31')
                .setFooter({ text: 'MMR System • Keep chatting!', iconURL: userAvatar });

            await channelToSendLevelUp.send({ embeds: [levelUpEmbed] }).catch(() => null);
        }
    }

    db.setUserLevel(guild.id, userId, xp, level);
}

async function autoSetupGameChannels(guild) {
    try {
        let category = guild.channels.cache.find(c => c.name === '🏆- MMR GAMES' && c.type === ChannelType.GuildCategory);
        if (!category) {
            category = await guild.channels.create({
                name: '🏆- MMR GAMES',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionsBitField.Flags.SendMessages]
                    }
                ]
            });
        }

        let gameChannel = guild.channels.cache.find(c => c.name === '🎮-العاب-ومسابقات' && c.type === ChannelType.GuildText);
        if (!gameChannel) {
            gameChannel = await guild.channels.create({
                name: '🎮-العاب-ومسابقات',
                type: ChannelType.GuildText,
                parent: category.id,
                topic: 'قناة مخصصة للفعاليات والمسابقات التلقائية من بوت MMR 🎮'
            });
        }

        let statsChannel = guild.channels.cache.find(c => c.name === '🏆-متصدرين-النقاط' && c.type === ChannelType.GuildText);
        if (!statsChannel) {
            statsChannel = await guild.channels.create({
                name: '🏆-متصدرين-النقاط',
                type: ChannelType.GuildText,
                parent: category.id,
                topic: 'قناة صدارة النقاط لفعاليات السيرفر 🏆',
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone.id,
                        deny: [PermissionsBitField.Flags.SendMessages]
                    }
                ]
            });
        }

        return { gameChannel, statsChannel };
    } catch (e) {
        console.error("Error setting up game channels:", e);
        return null;
    }
}

function persistGiveaway(giveawayData) {
    const { entries, messageId, channelId, ended, endTime, ...rest } = giveawayData;
    db.saveGiveaway(
        messageId,
        giveawayData.guildId,
        channelId,
        rest,
        Array.from(entries),
        ended,
        endTime
    );
}

// ================= [ متجر رتب VIP: دوال مساعدة ] =================

// ينشئ رتب الـ VIP الأربعة بالسيرفر لو ما كانت موجودة مسبقاً (نفس أسلوب رتب الليفل)
async function ensureVipRoles(guild) {
    const roles = {};
    for (const tierKey of VIP_TIER_ORDER) {
        const tier = VIP_TIERS[tierKey];
        let role = guild.roles.cache.find(r => r.name === tier.roleName);
        if (!role) {
            role = await guild.roles.create({
                name: tier.roleName,
                color: tier.color,
                hoist: true, // يظهر العضو تحت قسم منفصل بقائمة الأعضاء — فخامة إضافية تليق بالسعر
                reason: 'MMR VIP Shop — إنشاء رتبة تلقائي'
            }).catch(() => null);
        }
        roles[tierKey] = role;
    }
    return roles;
}

// يبني رسالة لوحة المتجر (embed + أزرار الشراء لكل رتبة)
function buildShopPanel() {
    const embed = new EmbedBuilder()
        .setTitle('💎 متجر رتب VIP')
        .setDescription('استثمر نقاطك المكتسبة من الألعاب والمكافأة اليومية بترقية دائمة — كل رتبة تشمل مزايا الرتب اللي تحتها.')
        .setColor('#E4B343')
        .setFooter({ text: 'MMR Shop • الأسعار ثابتة والشراء نهائي' });

    for (const tierKey of VIP_TIER_ORDER) {
        const tier = VIP_TIERS[tierKey];
        embed.addFields({
            name: `${tier.emoji} ${tier.name} — ${tier.price.toLocaleString('en-US')} نقطة`,
            value: tier.perks.map(p => `• ${p}`).join('\n'),
            inline: false
        });
    }

    const row = new ActionRowBuilder().addComponents(
        VIP_TIER_ORDER.map(tierKey => {
            const tier = VIP_TIERS[tierKey];
            return new ButtonBuilder()
                .setCustomId(`shopbuy_${tierKey}`)
                .setLabel(`${tier.name} — ${tier.price.toLocaleString('en-US')}`)
                .setEmoji(tier.emoji)
                .setStyle(ButtonStyle.Secondary);
        })
    );

    return { embeds: [embed], components: [row] };
}

client.once('ready', async () => {
    console.log(`👑 MMR Giveaway & Leveling Bot is online as: ${client.user.tag}`);

    // ملاحظة: ما نسوي إنشاء تلقائي للقنوات بعد — الأدمن يحدد كل قناة بنفسه
    // عبر /setgamechannel, /setstatschannel, /setwelcomechannel, /setgoodbyechannel, /setshopchannel

    const storedGiveaways = db.getAllGiveaways();
    for (const g of storedGiveaways) {
        const giveawayData = { ...g, entries: new Set(g.entries) };
        giveaways.set(g.messageId, giveawayData);

        if (giveawayData.ended) continue;

        const remaining = giveawayData.endTime - Date.now();

        if (remaining <= 0) {
            endGiveaway(g.messageId, giveawayData.channelId).catch(err => console.error("Error auto-ending giveaway:", err));
        } else {
            setTimeout(() => endGiveaway(g.messageId, giveawayData.channelId), remaining);
            console.log(`⏳ [Giveaway] تم استئناف جيف أواي (${giveawayData.prize}) - الوقت المتبقي: ${Math.ceil(remaining / 1000)} ثانية.`);
        }
    }

    const command = new SlashCommandBuilder()
        .setName('gcreate')
        .setDescription('Create a professional giveaway')
        .addStringOption(opt => opt.setName('prize').setDescription('The prize to win').setRequired(true))
        .addStringOption(opt => opt.setName('duration').setDescription('Giveaway duration (e.g., 10m, 2h, 1d)').setRequired(true))
        .addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners').setRequired(true))
        .addStringOption(opt => opt.setName('platform').setDescription('Select Gaming Platform').setRequired(false)
            .addChoices(
                { name: '💻 PC', value: 'pc' },
                { name: '🤖 Android', value: 'android' },
                { name: '📱 iPhone', value: 'iphone' }
            ))
        .addChannelOption(opt => opt.setName('channel').setDescription('Target channel for the giveaway').setRequired(false))
        .addUserOption(opt => opt.setName('host').setDescription('Giveaway host').setRequired(false))
        .addAttachmentOption(opt => opt.setName('image').setDescription('Upload bottom banner image').setRequired(false))
        .addAttachmentOption(opt => opt.setName('thumbnail').setDescription('Upload top-right thumbnail image').setRequired(false))
        .addStringOption(opt => opt.setName('color').setDescription('Embed Hex color at start (e.g., #2b2d31)').setRequired(false))
        .addStringOption(opt => opt.setName('end-color').setDescription('Embed Hex color at end (e.g., #248046)').setRequired(false))
        .addStringOption(opt => opt.setName('giveaway-create-message').setDescription('Text message sent with the embed').setRequired(false))
        .addStringOption(opt => opt.setName('giveaway-winners-dm-message').setDescription('Custom DM message for the winner').setRequired(false))
        .addRoleOption(opt => opt.setName('required-role').setDescription('Required role to join').setRequired(false))
        .addRoleOption(opt => opt.setName('requirement-bypass-role').setDescription('Bypass role').setRequired(false))
        .addRoleOption(opt => opt.setName('giveaway-winners-role').setDescription('Role given automatically to the winner').setRequired(false))
        .addStringOption(opt => opt.setName('required-account-age').setDescription('Minimum account age (e.g., 7d, 30d)').setRequired(false))
        .addIntegerOption(opt => opt.setName('booster-multiplier').setDescription('Booster entries multiplier').setRequired(false))
        .addStringOption(opt => opt.setName('required-server-id').setDescription('Partner Server ID to join').setRequired(false))
        .addStringOption(opt => opt.setName('sponsor-text').setDescription('Custom message or link for sponsor').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const adminCommand = new SlashCommandBuilder()
        .setName('gadmin')
        .setDescription('Giveaway admin control panel')
        .addStringOption(opt => opt.setName('message_id').setDescription('Giveaway Message ID').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const addFakeCommand = new SlashCommandBuilder()
        .setName('gaddfake')
        .setDescription('Add fake entries to a giveaway')
        .addStringOption(opt => opt.setName('message_id').setDescription('Giveaway Message ID').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount of fake users to add').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const statsCommand = new SlashCommandBuilder()
        .setName('gstats')
        .setDescription('Show Live System Statistics')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const rankCommand = new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Show your current MMR Level and XP')
        .addUserOption(opt => opt.setName('user').setDescription('Select a user to check their rank').setRequired(false));

    const setChannelCommand = new SlashCommandBuilder()
        .setName('setchannel')
        .setDescription('تحديد قناة نظام الليفلات وإرسال رسائل الترقية')
        .addChannelOption(opt => opt.setName('channel').setDescription('القناة المراد تفعيل الليفلات بها').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const setLevelCommand = new SlashCommandBuilder()
        .setName('setlevel')
        .setDescription('تعديل لفل عضو محدد بشكل يدوي وإعطائه أي مستوى')
        .addUserOption(opt => opt.setName('user').setDescription('العضو المراد تعديل مستواه').setRequired(true))
        .addIntegerOption(opt => opt.setName('level').setDescription('المستوى الجديد (مثال: 100)').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const dailyCommand = new SlashCommandBuilder()
        .setName('يومي')
        .setDescription('استلم مكافأتك اليومية من النقاط (تزيد كل ما حافظت على سلسلة الأيام)');

    const setWelcomeChannelCommand = new SlashCommandBuilder()
        .setName('setwelcomechannel')
        .setDescription('تحديد قناة الترحيب بالأعضاء الجدد')
        .addChannelOption(opt => opt.setName('channel').setDescription('القناة المراد إرسال رسائل الترحيب فيها').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const setGoodbyeChannelCommand = new SlashCommandBuilder()
        .setName('setgoodbyechannel')
        .setDescription('تحديد قناة رسائل الوداع بالأعضاء المغادرين')
        .addChannelOption(opt => opt.setName('channel').setDescription('القناة المراد إرسال رسائل الوداع فيها').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const setShopChannelCommand = new SlashCommandBuilder()
        .setName('setshopchannel')
        .setDescription('تحديد قناة متجر رتب VIP')
        .addChannelOption(opt => opt.setName('channel').setDescription('القناة المراد عرض المتجر فيها').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const setGameChannelCommand = new SlashCommandBuilder()
        .setName('setgamechannel')
        .setDescription('تحديد قناة الألعاب والمسابقات (!مسابقة، !علم، !رقم، !كلمة)')
        .addChannelOption(opt => opt.setName('channel').setDescription('القناة المراد تشغيل الألعاب فيها').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const setStatsChannelCommand = new SlashCommandBuilder()
        .setName('setstatschannel')
        .setDescription('تحديد قناة عرض لوحة صدارة النقاط (!توب)')
        .addChannelOption(opt => opt.setName('channel').setDescription('القناة المراد عرض الصدارة فيها').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const setupShopCommand = new SlashCommandBuilder()
        .setName('setupshop')
        .setDescription('ينشر (أو يحدّث) لوحة متجر VIP بالقناة المحددة مسبقاً بـ /setshopchannel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    const securityCommand = new SlashCommandBuilder()
        .setName('security')
        .setDescription('تفعيل أو تعطيل أنظمة الحماية والترحيب/الوداع')
        .addStringOption(opt => opt.setName('feature').setDescription('النظام المراد التحكم فيه').setRequired(true)
            .addChoices(
                { name: 'مكافحة السبام', value: 'antispam' },
                { name: 'حظر روابط الدعوة', value: 'antilink' },
                { name: 'فلتر السب', value: 'profanity_filter' },
                { name: 'رسائل الترحيب', value: 'welcome' },
                { name: 'رسائل الوداع', value: 'goodbye' }
            ))
        .addBooleanOption(opt => opt.setName('enabled').setDescription('تفعيل أو تعطيل').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    try {
        await client.application.commands.set([
            command, adminCommand, addFakeCommand, statsCommand, 
            rankCommand, setChannelCommand, setLevelCommand, dailyCommand,
            setWelcomeChannelCommand, setGoodbyeChannelCommand, setShopChannelCommand,
            setGameChannelCommand, setStatsChannelCommand,
            setupShopCommand, securityCommand
        ]);
        console.log('🚀 MMR System initialized with Dynamic Configuration Commands.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
});

function validateColor(colorStr, defaultColor = '#2b2d31') {
    if (!colorStr) return defaultColor;
    return colorStr.startsWith('#') && colorStr.length === 7 ? colorStr : defaultColor;
}

function createGiveawayEmbed(data) {
    const endTimeInSeconds = Math.floor(data.endTime / 1000);
    const hostUser = client.users.cache.get(data.hostId) || `<@${data.hostId}>`;
    const totalCount = data.entries.size + (data.fakeCount || 0);

    let platformEmoji = '';
    if (data.platform === 'pc') platformEmoji = '💻 ';
    if (data.platform === 'android') platformEmoji = '🤖 ';
    if (data.platform === 'iphone') platformEmoji = '📱 ';

    let description = `Click the 🎉 button below to participate!\n\n` +
                      `👥 **Winners:** \`${data.winnerCount}\`\n` +
                      `👤 **Hosted by:** ${hostUser}\n` +
                      `✨ **Total Participants:** \`${totalCount}\`\n` +
                      `⏳ **Ends:** <t:${endTimeInSeconds}:R> (<t:${endTimeInSeconds}:f>)\n` +
                      `⭐ **Level Boost:** Active! Higher levels get higher winning chances! 📈\n`;

    if (data.requiredRoleId) description += `\n🔒 **Required Role:** <@&${data.requiredRoleId}>`;
    if (data.bypassRoleId) description += `\n⚡ **Bypass Role:** <@&${data.bypassRoleId}>`;
    if (data.accountAgeStr) description += `\n📅 **Min Account Age:** \`${data.accountAgeStr}\``;
    if (data.requiredServerId) description += `\n🤝 **Required Server ID:** \`${data.requiredServerId}\``;
    if (data.boosterMultiplier > 1) description += `\n🚀 **Booster Benefit:** Server boosters get additional **${data.boosterMultiplier}x** entries!`;

    const embed = new EmbedBuilder()
        .setTitle(`🎉 **${platformEmoji}GIVEAWAY: ${data.prize}** 🎉`)
        .setDescription(description)
        .setColor(validateColor(data.color))
        .setFooter({ text: `MMR Giveaway • ID: ${data.messageId}` });

    if (data.imageUrl) embed.setImage(data.imageUrl);
    if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl);

    const buttonsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`giveaway_entry_${data.messageId}`)
            .setEmoji('🎉')
            .setLabel(`${totalCount}`)
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`giveaway_leave_${data.messageId}`)
            .setEmoji('🗑️')
            .setLabel('Leave')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`giveaway_list_${data.messageId}_0`)
            .setEmoji('👥')
            .setLabel('Participants')
            .setStyle(ButtonStyle.Secondary)
    );

    if (data.sponsorText) {
        buttonsRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`giveaway_sponsor_${data.messageId}`)
                .setEmoji('🤝')
                .setLabel('Sponsor')
                .setStyle(ButtonStyle.Success)
        );
    }

    return { embeds: [embed], components: [buttonsRow] };
}

async function renderParticipantsText(interaction, giveawayData, page = 0) {
    const guild = interaction.guild;
    const entriesArray = Array.from(giveawayData.entries);
    const totalParticipants = entriesArray.length + giveawayData.fakeCount;
    
    const itemsPerPage = 10;
    const maxPages = Math.max(1, Math.ceil(totalParticipants / itemsPerPage));
    const currentPage = Math.min(Math.max(0, page), maxPages - 1);
    const startIdx = currentPage * itemsPerPage;

    let targetEntries = entriesArray.slice(startIdx, startIdx + itemsPerPage);
    let fetchedMembers = new Map();

    if (targetEntries.length > 0) {
        try {
            const fetchedCollection = await guild.members.fetch({ user: targetEntries });
            fetchedMembers = fetchedCollection;
        } catch (e) {
            targetEntries.forEach(id => {
                const cached = guild.members.cache.get(id);
                if (cached) fetchedMembers.set(id, cached);
            });
        }
    }

    let resolvedList = [];
    targetEntries.forEach((memberId) => {
        const member = fetchedMembers.get(memberId);
        
        const userLevelData = db.getUserLevel(guild.id, memberId);
        let tickets = 1 + userLevelData.level;

        if (member && member.premiumSince && giveawayData.boosterMultiplier > 1) {
            tickets = tickets * giveawayData.boosterMultiplier;
        }
        resolvedList.push({ mention: `<@${memberId}>`, entries: tickets, lvl: userLevelData.level });
    });

    const currentFakeStartIndex = Math.max(0, startIdx - entriesArray.length);
    const neededFakeCount = Math.min(itemsPerPage - resolvedList.length, Math.max(0, giveawayData.fakeCount - currentFakeStartIndex));

    for (let i = 0; i < neededFakeCount; i++) {
        const fakeId = currentFakeStartIndex + i + 1;
        resolvedList.push({ mention: `@FakeUser_${fakeId}`, entries: 1, lvl: 0 });
    }

    let plainText = `These are the members that have participated in the giveaway of **${giveawayData.prize}**:\n\n`;
    
    resolvedList.forEach((item, index) => {
        plainText += `${startIdx + index + 1}. ${item.mention} - Level: \`${item.lvl}\` (**${item.entries}** entries total)\n`;
    });

    if (resolvedList.length === 0) {
        plainText += `No entries found on this page.\n`;
    }

    plainText += `\nTotal Participants: **${totalParticipants}**`;

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`gpage_prev_${giveawayData.messageId}_${currentPage}`)
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 0),
        new ButtonBuilder()
            .setCustomId(`gpage_goto_${giveawayData.messageId}_${currentPage}`)
            .setLabel('Go To Page')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`gpage_next_${giveawayData.messageId}_${currentPage}`)
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage >= maxPages - 1)
    );

    return { content: plainText, components: [navRow], ephemeral: true };
}

async function endGiveaway(messageId, channelId) {
    const giveawayData = giveaways.get(messageId);
    if (!giveawayData || giveawayData.ended) return;

    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    let message;
    try { message = await channel.messages.fetch(messageId); } catch (e) { giveaways.delete(messageId); db.deleteGiveaway(messageId); return; }

    giveawayData.ended = true;
    persistGiveaway(giveawayData);
    
    let lotteryPool = [];
    const entriesArray = Array.from(giveawayData.entries);
    let fetchedMembers = new Map();

    if (entriesArray.length > 0) {
        try {
            fetchedMembers = await message.guild.members.fetch({ user: entriesArray });
        } catch (e) {
            entriesArray.forEach(id => {
                const cached = message.guild.members.cache.get(id);
                if (cached) fetchedMembers.set(id, cached);
            });
        }
    }

    for (const memberId of giveawayData.entries) {
        const member = fetchedMembers.get(memberId);
        const userLevelData = db.getUserLevel(message.guild.id, memberId);
        let tickets = 1 + userLevelData.level; 

        if (member && member.premiumSince && giveawayData.boosterMultiplier > 1) {
            tickets = tickets * giveawayData.boosterMultiplier;
        }

        for (let i = 0; i < tickets; i++) {
            lotteryPool.push(memberId);
        }
    }

    let finalWinners = [];

    if (giveawayData.forcedWinnerId) {
        finalWinners.push(giveawayData.forcedWinnerId);
    } else if (lotteryPool.length > 0) {
        const shuffled = lotteryPool.sort(() => 0.5 - Math.random());
        for (const candidateId of shuffled) {
            if (finalWinners.length >= giveawayData.winnerCount) break;
            if (!finalWinners.includes(candidateId)) {
                finalWinners.push(candidateId);
            }
        }
    }

    if (finalWinners.length > 0) {
        const winnerMentions = finalWinners.map(id => `<@${id}>`).join(', ');
        const hostUser = client.users.cache.get(giveawayData.hostId) || `<@${giveawayData.hostId}>`;

        const endEmbed = new EmbedBuilder()
            .setTitle(`🏁 **GIVEAWAY CONCLUDED** 🏁`)
            .setDescription(`🏆 **Prize:** \`${giveawayData.prize}\`\n\n👑 **Lucky Winners:**\n${winnerMentions}\n\n👤 **Hosted by:** ${hostUser}`)
            .setColor(validateColor(giveawayData.endColor, '#1a1a1a'))
            .setFooter({ text: `MMR Giveaway • Congratulations` });

        if (giveawayData.imageUrl) endEmbed.setImage(giveawayData.imageUrl);
        if (giveawayData.thumbnailUrl) endEmbed.setThumbnail(giveawayData.thumbnailUrl);

        const postRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gadmin_reroll_${messageId}`).setLabel('Reroll').setStyle(ButtonStyle.Success).setEmoji('🔄'),
            new ButtonBuilder().setCustomId(`gadmin_cancel_${messageId}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
        );

        await message.edit({ embeds: [endEmbed], components: [postRow] });

        const congratulationText = `🎉 Congratulations ${winnerMentions}, you have officially won **${giveawayData.prize}**!\n🛡️ *Verified and secured by MMR Giveaway.*`;
        await channel.send({ content: congratulationText });

        finalWinners.forEach(async (winnerId) => {
            const member = fetchedMembers.get(winnerId) || await message.guild.members.fetch(winnerId).catch(() => null);
            if (member) {
                if (giveawayData.winnerRoleId) await member.roles.add(giveawayData.winnerRoleId).catch(() => null);
                if (giveawayData.dmMessage) {
                    let formattedDm = giveawayData.dmMessage.replace(/{winner}/g, `<@${winnerId}>`).replace(/{prize}/g, giveawayData.prize);
                    await member.send({ content: formattedDm }).catch(() => null);
                } else {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle(`👑 **YOU WON WITH MMR GIVEAWAY!** 👑`)
                        .setDescription(`🎉 **Congratulations!**\nYou have won **${giveawayData.prize}** in our verified server giveaway!\n🛡️ *MMR Giveaway Verification Complete.*`)
                        .setColor('#1a1a1a')
                        .setFooter({ text: `MMR Giveaway` });
                    await member.send({ embeds: [dmEmbed] }).catch(() => null);
                }
            }
        });
    } else {
        const noWinnersEmbed = new EmbedBuilder().setTitle(`🏁 **Giveaway Ended** 🏁`).setDescription(`🎁 **Prize:** \`${giveawayData.prize}\`\n❌ **Result:** No valid participant joined the giveaway.`).setColor('#ED4245').setFooter({ text: `MMR Giveaway` });
        await message.edit({ embeds: [noWinnersEmbed], components: [] });
    }
}

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    // ================= [ فحوصات الحماية (تشتغل قبل أي شي ثاني) ] =================
    const securityCfg = db.getConfig(message.guild.id);

    // --- فلتر السب ---
    if (securityCfg.profanity_filter_enabled && containsBannedWord(message.content)) {
        await message.delete().catch(() => null);
        const warnMsg = await message.channel.send(`⚠️ ${message.author}، رجاءً التزم بآداب الحوار بالسيرفر.`).catch(() => null);
        if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => null), 5000);
        db.logEvent(message.guild.id, 'security', message.author.id, 'profanity_blocked', { content: message.content });
        return;
    }

    // --- نظام Anti-Link (روابط دعوة ديسكورد بس، مو كل الروابط) ---
    if (securityCfg.antilink_enabled && DISCORD_INVITE_REGEX.test(message.content)) {
        // الأدمن معفى من الفلتر عشان يقدر يشارك روابط دعوة لو احتاج
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await message.delete().catch(() => null);
            const warnMsg = await message.channel.send(`⚠️ ${message.author}، ما يُسمح بمشاركة روابط دعوة سيرفرات ثانية هنا.`).catch(() => null);
            if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => null), 5000);
            db.logEvent(message.guild.id, 'security', message.author.id, 'invite_link_blocked', { content: message.content });
            return;
        }
    }

    // --- نظام Anti-Spam ---
    if (securityCfg.antispam_enabled) {
        const trackerKey = `${message.guild.id}_${message.author.id}`;
        const now = Date.now();
        const timestamps = (spamTracker.get(trackerKey) || []).filter(t => now - t < SPAM_WINDOW_MS);
        timestamps.push(now);
        spamTracker.set(trackerKey, timestamps);

        if (timestamps.length > SPAM_MAX_MESSAGES) {
            await message.delete().catch(() => null);

            const member = message.member;
            if (member && member.moderatable && !member.permissions.has(PermissionFlagsBits.Administrator)) {
                await member.timeout(SPAM_TIMEOUT_MS, 'سبام تلقائي — تجاوز الحد المسموح من الرسائل').catch(() => null);
            }

            spamTracker.delete(trackerKey); // نصفّي السجل عشان ما يتكرر الإسكات كل رسالة زايدة
            db.logEvent(message.guild.id, 'security', message.author.id, 'spam_detected_timeout', { messageCount: timestamps.length });
            return;
        }
    }

    if (message.content.startsWith(PREFIX)) {
        const args = message.content.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        const gameCfg = db.getConfig(message.guild.id);
        const targetChannel = message.guild.channels.cache.get(gameCfg.game_channel_id);

        if (!targetChannel) {
            // نتجاهل بهدوء لو الأمر مو من أوامر الألعاب أصلاً (عشان ما نرد بخطأ على أي "!" عادي)
            const gameCommands = ['مسابقة', 'مسابقه', 'علم', 'رقم', 'كلمة', 'توب', 'نقاط'];
            if (gameCommands.includes(command)) {
                return message.reply('❌ ما فيه قناة ألعاب محددة بعد. اطلب من الأدمن يحددها بأمر `/setgamechannel`.');
            }
            return;
        }

        if (command === 'مسابقة' || command === 'مسابقه') {
            if (activeGames.has(targetChannel.id)) {
                return message.reply(`❌ فيه جولة شغالة الحين في قناة ${targetChannel}، انتظرها تخلص!`);
            }

            activeGames.add(targetChannel.id);
            const randomQA = getRandomQuestion();
            
            await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });

            await targetChannel.send({ 
                content: `📊 **سؤال جديد للجميع:**\n${randomQA.q}`
            });
            message.reply(`✅ تم بدء المسابقة بنجاح في القناة المخصصة: ${targetChannel}`);

            const filterGame = m => !m.author.bot;
            const collector = targetChannel.createMessageCollector({ filter: filterGame, time: 30000 });
            let answered = false;

            collector.on('collect', async m => {
                if (normalizeText(m.content) === normalizeText(randomQA.a)) {
                    answered = true;
                    const userId = m.author.id;
                    const vipMult = getVipMultiplier(m.member);
                    const finalPoints = Math.round(10 * vipMult);
                    const newTotal = db.addPoints(message.guild.id, userId, finalPoints);

                    const vipNote = vipMult > 1 ? ` (شامل مضاعف VIP ×${vipMult})` : '';
                    await targetChannel.send(`🎉 كفو ${m.author}! إجابتك صحيحة وحصلت على ${finalPoints} نقطة${vipNote} (المجموع: ${newTotal}) و 150 XP إضافي!`);
                    
                    const cfg = db.getConfig(message.guild.id);
                    const notifyChan = message.guild.channels.cache.get(cfg.leveling_channel_id) || targetChannel;
                    await addXP(userId, message.guild, 150, notifyChan);

                    collector.stop();
                }
            });

            collector.on('end', async () => {
                activeGames.delete(targetChannel.id);
                if (!answered) {
                    await targetChannel.send(`⏱️ انتهى الوقت! الإجابة الصحيحة هي: **${randomQA.a}**`);
                }
                await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
            });
            return;
        }

        if (command === 'علم') {
            if (activeGames.has(targetChannel.id)) {
                return message.reply(`❌ فيه جولة شغالة الحين في قناة ${targetChannel}، انتظرها تخلص!`);
            }

            activeGames.add(targetChannel.id);
            const randomFlag = getRandomFlag();
            
            await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });

            const embedFlag = new EmbedBuilder()
                .setTitle("🌍 **خمن علم أي دولة هذا؟**")
                .setDescription("يمكنك الإجابة باللغة **العربية** أو **الإنجليزية**! 🇸🇦🇬🇧")
                .setImage(randomFlag.image)
                .setColor("#00AE86")
                .setFooter({ text: "معكم 30 ثانية للإجابة" });

            await targetChannel.send({ 
                embeds: [embedFlag]
            });
            message.reply(`✅ تم بدء فعالية العلم بنجاح في القناة المخصصة: ${targetChannel}`);

            const filterGame = m => !m.author.bot;
            const collector = targetChannel.createMessageCollector({ filter: filterGame, time: 30000 });
            let answered = false;

            collector.on('collect', async m => {
                if (checkFlagAnswer(m.content, randomFlag)) {
                    answered = true;
                    const userId = m.author.id;
                    const vipMult = getVipMultiplier(m.member);
                    const finalPoints = Math.round(10 * vipMult);
                    const newTotal = db.addPoints(message.guild.id, userId, finalPoints);

                    const vipNote = vipMult > 1 ? ` (شامل مضاعف VIP ×${vipMult})` : '';
                    await targetChannel.send(`🎉 كفو ${m.author}! عرفت العلم الصحيح وهو **${randomFlag.a} / ${randomFlag.en.toUpperCase()}** وأخذت ${finalPoints} نقطة${vipNote} (المجموع: ${newTotal}) و 150 XP!`);
                    
                    const cfg = db.getConfig(message.guild.id);
                    const notifyChan = message.guild.channels.cache.get(cfg.leveling_channel_id) || targetChannel;
                    await addXP(userId, message.guild, 150, notifyChan);

                    collector.stop();
                }
            });

            collector.on('end', async () => {
                activeGames.delete(targetChannel.id);
                if (!answered) {
                    await targetChannel.send(`⏱️ انتهى الوقت! هذا علم دولة: **${randomFlag.a} (${randomFlag.en.toUpperCase()})**`);
                }
                await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
            });
            return;
        }

        if (command === 'رقم') {
            if (activeGames.has(targetChannel.id)) {
                return message.reply(`❌ فيه جولة شغالة الحين في قناة ${targetChannel}، انتظرها تخلص!`);
            }

            activeGames.add(targetChannel.id);
            const secretNumber = Math.floor(Math.random() * 100) + 1;
            let attempts = 0;
            const maxAttempts = 15;

            await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });

            await targetChannel.send({
                content: `🔢 **لعبة تخمين الرقم بدأت!**\nخمّن رقم بين **1** و **100**، عندكم ${maxAttempts} محاولة بالمجموع (30 ثانية).`
            });
            message.reply(`✅ تم بدء لعبة تخمين الرقم بنجاح في القناة المخصصة: ${targetChannel}`);

            const filterGame = m => !m.author.bot && /^\d+$/.test(m.content.trim());
            const collector = targetChannel.createMessageCollector({ filter: filterGame, time: 30000, max: maxAttempts });
            let won = false;

            collector.on('collect', async m => {
                attempts++;
                const guess = parseInt(m.content.trim());

                if (guess === secretNumber) {
                    won = true;
                    const userId = m.author.id;
                    const vipMult = getVipMultiplier(m.member);
                    const finalPoints = Math.round(15 * vipMult);
                    const newTotal = db.addPoints(message.guild.id, userId, finalPoints);

                    const vipNote = vipMult > 1 ? ` (شامل مضاعف VIP ×${vipMult})` : '';
                    await targetChannel.send(`🎉 كفو ${m.author}! الرقم الصحيح هو **${secretNumber}** — أخذت ${finalPoints} نقطة${vipNote} (المجموع: ${newTotal}) و 150 XP!`);

                    const cfg = db.getConfig(message.guild.id);
                    const notifyChan = message.guild.channels.cache.get(cfg.leveling_channel_id) || targetChannel;
                    await addXP(userId, message.guild, 150, notifyChan);

                    collector.stop();
                } else if (guess < secretNumber) {
                    await m.react('🔼').catch(() => null);
                } else {
                    await m.react('🔽').catch(() => null);
                }
            });

            collector.on('end', async () => {
                activeGames.delete(targetChannel.id);
                if (!won) {
                    await targetChannel.send(`⏱️ انتهت المحاولات! الرقم الصحيح كان: **${secretNumber}**`);
                }
                await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
            });
            return;
        }

        if (command === 'كلمة') {
            if (activeGames.has(targetChannel.id)) {
                return message.reply(`❌ فيه جولة شغالة الحين في قناة ${targetChannel}، انتظرها تخلص!`);
            }

            activeGames.add(targetChannel.id);
            const word = getRandomWord();
            const scrambled = shuffleWord(word);

            await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });

            await targetChannel.send({
                content: `🔤 **رتّب الحروف!**\nالكلمة المبعثرة: \`${scrambled}\`\nعندكم 30 ثانية!`
            });
            message.reply(`✅ تم بدء لعبة امزح الكلمة بنجاح في القناة المخصصة: ${targetChannel}`);

            const filterGame = m => !m.author.bot;
            const collector = targetChannel.createMessageCollector({ filter: filterGame, time: 30000 });
            let answered = false;

            collector.on('collect', async m => {
                if (normalizeText(m.content) === normalizeText(word)) {
                    answered = true;
                    const userId = m.author.id;
                    const vipMult = getVipMultiplier(m.member);
                    const finalPoints = Math.round(15 * vipMult);
                    const newTotal = db.addPoints(message.guild.id, userId, finalPoints);

                    const vipNote = vipMult > 1 ? ` (شامل مضاعف VIP ×${vipMult})` : '';
                    await targetChannel.send(`🎉 كفو ${m.author}! الكلمة الصحيحة هي **${word}** — أخذت ${finalPoints} نقطة${vipNote} (المجموع: ${newTotal}) و 150 XP!`);

                    const cfg = db.getConfig(message.guild.id);
                    const notifyChan = message.guild.channels.cache.get(cfg.leveling_channel_id) || targetChannel;
                    await addXP(userId, message.guild, 150, notifyChan);

                    collector.stop();
                }
            });

            collector.on('end', async () => {
                activeGames.delete(targetChannel.id);
                if (!answered) {
                    await targetChannel.send(`⏱️ انتهى الوقت! الكلمة الصحيحة كانت: **${word}**`);
                }
                await targetChannel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
            });
            return;
        }

        if (command === 'توب' || command === 'نقاط') {
            const statsChannel = message.guild.channels.cache.get(gameCfg.stats_channel_id) || targetChannel;

            const sorted = db.getPointsLeaderboard(message.guild.id, 10);

            if (sorted.length === 0) {
                return message.reply("📋 القائمة فارغة حالياً، ما فيه أحد عنده نقاط!");
            }

            const embed = new EmbedBuilder()
                .setTitle('🏆 لوحة صدارة فعاليات سيرفر MMR 🏆')
                .setDescription('هنا يتم تحديث متصدرين النقاط للفعاليات بشكل تلقائي ومستمر!')
                .setColor('#FFD700')
                .setTimestamp();

            for (let i = 0; i < sorted.length; i++) {
                try {
                    const user = await client.users.fetch(sorted[i].user_id);
                    embed.addFields({ name: `#${i + 1} ${user.username}`, value: `نقاطه: **${sorted[i].points}** نقطة`, inline: false });
                } catch (err) {
                    embed.addFields({ name: `#${i + 1} مستخدم غادر`, value: `نقاطه: **${sorted[i].points}** نقطة`, inline: false });
                }
            }

            await statsChannel.send({ embeds: [embed] });
            message.reply(`✅ تم تحديث وإرسال قائمة النقاط بنجاح في القناة المخصصة: ${statsChannel}`);
            return;
        }
    }

    const userId = message.author.id;
    const xpToAdd = Math.floor(Math.random() * 11) + 15; 

    const cfg = db.getConfig(message.guild.id);
    const notificationChannel = message.guild.channels.cache.get(cfg.leveling_channel_id) || message.channel;

    await addXP(userId, message.guild, xpToAdd, notificationChannel);
});

// ================= [ نظام الترحيب بالأعضاء الجدد ] =================
client.on('guildMemberAdd', async member => {
    try {
        const cfg = db.getConfig(member.guild.id);
        if (!cfg.welcome_enabled) return; // الأدمن قدر يقفل الترحيب لو حاب

        // نحدد قناة الترحيب: اللي حددها الأدمن بـ /setwelcomechannel، وإلا نتجاهل بهدوء
        const welcomeChannel = member.guild.channels.cache.get(cfg.welcome_channel_id);
        if (!welcomeChannel) return;

        // نبحث عن قناة القوانين بالاسم المحدد فقط (📜│rules) عشان نمنشنها بالترحيب لو موجودة
        const rulesChannel = member.guild.channels.cache.find(c => c.name === '📜│rules');

        const memberNumber = member.guild.memberCount;

        let description =
            `أهلاً وسهلاً فيك <@${member.id}>! 👋\n\n` +
            `**عضو رقم:** \`${memberNumber}\`\n`;

        if (rulesChannel) {
            description += `**راجع القوانين قبل لا تبدأ:** ${rulesChannel}\n`;
        }

        description += `\nاستمتع بوقتك بالسيرفر واستكشف القنوات — نتمنى لك تواجد حلو معنا! ✨`;

        const welcomeEmbed = new EmbedBuilder()
            .setAuthor({ name: `${member.guild.name}`, iconURL: member.guild.iconURL({ dynamic: true }) || undefined })
            .setTitle('🎉 عضو جديد انضم للسيرفر')
            .setDescription(description)
            .setColor('#E4B343')
            .setFooter({ text: `MMR Welcome System • ${member.guild.name}` })
            .setTimestamp();

        // نولّد بطاقة الترحيب المصورة (صورة العضو مركّبة داخل القالب) ونرفقها بالـ embed
        try {
            const cardBuffer = await generateWelcomeCard(member);
            const attachment = new AttachmentBuilder(cardBuffer, { name: 'welcome-card.png' });
            welcomeEmbed.setImage('attachment://welcome-card.png');
            await welcomeChannel.send({ embeds: [welcomeEmbed], files: [attachment] }).catch(() => null);
        } catch (cardErr) {
            // لو فشل توليد الصورة لأي سبب (مثلاً القالب مفقود)، نرسل الترحيب بدون صورة بدل ما نفشل بالكامل
            console.error('❌ [Welcome] فشل توليد بطاقة الترحيب:', cardErr);
            welcomeEmbed.setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }));
            await welcomeChannel.send({ embeds: [welcomeEmbed] }).catch(() => null);
        }

        db.logEvent(member.guild.id, 'system', null, 'member_welcomed', { userId: member.id, memberNumber });
    } catch (err) {
        console.error('❌ [Welcome] خطأ أثناء إرسال رسالة الترحيب:', err);
        db.logEvent(member.guild.id, 'error', null, 'welcome_system_error', { message: err.message });
    }
});

// ================= [ نظام الوداع بالأعضاء المغادرين ] =================
// رسالة بسيطة بدون صور — بس اسم العضو وعدد الأعضاء الحالي بعد خروجه
client.on('guildMemberRemove', async member => {
    try {
        const cfg = db.getConfig(member.guild.id);
        if (!cfg.goodbye_enabled) return;

        const goodbyeChannel = member.guild.channels.cache.get(cfg.goodbye_channel_id);
        if (!goodbyeChannel) return;

        const goodbyeEmbed = new EmbedBuilder()
            .setDescription(`👋 وداعاً **${member.user.username}**!\nعدد الأعضاء الحالي: \`${member.guild.memberCount}\``)
            .setColor('#8B93A8');

        await goodbyeChannel.send({ embeds: [goodbyeEmbed] }).catch(() => null);

        db.logEvent(member.guild.id, 'system', null, 'member_left', { userId: member.id, memberCount: member.guild.memberCount });
    } catch (err) {
        console.error('❌ [Goodbye] خطأ أثناء إرسال رسالة الوداع:', err);
        db.logEvent(member.guild.id, 'error', null, 'goodbye_system_error', { message: err.message });
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'setchannel') {
            const selectedChan = options.getChannel('channel');
            
            if (selectedChan.type !== ChannelType.GuildText) { 
                return interaction.reply({ content: '❌ يرجى اختيار قناة نصية صالحة!', ephemeral: true });
            }

            db.setLevelingChannel(interaction.guildId, selectedChan.id);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setchannel', { channelId: selectedChan.id });

            const successEmbed = new EmbedBuilder()
                .setTitle('✅ تم إعداد قناة الترقية')
                .setDescription(`تم ربط نظام الليفلات وتحديد إرسال رسائل الترقية بنجاح إلى القناة: ${selectedChan}\n*ملاحظة: الآن سيتم احتساب الـ XP من أي شات، بينما ستُرسل التبريكات هنا فقط!*`)
                .setColor('#248046');

            return interaction.reply({ embeds: [successEmbed], ephemeral: true });
        }

        if (commandName === 'setwelcomechannel') {
            const selectedChan = options.getChannel('channel');

            if (selectedChan.type !== ChannelType.GuildText) {
                return interaction.reply({ content: '❌ يرجى اختيار قناة نصية صالحة!', ephemeral: true });
            }

            db.setWelcomeChannel(interaction.guildId, selectedChan.id);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setwelcomechannel', { channelId: selectedChan.id });

            const welcomeSuccessEmbed = new EmbedBuilder()
                .setTitle('✅ تم إعداد قناة الترحيب')
                .setDescription(`رسائل الترحيب بالأعضاء الجدد بترسل الحين بقناة: ${selectedChan}`)
                .setColor('#248046');

            return interaction.reply({ embeds: [welcomeSuccessEmbed], ephemeral: true });
        }

        if (commandName === 'setgoodbyechannel') {
            const selectedChan = options.getChannel('channel');

            if (selectedChan.type !== ChannelType.GuildText) {
                return interaction.reply({ content: '❌ يرجى اختيار قناة نصية صالحة!', ephemeral: true });
            }

            db.setGoodbyeChannel(interaction.guildId, selectedChan.id);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setgoodbyechannel', { channelId: selectedChan.id });

            const goodbyeSuccessEmbed = new EmbedBuilder()
                .setTitle('✅ تم إعداد قناة الوداع')
                .setDescription(`رسائل الوداع بالأعضاء المغادرين بترسل الحين بقناة: ${selectedChan}`)
                .setColor('#248046');

            return interaction.reply({ embeds: [goodbyeSuccessEmbed], ephemeral: true });
        }

        if (commandName === 'setshopchannel') {
            const selectedChan = options.getChannel('channel');

            if (selectedChan.type !== ChannelType.GuildText) {
                return interaction.reply({ content: '❌ يرجى اختيار قناة نصية صالحة!', ephemeral: true });
            }

            db.setShopChannel(interaction.guildId, selectedChan.id);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setshopchannel', { channelId: selectedChan.id });

            const shopChanSuccessEmbed = new EmbedBuilder()
                .setTitle('✅ تم إعداد قناة المتجر')
                .setDescription(`قناة متجر الـ VIP الحين هي: ${selectedChan}\nاستخدم أمر **/setupshop** عشان تنشر لوحة المتجر فيها.`)
                .setColor('#248046');

            return interaction.reply({ embeds: [shopChanSuccessEmbed], ephemeral: true });
        }

        if (commandName === 'setgamechannel') {
            const selectedChan = options.getChannel('channel');

            if (selectedChan.type !== ChannelType.GuildText) {
                return interaction.reply({ content: '❌ يرجى اختيار قناة نصية صالحة!', ephemeral: true });
            }

            db.setGameChannel(interaction.guildId, selectedChan.id);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setgamechannel', { channelId: selectedChan.id });

            const gameChanSuccessEmbed = new EmbedBuilder()
                .setTitle('✅ تم إعداد قناة الألعاب')
                .setDescription(`الألعاب والمسابقات (!مسابقة، !علم، !رقم، !كلمة) بتشتغل الحين بقناة: ${selectedChan}`)
                .setColor('#248046');

            return interaction.reply({ embeds: [gameChanSuccessEmbed], ephemeral: true });
        }

        if (commandName === 'setstatschannel') {
            const selectedChan = options.getChannel('channel');

            if (selectedChan.type !== ChannelType.GuildText) {
                return interaction.reply({ content: '❌ يرجى اختيار قناة نصية صالحة!', ephemeral: true });
            }

            db.setStatsChannel(interaction.guildId, selectedChan.id);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setstatschannel', { channelId: selectedChan.id });

            const statsChanSuccessEmbed = new EmbedBuilder()
                .setTitle('✅ تم إعداد قناة الصدارة')
                .setDescription(`لوحة صدارة النقاط (!توب) بتُنشر الحين بقناة: ${selectedChan}`)
                .setColor('#248046');

            return interaction.reply({ embeds: [statsChanSuccessEmbed], ephemeral: true });
        }

        if (commandName === 'setupshop') {
            const cfg = db.getConfig(interaction.guildId);
            const shopChannel = interaction.guild.channels.cache.get(cfg.shop_channel_id);

            if (!shopChannel) {
                return interaction.reply({ content: '❌ حدد قناة المتجر أول بأمر /setshopchannel', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            // نتأكد الرتب موجودة قبل ما ننشر اللوحة
            await ensureVipRoles(interaction.guild);

            const panel = buildShopPanel();
            await shopChannel.send(panel);

            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setupshop', { channelId: shopChannel.id });

            return interaction.editReply({ content: `✅ تم نشر لوحة المتجر بقناة: ${shopChannel}` });
        }

        if (commandName === 'security') {
            const feature = options.getString('feature');
            const enabled = options.getBoolean('enabled');

            db.setSecurityFeature(interaction.guildId, feature, enabled);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'security_toggle', { feature, enabled });

            const featureLabels = {
                antispam: 'مكافحة السبام',
                antilink: 'حظر روابط الدعوة',
                profanity_filter: 'فلتر السب',
                welcome: 'رسائل الترحيب',
                goodbye: 'رسائل الوداع'
            };

            const securityEmbed = new EmbedBuilder()
                .setTitle(enabled ? '✅ تم التفعيل' : '⏸️ تم التعطيل')
                .setDescription(`نظام **${featureLabels[feature]}** الحين ${enabled ? 'مفعّل' : 'معطّل'}.`)
                .setColor(enabled ? '#248046' : '#8B93A8');

            return interaction.reply({ embeds: [securityEmbed], ephemeral: true });
        }

        if (commandName === 'setlevel') {
            const targetUser = options.getUser('user');
            const newLevel = options.getInteger('level');

            if (newLevel < 0) {
                return interaction.reply({ content: '❌ لا يمكنك إدخال مستوى أقل من 0!', ephemeral: true });
            }

            db.setUserLevel(interaction.guildId, targetUser.id, 0, newLevel);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'setlevel', { targetUserId: targetUser.id, newLevel });

            const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            if (member && newLevel <= 100 && newLevel > 0) {
                const roleName = `ⲯ︰︲𐑖#${newLevel}︲lvl`;
                try {
                    const oldLevelRoles = member.roles.cache.filter(r => r.name.startsWith('ⲯ︰︲𐑖#') && r.name.endsWith('︲lvl'));
                    if (oldLevelRoles.size > 0) await member.roles.remove(oldLevelRoles).catch(() => null);

                    let levelRole = interaction.guild.roles.cache.find(r => r.name === roleName);
                    if (!levelRole) {
                        levelRole = await interaction.guild.roles.create({
                            name: roleName,
                            color: '#2b2d31',
                            reason: `Manual Admin Level Override`
                        }).catch(() => null);
                    }
                    if (levelRole) await member.roles.add(levelRole).catch(() => null);
                } catch(e) { console.error(e); }
            }

            return interaction.reply({ 
                content: `✅ تم تعديل مستوى العضو ${targetUser} يدوياً بنجاح إلى **المستوى ${newLevel}**!`, 
                ephemeral: true 
            });
        }

        if (commandName === 'gcreate') {
            const prize = options.getString('prize');
            const durationStr = options.getString('duration');
            const winnerCount = options.getInteger('winners');
            const targetChannel = options.getChannel('channel') || interaction.channel;
            const host = options.getUser('host') || interaction.user;
            const imageAttachment = options.getAttachment('image');
            const thumbnailAttachment = options.getAttachment('thumbnail');
            const imageUrl = imageAttachment ? imageAttachment.url : null;
            const thumbnailUrl = thumbnailAttachment ? thumbnailAttachment.url : null;
            const color = options.getString('color');
            const endColor = options.getString('end-color');
            const createMessage = options.getString('giveaway-create-message');
            const dmMessage = options.getString('giveaway-winners-dm-message');
            const requiredRole = options.getRole('required-role');
            const bypassRole = options.getRole('requirement-bypass-role');
            const winnerRole = options.getRole('giveaway-winners-role');
            const accountAgeStr = options.getString('required-account-age');
            const boosterMultiplier = options.getInteger('booster-multiplier') || 1;
            const requiredServerId = options.getString('required-server-id');
            const sponsorText = options.getString('sponsor-text');
            const platform = options.getString('platform');

            let duration;
            try { duration = ms(durationStr); } catch (e) { duration = null; }
            if (!duration) return interaction.reply({ content: '❌ Invalid duration format!', ephemeral: true });

            await interaction.deferReply({ ephemeral: true });
            const endTime = Date.now() + duration;

            try {
                const message = await targetChannel.send({
                    content: createMessage ? createMessage : '📢 **A new giveaway has started!**',
                    embeds: [new EmbedBuilder().setDescription('Initializing giveaway...')],
                    components: []
                });

                const giveawayData = {
                    messageId: message.id,
                    guildId: interaction.guildId,
                    channelId: targetChannel.id,
                    hostId: host.id,
                    prize,
                    winnerCount,
                    imageUrl,
                    thumbnailUrl,
                    color,
                    endColor,
                    dmMessage,
                    requiredRoleId: requiredRole?.id,
                    bypassRoleId: bypassRole?.id,
                    winnerRoleId: winnerRole?.id,
                    accountAgeStr,
                    requiredServerId,
                    boosterMultiplier,
                    endTime,
                    sponsorText,
                    platform,
                    ended: false,
                    entries: new Set(),
                    fakeCount: 0,
                    forcedWinnerId: null
                };

                giveaways.set(message.id, giveawayData);
                persistGiveaway(giveawayData);
                db.logEvent(interaction.guildId, 'giveaway', interaction.user.id, 'gcreate', { messageId: message.id, prize, winnerCount, durationStr });
                await message.edit(createGiveawayEmbed(giveawayData));
                await interaction.editReply({ content: `✅ Giveaway launched successfully in channel: ${targetChannel}` });

                setTimeout(() => endGiveaway(message.id, targetChannel.id), duration);
            } catch (err) {
                console.error(err);
                await interaction.editReply({ content: '❌ An unexpected error occurred.' });
            }
        }

        if (commandName === 'gaddfake') {
            const messageId = options.getString('message_id');
            const amount = options.getInteger('amount');
            const giveawayData = giveaways.get(messageId);

            if (!giveawayData) return interaction.reply({ content: '❌ Giveaway not found in session memory.', ephemeral: true });
            if (giveawayData.ended) return interaction.reply({ content: '❌ This giveaway has already concluded.', ephemeral: true });

            giveawayData.fakeCount += amount;
            persistGiveaway(giveawayData);
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'gaddfake', { messageId, amount });

            const channel = client.channels.cache.get(giveawayData.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(messageId).catch(() => null);
                if (msg) await msg.edit(createGiveawayEmbed(giveawayData));
            }

            return interaction.reply({ content: `✅ Successfully injected \`${amount}\` fake entries into giveaway ID: \`${messageId}\`.`, ephemeral: true });
        }

        if (commandName === 'gadmin') {
            const messageId = options.getString('message_id');
            const giveawayData = giveaways.get(messageId);
            if (!giveawayData) return interaction.reply({ content: '❌ Giveaway not found.', ephemeral: true });

            const adminEmbed = new EmbedBuilder()
                .setTitle(`🛠️ **Admin Panel | MMR Giveaway**`)
                .setDescription(`🎁 **Prize:** \`${giveawayData.prize}\`\n📊 **Real Entries:** \`${giveawayData.entries.size}\`\n👥 **Fake Entries:** \`${giveawayData.fakeCount}\` \n⏳ **Status:** ${giveawayData.ended ? '🔴 Ended' : '🟢 Active'}`)
                .setColor('#2b2d31')
                .setFooter({ text: `MMR Giveaway ADMIN` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`gadmin_end_${messageId}`).setLabel('End Immediately').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`gadmin_pickwinner_${messageId}`).setLabel('Set Winner Manually 👑').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`gadmin_reroll_${messageId}`).setLabel('Reroll Giveaway').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`gadmin_cancel_${messageId}`).setLabel('Cancel Giveaway').setStyle(ButtonStyle.Danger)
            );
            await interaction.reply({ embeds: [adminEmbed], components: [row], ephemeral: true });
        }

        if (commandName === 'gstats') {
            let activeCount = 0;
            let totalReal = 0;
            let totalFake = 0;

            giveaways.forEach(g => {
                if (!g.ended) {
                    activeCount++;
                    totalReal += g.entries.size;
                    totalFake += g.fakeCount;
                }
            });

            const statsEmbed = new EmbedBuilder()
                .setTitle('📊 **MMR Giveaway Live Stats**')
                .setDescription(
                    `🟢 **Active Giveaways:** \`${activeCount}\`\n` +
                    `👥 **Total Real Users:** \`${totalReal}\`\n` +
                    `🤖 **Total Fake Entries:** \`${totalFake}\`\n` +
                    `🛡️ **System Status:** \`LIVE / SECURE\``
                )
                .setColor('#2b2d31')
                .setFooter({ text: 'MMR Giveaway' });

            return interaction.reply({ embeds: [statsEmbed], ephemeral: true });
        }

        if (commandName === 'rank') {
            const targetUser = options.getUser('user') || interaction.user;
            const userData = db.getUserLevel(interaction.guildId, targetUser.id);
            const xpNeeded = getRequiredXP(userData.level);

            const rankEmbed = new EmbedBuilder()
                .setAuthor({ name: targetUser.tag, iconURL: targetUser.displayAvatarURL({ dynamic: true }) })
                .setTitle('📊 **MMR User Rank Stats**')
                .setDescription(
                    `⭐ **MMR Level:** \`${userData.level}\`\n` +
                    `✨ **Current XP:** \`${userData.xp} / ${xpNeeded}\`\n` +
                    `🎟️ **Giveaway Tickets:** \`${1 + userData.level}\` entries`
                )
                .setColor('#2b2d31')
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: 'MMR Leveling System' });

            return interaction.reply({ embeds: [rankEmbed] });
        }

        if (commandName === 'يومي') {
            const status = db.getDailyStatus(interaction.guildId, interaction.user.id);

            if (!status.canClaim) {
                const hoursLeft = Math.ceil(status.msRemaining / (60 * 60 * 1000));
                return interaction.reply({
                    content: `⏳ خذيت مكافأتك اليوم! رجعلي بعد حوالي **${hoursLeft} ساعة**. سلسلتك الحالية: **${status.streak}** يوم متواصل.`,
                    ephemeral: true
                });
            }

            const vipMult = getVipMultiplier(interaction.member);
            const baseDailyAmount = Math.round(50 * vipMult);
            const result = db.claimDaily(interaction.guildId, interaction.user.id, baseDailyAmount);
            db.logEvent(interaction.guildId, 'game', interaction.user.id, 'daily_claim', result);

            const vipNote = vipMult > 1 ? `\n💎 مضاعف VIP نشط: ×${vipMult}` : '';
            const dailyEmbed = new EmbedBuilder()
                .setTitle('🎁 **المكافأة اليومية**')
                .setDescription(
                    `✅ استلمت **${result.amount}** نقطة!${vipNote}\n` +
                    `🔥 سلسلتك الحالية: **${result.streak}** يوم متواصل\n` +
                    `💰 مجموع نقاطك الآن: **${result.newTotalPoints}**\n\n` +
                    `*ارجع بكرة عشان تحافظ على سلسلتك وتاخذ مكافأة أكبر!*`
                )
                .setColor('#FFD700')
                .setFooter({ text: 'MMR Daily Reward' });

            return interaction.reply({ embeds: [dailyEmbed] });
        }
    }

    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const action = parts[0];

        if (action === 'shopbuy') {
            const tierKey = parts[1];
            const tier = VIP_TIERS[tierKey];
            if (!tier) return interaction.reply({ content: '❌ رتبة غير معروفة.', ephemeral: true });

            await interaction.deferReply({ ephemeral: true });

            if (db.hasVipTier(interaction.guildId, interaction.user.id, tierKey)) {
                return interaction.editReply({ content: `⚠️ عندك رتبة **${tier.name}** أصلاً!` });
            }

            const currentPoints = db.getPoints(interaction.guildId, interaction.user.id);
            if (currentPoints < tier.price) {
                const missing = tier.price - currentPoints;
                return interaction.editReply({
                    content: `❌ نقاطك ما تكفي! تحتاج **${missing.toLocaleString('en-US')}** نقطة إضافية للوصول لسعر **${tier.name}** (${tier.price.toLocaleString('en-US')} نقطة).\nرصيدك الحالي: **${currentPoints.toLocaleString('en-US')}** نقطة.`
                });
            }

            // نخصم السعر (رقم سالب) ونسجل الشراء ونعطي الرتبة
            db.addPoints(interaction.guildId, interaction.user.id, -tier.price);
            db.recordVipPurchase(interaction.guildId, interaction.user.id, tierKey);

            const vipRoles = await ensureVipRoles(interaction.guild);
            const role = vipRoles[tierKey];
            if (role) {
                await interaction.member.roles.add(role).catch(() => null);
            }

            db.logEvent(interaction.guildId, 'shop', interaction.user.id, 'vip_purchase', { tierKey, price: tier.price });

            const confirmEmbed = new EmbedBuilder()
                .setTitle(`${tier.emoji} مبروك رتبة ${tier.name}!`)
                .setDescription(`تم خصم **${tier.price.toLocaleString('en-US')}** نقطة، ورصيدك الحالي: **${(currentPoints - tier.price).toLocaleString('en-US')}** نقطة.\n\nمزاياك الجديدة:\n${tier.perks.map(p => `• ${p}`).join('\n')}`)
                .setColor(tier.color);

            return interaction.editReply({ embeds: [confirmEmbed] });
        }

        if (action === 'giveaway') {
            const subAction = parts[1];
            const messageId = parts[2];
            const giveawayData = giveaways.get(messageId);

            if (!giveawayData) return interaction.reply({ content: '❌ Data unavailable.', ephemeral: true });

            if (subAction === 'list') {
                await interaction.deferReply({ ephemeral: true });
                const response = await renderParticipantsText(interaction, giveawayData, 0);
                return interaction.editReply(response);
            }

            if (subAction === 'sponsor') {
                return interaction.reply({ content: `🤝 **Sponsor Message:**\n${giveawayData.sponsorText}`, ephemeral: true });
            }

            if (subAction === 'entry') {
                if (giveawayData.ended) return interaction.reply({ content: '❌ Sorry, this giveaway has already concluded.', ephemeral: true });
                
                const member = interaction.member;
                const hasBypass = giveawayData.bypassRoleId && member.roles.cache.has(giveawayData.bypassRoleId);

                if (!hasBypass) {
                    if (giveawayData.requiredRoleId && !member.roles.cache.has(giveawayData.requiredRoleId)) {
                        return interaction.reply({ content: `❌ Requirement missing! You need the <@&${giveawayData.requiredRoleId}> role.`, ephemeral: true });
                    }
                    if (giveawayData.accountAgeStr) {
                        let requiredAgeMs;
                        try { requiredAgeMs = ms(giveawayData.accountAgeStr); } catch(e) { requiredAgeMs = null; }
                        if (requiredAgeMs) {
                            const accountAge = Date.now() - interaction.user.createdTimestamp;
                            if (accountAge < requiredAgeMs) return interaction.reply({ content: `❌ Account age too new.`, ephemeral: true });
                        }
                    }
                    if (giveawayData.requiredServerId) {
                        const targetGuild = client.guilds.cache.get(giveawayData.requiredServerId);
                        if (targetGuild) {
                            const isMemberInTarget = await targetGuild.members.fetch(interaction.user.id).catch(() => null);
                            if (!isMemberInTarget) return interaction.reply({ content: `❌ Please join our partner server first.`, ephemeral: true });
                        }
                    }
                }

                if (giveawayData.entries.has(interaction.user.id)) {
                    return interaction.reply({ content: '⚠️ You are already in this giveaway!', ephemeral: true });
                }

                giveawayData.entries.add(interaction.user.id);
                persistGiveaway(giveawayData);
                
                const userLevelData = db.getUserLevel(interaction.guild.id, interaction.user.id);
                const userTickets = 1 + userLevelData.level;

                let msg = `✅ Successfully entered! (Your Level: \`${userLevelData.level}\` = **${userTickets}** entries registered!)`;
                if (member.premiumSince && giveawayData.boosterMultiplier > 1) msg = `✅ Premium entry registered with Level bonus (${userTickets * giveawayData.boosterMultiplier}x total chances)!`;
                
                await interaction.reply({ content: msg, ephemeral: true });
                
                const channel = client.channels.cache.get(giveawayData.channelId);
                if (channel) {
                    const msgObj = await channel.messages.fetch(messageId).catch(() => null);
                    if (msgObj) await msgObj.edit(createGiveawayEmbed(giveawayData));
                }
            }

            if (subAction === 'leave') {
                if (giveawayData.ended) return interaction.reply({ content: '❌ Giveaway ended.', ephemeral: true });
                if (!giveawayData.entries.has(interaction.user.id)) return interaction.reply({ content: '❌ You are not registered in this giveaway.', ephemeral: true });

                giveawayData.entries.delete(interaction.user.id);
                persistGiveaway(giveawayData);
                await interaction.reply({ content: '🗑️ You have successfully left the giveaway.', ephemeral: true });

                const channel = client.channels.cache.get(giveawayData.channelId);
                if (channel) {
                    const msgObj = await channel.messages.fetch(messageId).catch(() => null);
                    if (msgObj) await msgObj.edit(createGiveawayEmbed(giveawayData));
                }
            }
        }

        if (action === 'gpage') {
            const subAction = parts[1];
            const messageId = parts[2];
            let currentPage = parseInt(parts[3]);
            const giveawayData = giveaways.get(messageId);

            if (!giveawayData) return interaction.reply({ content: '❌ Data unavailable.', ephemeral: true });

            if (subAction === 'prev') {
                const response = await renderParticipantsText(interaction, giveawayData, currentPage - 1);
                return interaction.update(response);
            }
            if (subAction === 'next') {
                const response = await renderParticipantsText(interaction, giveawayData, currentPage + 1);
                return interaction.update(response);
            }
            if (subAction === 'goto') {
                const modal = new ModalBuilder().setCustomId(`gpage_gotomodal_${messageId}`).setTitle('Go To Page');
                const pageInput = new TextInputBuilder().setCustomId('pageNumberInput').setLabel('Page Number').setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(pageInput));
                await interaction.showModal(modal);
            }
        }

        if (action === 'gadmin') {
            const subAction = parts[1];
            const messageId = parts[2];
            let giveawayData = giveaways.get(messageId);

            if (!giveawayData) return interaction.reply({ content: '❌ Memory cleared.', ephemeral: true });
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                db.logEvent(interaction.guildId, 'security', interaction.user.id, 'unauthorized gadmin attempt', { messageId, subAction });
                return interaction.reply({ content: '❌ Access Denied.', ephemeral: true });
            }

            if (subAction === 'end') {
                await endGiveaway(messageId, giveawayData.channelId);
                db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'gadmin_end', { messageId });
                await interaction.reply({ content: '✅ Concluded.', ephemeral: true });
            }
            if (subAction === 'pickwinner') {
                const modal = new ModalBuilder().setCustomId(`gadmin_pickmodal_${messageId}`).setTitle('Set Manual Winner 👑');
                const winnerInput = new TextInputBuilder().setCustomId('winnerIdInput').setLabel('User ID').setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(winnerInput));
                await interaction.showModal(modal);
            }
            if (subAction === 'reroll') {
                giveawayData.forcedWinnerId = null;
                giveawayData.ended = false;
                await endGiveaway(messageId, giveawayData.channelId);
                db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'gadmin_reroll', { messageId });
                await interaction.reply({ content: '🔄 Reroll complete.', ephemeral: true });
            }
            if (subAction === 'cancel') {
                giveawayData.ended = true;
                giveaways.delete(messageId);
                db.deleteGiveaway(messageId);
                db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'gadmin_cancel', { messageId });
                await interaction.reply({ content: '✅ Cancelled.', ephemeral: true });
            }
        }
    }

    if (interaction.type === InteractionType.ModalSubmit) {
        if (interaction.customId.startsWith('gpage_gotomodal_')) {
            const messageId = interaction.customId.split('gpage_gotomodal_')[1];
            const giveawayData = giveaways.get(messageId);
            const pageNum = parseInt(interaction.fields.getTextInputValue('pageNumberInput')) - 1;

            if (!giveawayData) return interaction.reply({ content: '❌ Error.', ephemeral: true });
            const response = await renderParticipantsText(interaction, giveawayData, pageNum);
            return interaction.update(response);
        }

        if (interaction.customId.startsWith('gadmin_pickmodal_')) {
            const messageId = interaction.customId.split('gadmin_pickmodal_')[1];
            const giveawayData = giveaways.get(messageId);
            const winnerId = interaction.fields.getTextInputValue('winnerIdInput');
            if (!giveawayData) return interaction.reply({ content: '❌ Error.', ephemeral: true });
            giveawayData.forcedWinnerId = winnerId;
            db.logEvent(interaction.guildId, 'admin', interaction.user.id, 'gadmin_pickwinner', { messageId, forcedWinnerId: winnerId });
            await endGiveaway(messageId, giveawayData.channelId);
            await interaction.reply({ content: `👑 Manual winner set.`, ephemeral: true });
        }
    }
});

client.on('error', (error) => {
    console.error('❌ [Client Error]:', error);
    db.logEvent(null, 'error', null, 'discord.js client error', { message: error.message });
});

client.on('shardError', (error) => {
    console.error('❌ [Shard Error]:', error);
    db.logEvent(null, 'error', null, 'shard connection error', { message: error.message });
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ [Unhandled Rejection]:', reason);
    db.logEvent(null, 'error', null, 'unhandled promise rejection', { message: String(reason) });
});

process.on('uncaughtException', (error) => {
    console.error('❌ [Uncaught Exception]:', error);
    db.logEvent(null, 'error', null, 'uncaught exception', { message: error.message, stack: error.stack });
});

setInterval(() => {
    const removed = db.pruneOldLogs();
    if (removed > 0) console.log(`🧹 [Logs] تم حذف ${removed} سجل قديم (أكثر من 90 يوم).`);
}, 24 * 60 * 60 * 1000);

client.login(config.token);
